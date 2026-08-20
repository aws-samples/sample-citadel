"""Tool-execution ledger — operational exactly-once dedupe (PR1 of 2).

An org-scoped, TTL'd DynamoDB ledger that makes a governed tool call
exactly-once *within an attempt* and safe under a reservation race. It is the
operational backbone of tool-call idempotency; ``arbiter/workerWrapper/
tool_idempotency.py`` derives the keys, this module coordinates the
reserve -> execute -> finalize protocol against them.

Guarantee (state it precisely — do NOT collapse to a bare "exactly-once"):

* **Exactly-once execution of the side effect is a GUARANTEE for calls that
  resolve to the same key** — redelivery, same-attempt SDK/Strands retries,
  and concurrent split-brain with identical keys. The reservation's
  conditional write is what provides it: exactly one caller wins the reserve
  and executes; every other caller is absorbed (recorded result) or bounced
  with a retryable no-execution error, and NEVER executes.
* It is **best-effort across nondeterministic re-dispatch** (different keys),
  which is closed only by the worker ``dispatchGeneration`` fence — DEFERRED
  to PR2 and REQUIRED for the complete guarantee. Nothing here is the complete
  guarantee on its own.
* Concurrent-loser *result delivery* is best-effort (a slow/dead holder may
  yield a retryable error instead of the recorded result); side-effect
  *execution* remains exactly-once.

NOT an audit artifact: TTL is 48h operational (server-write-time based),
distinct from the 90-day ``arbiter/governance/ledger.py`` accountability
record. Do not conflate the two.

Fail-closed: every failure path raises (never a bare ``except: pass``); a
ledger write/read failure must fail the call closed, never fall through to an
unprotected execution.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from arbiter.workerWrapper.tool_idempotency import MODE_BYPASS

logger = logging.getLogger(__name__)

# --- Attribute + status constants -------------------------------------------

PK_ATTR = "pk"           # orgId#executionId
SK_ATTR = "sk"           # nodeId#callIndex#toolName#argsHash

STATUS_IN_FLIGHT = "in_flight"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
# A reservation whose side effect provably did NOT happen is transitioned to
# 'released' (NOT deleted) so the worker IAM grant stays Put/Get/Update only
# (no dynamodb:DeleteItem — least privilege, per the design's IAM scope). A
# released row is re-reservable via a conditional CAS in reserve().
STATUS_RELEASED = "released"

# --- Tunables (env-overridable) ---------------------------------------------

DEFAULT_TTL_SECONDS = 48 * 3600            # 48h operational dedupe window
DEFAULT_MAX_INLINE_BYTES = 300_000         # DDB 400KB item cap, headroom for attrs
DEFAULT_LEASE_SECONDS = 15 * 60            # dead-holder reclaim threshold
DEFAULT_POLL_TIMEOUT_SECONDS = 5.0         # concurrent-loser bounded poll ceiling
DEFAULT_POLL_INTERVAL_SECONDS = 0.1


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def ttl_seconds() -> int:
    return _int_env("TOOL_LEDGER_TTL_SECONDS", DEFAULT_TTL_SECONDS)


def max_inline_bytes() -> int:
    return _int_env("TOOL_RESULT_MAX_INLINE_BYTES", DEFAULT_MAX_INLINE_BYTES)


def lease_seconds() -> int:
    return _int_env("TOOL_LEDGER_LEASE_SECONDS", DEFAULT_LEASE_SECONDS)


# --- Exceptions --------------------------------------------------------------


class LedgerError(Exception):
    """Base for ledger failures. Callers MUST fail the call closed."""


class RetryableNoExecutionError(LedgerError):
    """Concurrent loser (or a released reservation) — no side effect occurred.

    Retryable: a later attempt may re-reserve and execute. The load-bearing
    property is that the raising caller NEVER executed the side effect.
    """

    retryable = True


class OutcomeIndeterminateError(LedgerError):
    """An un-tokened side-effecting call finished with an UNKNOWN outcome.

    Fail-safe toward no-duplicate (security consensus D2): the side effect may
    or may not have applied, and there is no client token to dedupe a retry
    end-to-end, so the call is NEVER auto-re-executed. Non-retryable; surfaced
    upward, never swallowed.
    """

    retryable = False


class RecordedToolFailure(LedgerError):
    """A prior terminal failure for this key, replayed without re-executing."""

    retryable = False

    def __init__(self, message: str, *, recorded: dict[str, Any] | None = None):
        super().__init__(message)
        self.recorded = recorded or {}


class ToolOutcomeError(Exception):
    """Adapter-raised classification of a failed tool call.

    Adapters that can classify their failure raise this so the coordinator
    applies the correct failure-matrix branch:

    * ``side_effect='not_sent'`` + ``retryable=True`` — provably no side
      effect (e.g. connection refused pre-send): reservation released, call
      re-executable.
    * ``side_effect='unknown'`` — outcome ambiguous (5xx/timeout after send):
      fail-safe ``outcomeIndeterminate``, never re-executed.
    * ``side_effect='applied'`` (terminal 4xx/validation): recorded failure,
      non-retryable, returned on replay without re-execution.

    A bare ``Exception`` from the tool (not this type) is treated as
    ``unknown`` — the fail-safe default.
    """

    def __init__(
        self,
        message: str,
        *,
        side_effect: str = "unknown",
        retryable: bool = False,
        error_type: str | None = None,
    ):
        super().__init__(message)
        self.side_effect = side_effect
        self.retryable = retryable
        self.error_type = error_type or self.__class__.__name__


# --- Reserve outcome ---------------------------------------------------------


class ReserveOutcome(Enum):
    WON = "won"                       # caller may execute
    HIT_COMPLETED = "hit_completed"   # recorded success — return it, do NOT execute
    HIT_FAILED = "hit_failed"         # recorded terminal failure — replay, do NOT execute
    IN_FLIGHT = "in_flight"           # concurrent holder alive — poll then retryable error


@dataclass
class ReserveResult:
    outcome: ReserveOutcome
    row: dict[str, Any] | None = None
    reclaimed: bool = False


# --- Lazy boto3 resource (QB-013-1: never construct at import time) ----------

_ddb_resource: Any = None


def _get_dynamodb_resource() -> Any:
    global _ddb_resource
    if _ddb_resource is None:
        _ddb_resource = boto3.resource("dynamodb")
    return _ddb_resource


def _table() -> Any:
    table_name = os.environ.get("TOOL_EXECUTION_LEDGER_TABLE")
    if not table_name:
        raise LedgerError(
            "TOOL_EXECUTION_LEDGER_TABLE not configured — cannot reserve a "
            "tool execution (fail-closed)"
        )
    return _get_dynamodb_resource().Table(table_name)


def __reset_ledger_client_for_test() -> None:
    """Test-only: clear the cached boto3 resource."""
    global _ddb_resource
    _ddb_resource = None


# --- Result preparation (inline only in PR1; S3 offload is PR2) -------------


def _prepare_result(result: Any) -> tuple[Any, bool, str | None]:
    """Return ``(inline_result_json, truncated, marker)`` for a tool result.

    Inline results only in PR1. When the serialized result exceeds
    ``max_inline_bytes`` it is NOT stored inline and is NOT truncated into a
    partial body (a partial replay would be unfaithful); instead we record a
    deterministic content marker (``sha256`` of the canonical JSON) and set
    ``truncated=True``. Faithful large-result replay via S3 offload is PR2 —
    do NOT build it here. A caller that gets a truncated record must treat the
    dedupe hit as "known-completed, body unavailable inline".
    """
    try:
        serialized = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        raise LedgerError(f"tool result is not JSON-serializable: {exc}") from exc
    encoded = serialized.encode("utf-8")
    if len(encoded) > max_inline_bytes():
        marker = hashlib.sha256(encoded).hexdigest()
        return None, True, marker
    return serialized, False, None


# --- Reserve / get / finalize ------------------------------------------------


def get(pk: str, sk: str) -> dict[str, Any] | None:
    """Read the ledger row for a key, or ``None`` if absent."""
    try:
        resp = _table().get_item(Key={PK_ATTR: pk, SK_ATTR: sk})
    except (ClientError, BotoCoreError) as exc:
        raise LedgerError(f"ledger get_item failed for {pk!r}/{sk!r}: {exc}") from exc
    item = resp.get("Item")
    return item if isinstance(item, dict) else None


def _reclaim_stale(pk: str, sk: str, *, seen_created_at: Any, now: float) -> bool:
    """Reclaim a dead holder's ``in_flight`` row via a conditional CAS.

    Conditional on ``(status = in_flight AND createdAt = :seen)`` so exactly
    one reclaimer can win — two concurrent reclaimers cannot both re-reserve
    (the second's ``createdAt`` guard fails). Returns True when this caller
    won the reclaim (and may now execute), False otherwise.
    """
    try:
        _table().update_item(
            Key={PK_ATTR: pk, SK_ATTR: sk},
            UpdateExpression="SET #s = :inflight, createdAt = :now, updatedAt = :now, ttl = :ttl",
            ConditionExpression="#s = :inflight_guard AND createdAt = :seen",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":inflight": STATUS_IN_FLIGHT,
                ":inflight_guard": STATUS_IN_FLIGHT,
                ":seen": seen_created_at,
                ":now": now,
                ":ttl": int(now) + ttl_seconds(),
            },
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise LedgerError(f"ledger reclaim failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger reclaim transport error for {pk!r}/{sk!r}: {exc}") from exc


def _reclaim_released(pk: str, sk: str, *, now: float) -> bool:
    """Re-reserve a ``released`` row via a conditional CAS on the status.

    ``released -> in_flight`` guarded by ``status = released`` so two racing
    re-reservers cannot both win. Returns True when this caller won.
    """
    try:
        _table().update_item(
            Key={PK_ATTR: pk, SK_ATTR: sk},
            UpdateExpression="SET #s = :inflight, createdAt = :now, updatedAt = :now, ttl = :ttl",
            ConditionExpression="#s = :released",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":inflight": STATUS_IN_FLIGHT,
                ":released": STATUS_RELEASED,
                ":now": now,
                ":ttl": int(now) + ttl_seconds(),
            },
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise LedgerError(f"ledger re-reserve failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger re-reserve transport error for {pk!r}/{sk!r}: {exc}") from exc


def reserve(pk: str, sk: str, *, tool_name: str, now: float | None = None) -> ReserveResult:
    """Attempt to reserve a tool execution with a conditional first-write-wins.

    Returns a :class:`ReserveResult`:

    * ``WON`` — this caller holds the reservation and MUST proceed to execute
      then :func:`finalize_success` / :func:`finalize_failure`.
    * ``HIT_COMPLETED`` / ``HIT_FAILED`` — a prior terminal record exists;
      return it, do NOT execute.
    * ``IN_FLIGHT`` — a live concurrent holder; the caller should poll
      (:func:`wait_for_terminal`) then raise :class:`RetryableNoExecutionError`
      without executing. A *stale* in-flight row is reclaimed here (returns
      ``WON`` with ``reclaimed=True``).
    """
    now = time.time() if now is None else now
    item = {
        PK_ATTR: pk,
        SK_ATTR: sk,
        "status": STATUS_IN_FLIGHT,
        "toolName": tool_name,
        "createdAt": now,
        "updatedAt": now,
        # TTL derived from SERVER write-time (not a producer clock), so a
        # skewed/malicious producer cannot force early expiry.
        "ttl": int(now) + ttl_seconds(),
    }
    try:
        _table().put_item(Item=item, ConditionExpression=f"attribute_not_exists({PK_ATTR})")
        return ReserveResult(ReserveOutcome.WON)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise LedgerError(f"ledger reserve failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger reserve transport error for {pk!r}/{sk!r}: {exc}") from exc

    # Reservation exists — resolve its current status.
    row = get(pk, sk)
    if row is None:
        # Vanished between our failed put and this read (TTL/reclaim race);
        # treat as retryable rather than executing unprotected.
        return ReserveResult(ReserveOutcome.IN_FLIGHT)
    status = row.get("status")
    if status == STATUS_COMPLETED:
        return ReserveResult(ReserveOutcome.HIT_COMPLETED, row=row)
    if status == STATUS_FAILED:
        return ReserveResult(ReserveOutcome.HIT_FAILED, row=row)
    if status == STATUS_RELEASED:
        # A prior attempt released the reservation (provably no side effect);
        # re-reserve via conditional CAS so exactly one re-reserver wins.
        if _reclaim_released(pk, sk, now=now):
            return ReserveResult(ReserveOutcome.WON, reclaimed=True)
        return ReserveResult(ReserveOutcome.IN_FLIGHT, row=row)
    # in_flight — reclaim if the holder looks dead, else report live.
    created_at = row.get("createdAt")
    if isinstance(created_at, (int, float)) and (now - float(created_at)) > lease_seconds():
        if _reclaim_stale(pk, sk, seen_created_at=created_at, now=now):
            return ReserveResult(ReserveOutcome.WON, reclaimed=True)
    return ReserveResult(ReserveOutcome.IN_FLIGHT, row=row)


def wait_for_terminal(
    pk: str,
    sk: str,
    *,
    timeout: float | None = None,
    interval: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any] | None:
    """Bounded poll for the in-flight row to reach a terminal status.

    Returns the terminal row (``completed``/``failed``) if it settles within
    the timeout, else ``None`` (the caller then raises
    :class:`RetryableNoExecutionError` and NEVER executes). ``clock``/``sleep``
    are injectable for deterministic tests.
    """
    timeout = _float_env("TOOL_LEDGER_POLL_TIMEOUT_SECONDS", DEFAULT_POLL_TIMEOUT_SECONDS) if timeout is None else timeout
    interval = _float_env("TOOL_LEDGER_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS) if interval is None else interval
    deadline = clock() + timeout
    while True:
        row = get(pk, sk)
        if row is not None and row.get("status") in (STATUS_COMPLETED, STATUS_FAILED):
            return row
        if clock() >= deadline:
            return None
        sleep(interval)


def _finalize(pk: str, sk: str, *, attributes: dict[str, Any], now: float) -> None:
    """Transition an in-flight row to a terminal state (guarded)."""
    names = {"#s": "status"}
    values: dict[str, Any] = {":inflight": STATUS_IN_FLIGHT, ":now": now}
    set_parts = ["#s = :status", "updatedAt = :now"]
    for i, (key, value) in enumerate(attributes.items()):
        placeholder = f":v{i}"
        name_placeholder = f"#a{i}"
        names[name_placeholder] = key
        values[placeholder] = value
        if key == "status":
            values[":status"] = value
        else:
            set_parts.append(f"{name_placeholder} = {placeholder}")
    if ":status" not in values:
        raise LedgerError("_finalize requires a 'status' attribute")
    try:
        _table().update_item(
            Key={PK_ATTR: pk, SK_ATTR: sk},
            UpdateExpression="SET " + ", ".join(set_parts),
            ConditionExpression="#s = :inflight",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "ConditionalCheckFailedException":
            # Already finalized/reclaimed by another actor — benign; the
            # terminal record stands. Do not swallow silently: log it.
            logger.info(
                "tool-ledger finalize no-op (row not in_flight) pk=%s sk=%s", pk, sk
            )
            return
        raise LedgerError(f"ledger finalize failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger finalize transport error for {pk!r}/{sk!r}: {exc}") from exc


def finalize_success(pk: str, sk: str, *, result: Any, now: float | None = None) -> None:
    """Record a successful execution result (in_flight -> completed)."""
    now = time.time() if now is None else now
    inline, truncated, marker = _prepare_result(result)
    attrs: dict[str, Any] = {"status": STATUS_COMPLETED, "resultTruncated": truncated}
    if truncated:
        attrs["resultMarker"] = marker
    else:
        attrs["result"] = inline
    _finalize(pk, sk, attributes=attrs, now=now)


def finalize_failure(
    pk: str,
    sk: str,
    *,
    error_type: str,
    retryable: bool,
    outcome_indeterminate: bool = False,
    now: float | None = None,
) -> None:
    """Record a terminal failure (in_flight -> failed)."""
    now = time.time() if now is None else now
    _finalize(
        pk,
        sk,
        attributes={
            "status": STATUS_FAILED,
            "errorType": error_type,
            "retryable": retryable,
            "outcomeIndeterminate": outcome_indeterminate,
        },
        now=now,
    )


def release(pk: str, sk: str) -> None:
    """Release a reservation whose side effect provably did NOT happen.

    Transitions ``in_flight -> released`` (NOT a delete — the worker IAM grant
    is Put/Get/Update only, no ``dynamodb:DeleteItem``, per least privilege).
    A released row is re-reservable by the next attempt via a conditional CAS
    in :func:`reserve` (retryable-no-side-effect branch of the failure
    matrix). Guarded by ``status = in_flight`` so a completed/failed record is
    never clobbered.
    """
    now = time.time()
    try:
        _table().update_item(
            Key={PK_ATTR: pk, SK_ATTR: sk},
            UpdateExpression="SET #s = :released, updatedAt = :now",
            ConditionExpression="#s = :inflight",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":released": STATUS_RELEASED,
                ":inflight": STATUS_IN_FLIGHT,
                ":now": now,
            },
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return
        raise LedgerError(f"ledger release failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger release transport error for {pk!r}/{sk!r}: {exc}") from exc


def _recorded_result(row: dict[str, Any]) -> Any:
    """Extract the recorded result from a completed row (parse inline JSON)."""
    if row.get("resultTruncated"):
        return {
            "status": "success",
            "idempotent": True,
            "resultTruncated": True,
            "resultMarker": row.get("resultMarker"),
            "note": "result body exceeded inline cap; faithful replay via S3 is PR2",
        }
    raw = row.get("result")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    return raw


def execute_idempotent(
    *,
    pk: str,
    sk: str,
    tool_name: str,
    mode: str,
    run_tool: Callable[[], Any],
    now: float | None = None,
    wait_kwargs: dict[str, Any] | None = None,
) -> Any:
    """Coordinate reserve -> execute -> finalize for one tool call.

    This is the SINGLE atomic seam (as a pure abstraction): reserve, execute,
    and finalize live inside one call with no external pre/post window. The
    Strands hook wraps a tool so its ``.stream()`` delegates here.

    ``mode == 'bypass'`` skips the ledger entirely (read-only tool) — no row
    is written and ``run_tool`` runs directly. Any other mode is
    ledger-protected (fail-safe default lives in
    ``tool_idempotency.classify_idempotency_mode``).
    """
    if mode == MODE_BYPASS:
        return run_tool()

    now = time.time() if now is None else now
    reservation = reserve(pk, sk, tool_name=tool_name, now=now)

    if reservation.outcome == ReserveOutcome.HIT_COMPLETED:
        return _recorded_result(reservation.row or {})
    if reservation.outcome == ReserveOutcome.HIT_FAILED:
        row = reservation.row or {}
        raise RecordedToolFailure(
            f"tool {tool_name!r} previously failed terminally "
            f"(errorType={row.get('errorType')!r}, "
            f"outcomeIndeterminate={row.get('outcomeIndeterminate')})",
            recorded=row,
        )
    if reservation.outcome == ReserveOutcome.IN_FLIGHT:
        settled = wait_for_terminal(pk, sk, **(wait_kwargs or {}))
        if settled is not None and settled.get("status") == STATUS_COMPLETED:
            return _recorded_result(settled)
        if settled is not None and settled.get("status") == STATUS_FAILED:
            raise RecordedToolFailure(
                f"tool {tool_name!r} failed terminally on the winning attempt",
                recorded=settled,
            )
        # Holder still in-flight after the bounded poll — retryable, and we
        # NEVER executed the side effect (the load-bearing invariant).
        raise RetryableNoExecutionError(
            f"tool {tool_name!r} reservation held by a concurrent execution; "
            "retry without executing"
        )

    # WON (fresh or reclaimed) — execute under the reservation.
    try:
        result = run_tool()
    except ToolOutcomeError as exc:
        if exc.side_effect == "not_sent" and exc.retryable:
            release(pk, sk)
            raise RetryableNoExecutionError(
                f"tool {tool_name!r} failed before sending; reservation released"
            ) from exc
        if exc.side_effect == "applied":
            finalize_failure(pk, sk, error_type=exc.error_type, retryable=False, now=now)
            raise RecordedToolFailure(
                f"tool {tool_name!r} terminal failure: {exc}"
            ) from exc
        # Unknown outcome (incl. explicit side_effect='unknown') — fail safe.
        finalize_failure(
            pk, sk, error_type=exc.error_type, retryable=False,
            outcome_indeterminate=True, now=now,
        )
        raise OutcomeIndeterminateError(
            f"tool {tool_name!r} outcome indeterminate; NOT re-executed"
        ) from exc
    except Exception as exc:  # noqa: BLE001 — any unclassified error == unknown outcome
        # Fail-safe: an un-tokened side-effecting call whose outcome we cannot
        # determine is NEVER re-executed. Surface, never swallow.
        finalize_failure(
            pk, sk, error_type=type(exc).__name__, retryable=False,
            outcome_indeterminate=True, now=now,
        )
        raise OutcomeIndeterminateError(
            f"tool {tool_name!r} raised {type(exc).__name__}; outcome "
            "indeterminate, NOT re-executed"
        ) from exc

    # A tool that returns a status='error' ToolResult is a terminal, known
    # failure (the adapter returned rather than raised — the outcome is known).
    if isinstance(result, dict) and result.get("status") == "error":
        finalize_failure(pk, sk, error_type="tool_error_result", retryable=False, now=now)
        return result

    finalize_success(pk, sk, result=result, now=now)
    return result
