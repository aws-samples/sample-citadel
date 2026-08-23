"""Tool-execution ledger — operational exactly-once dedupe (PR1 of 2).

An org-scoped, TTL'd DynamoDB ledger that makes a governed tool call
exactly-once *within an attempt* and safe under a reservation race. It is the
operational backbone of tool-call idempotency; ``arbiter/workerWrapper/
tool_idempotency.py`` derives the keys, this module coordinates the
reserve -> execute -> finalize protocol against them.

Guarantee (state it precisely — do NOT collapse to a bare "exactly-once"):

* **Exactly-once execution of the side effect is GUARANTEED for calls that
  resolve to the same key** — redelivery, same-attempt SDK/Strands retries,
  and concurrent split-brain with identical keys. The reservation's
  conditional write is what provides it: exactly one caller wins the reserve
  and executes; every other caller is absorbed (recorded result) or bounced
  with a retryable no-execution error, and NEVER executes.
* **Exactly-once across a watchdog re-dispatch is GUARANTEED for
  workflow-node tool calls once the ``dispatchGeneration`` fence is engaged
  (PR2, landed).** When the step runner re-dispatches a node it increments a
  per-node ``dispatchGeneration`` on the execution row; each worker carries
  the generation it was dispatched under, and the fence — evaluated as a
  ``ConditionCheck`` inside the SAME ``TransactWriteItems`` that performs the
  reserve (no read-then-check TOCTOU window) — REFUSES a stale worker
  (:class:`StaleWorkerFencedError`) before any side effect. So a
  stalled-but-alive original worker (H2 split-brain) and a nondeterministic
  re-dispatch body (H1) can no longer both reach an adapter: only the current
  generation's worker executes.
* **Residual (still best-effort):** a tool call that runs OUTSIDE the fence
  envelope — a supervisor task (no execution/node/generation context) or a
  tool flagged ``idempotency.mode='bypass'`` (skips the ledger, and therefore
  the fence) — is NOT generation-fenced. For those the guarantee remains
  exactly-once-within-attempt + reservation-race safety only. The fence is a
  JOINT property of (reserve-before-execute atomic seam) ∧ (no bypass path)
  ∧ (a generation was threaded); it does not cover paths that opt out of the
  ledger.
* Concurrent-loser *result delivery* is best-effort (a slow/dead holder may
  yield a retryable error instead of the recorded result); side-effect
  *execution* remains exactly-once.

Oversized results are OFFLOADED to a CMK-encrypted, org-prefixed S3 object
(PR2, landed) so a deduped caller receives the FULL recorded result — a
faithful replay. The stored ``resultRef`` is re-checked against the caller's
org/execution prefix on read (:class:`CrossOrgResultRefError`), so a forged or
confused-deputy ref cannot cross orgs.

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
from decimal import Decimal
from enum import Enum
from numbers import Number
from typing import Any, Callable

import boto3
from botocore.exceptions import BotoCoreError, ClientError

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


class StaleWorkerFencedError(LedgerError):
    """A re-dispatched-away (stale) worker was refused at the reserve fence.

    The worker carries a ``dispatchGeneration`` older than the execution row's
    current generation for this node — its node was re-dispatched by the
    watchdog, so a newer worker owns it. The fence (a ``ConditionCheck`` inside
    the SAME ``TransactWriteItems`` as the reserve) rejects it atomically
    BEFORE any adapter call, so no side effect occurred. Non-retryable for THIS
    worker: its generation can never become current again, and the current
    generation's worker will perform (and record) the call.
    """

    retryable = False


class CrossOrgResultRefError(LedgerError):
    """A stored ``resultRef`` does not belong to the reading caller's org.

    Defense-in-depth on the S3 offload read path: the offloaded object key is
    org/execution-prefixed (``tool-results/{orgId}/{executionId}/…``) and is
    re-validated on read against the org/execution derived from the ledger PK
    the caller located the row by. A ref that points outside that prefix (a
    forged or confused-deputy pointer) is refused rather than fetched.
    """

    retryable = False


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
    global _ddb_resource, _s3_client
    _ddb_resource = None
    _s3_client = None


# --- Lazy DynamoDB client (fenced reserve uses TransactWriteItems) -----------


def _get_dynamodb_client() -> Any:
    """The DynamoDB client backing the resource, used for ``TransactWriteItems``.

    ``TransactWriteItems`` (the fenced reserve) has no resource-``Table``
    equivalent, so it must go through a client. We deliberately reuse
    ``resource.meta.client`` — the SAME client the resource ``Table`` calls sit
    on — so this module speaks ONE DynamoDB dialect end to end: **native Python
    values everywhere**. boto3 registers its DynamoDB (un)marshalling transform
    on that client, so ``transact_write_items`` auto-marshals the native
    ``TransactItems`` exactly once — identical to what ``Table.put_item`` /
    ``Table.update_item`` do on the single-item paths.

    Do NOT hand this client pre-marshalled ``{"S": ...}`` AttributeValue maps:
    the transform would marshal them a SECOND time (``{"M": {"S": {...}}}``),
    which real DynamoDB rejects with ``Type mismatch for key pk expected: S
    actual: M``. Keep every value native and let the single transform do the
    work. (This module previously marshalled by hand AND passed the result to
    this transform-laden client — the double-marshal that broke the fenced
    reserve.)
    """
    return _get_dynamodb_resource().meta.client


# --- Lazy S3 client (oversized-result offload) -------------------------------

_s3_client: Any = None


def _get_s3_client() -> Any:
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    return _s3_client


def _result_bucket() -> str | None:
    bucket = os.environ.get("TOOL_RESULT_BUCKET")
    return bucket or None


def _result_kms_key_id() -> str | None:
    key_id = os.environ.get("TOOL_RESULT_KMS_KEY_ID")
    return key_id or None


def _split_pk(pk: str) -> tuple[str, str]:
    """Split a ledger PK ``orgId#executionId`` into ``(orgId, executionId)``.

    ``orgId`` may legitimately be empty (executionId alone is globally unique);
    the org prefix is defense-in-depth, not the uniqueness guarantee.
    """
    org_id, sep, execution_id = pk.partition("#")
    return (org_id, execution_id if sep else "")


def _result_object_key(pk: str, sk: str) -> str:
    """Org/execution-prefixed S3 key for an offloaded result.

    ``tool-results/{orgId}/{executionId}/{sha256(sk)}.json`` — the org prefix
    gives structural cross-org isolation and is re-validated on read.
    """
    org_id, execution_id = _split_pk(pk)
    digest = hashlib.sha256(sk.encode("utf-8")).hexdigest()
    return f"tool-results/{org_id}/{execution_id}/{digest}.json"


# --- Result preparation (inline, else CMK-encrypted org-prefixed S3 offload) -


def _prepare_result(result: Any, *, pk: str, sk: str) -> tuple[Any, dict[str, Any] | None]:
    """Return ``(inline_result_json_or_None, result_ref_or_None)`` for a result.

    Small results are stored inline. When the serialized result exceeds
    ``max_inline_bytes`` it is OFFLOADED to S3 — NOT truncated (a partial
    replay would be unfaithful) — and a ``resultRef`` pointer is returned so a
    redelivered caller receives the FULL recorded body. The object is written
    with SSE-KMS (CMK) under an org/execution-prefixed key
    (``tool-results/{orgId}/{executionId}/…``); the bucket policy additionally
    DENIES any non-KMS put, so a mis-encrypted write fails closed.

    Fails closed: if the result is oversized but no ``TOOL_RESULT_BUCKET`` is
    configured, we raise rather than silently truncate.
    """
    try:
        serialized = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        raise LedgerError(f"tool result is not JSON-serializable: {exc}") from exc
    encoded = serialized.encode("utf-8")
    if len(encoded) <= max_inline_bytes():
        return serialized, None

    bucket = _result_bucket()
    if not bucket:
        raise LedgerError(
            "tool result exceeds the inline cap but TOOL_RESULT_BUCKET is not "
            "configured — refusing to truncate (fail-closed); S3 offload is required"
        )
    key = _result_object_key(pk, sk)
    put_kwargs: dict[str, Any] = {
        "Bucket": bucket,
        "Key": key,
        "Body": encoded,
        "ContentType": "application/json",
        "ServerSideEncryption": "aws:kms",
    }
    kms_key_id = _result_kms_key_id()
    if kms_key_id:
        put_kwargs["SSEKMSKeyId"] = kms_key_id
    try:
        _get_s3_client().put_object(**put_kwargs)
    except (ClientError, BotoCoreError) as exc:
        raise LedgerError(f"tool result S3 offload failed for {key!r}: {exc}") from exc
    return None, {"bucket": bucket, "key": key, "sha256": hashlib.sha256(encoded).hexdigest()}


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
            UpdateExpression="SET #s = :inflight, createdAt = :now, updatedAt = :now, #ttl = :ttl",
            ConditionExpression="#s = :inflight_guard AND createdAt = :seen",
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={
                ":inflight": STATUS_IN_FLIGHT,
                ":inflight_guard": STATUS_IN_FLIGHT,
                ":seen": seen_created_at,
                ":now": int(now),
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
            UpdateExpression="SET #s = :inflight, createdAt = :now, updatedAt = :now, #ttl = :ttl",
            ConditionExpression="#s = :released",
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={
                ":inflight": STATUS_IN_FLIGHT,
                ":released": STATUS_RELEASED,
                ":now": int(now),
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


def _resolve_existing(pk: str, sk: str, now: float) -> ReserveResult:
    """Resolve the outcome when a reservation row already exists.

    Shared by the fenced and non-fenced reserve paths: reads the current row
    and maps it to HIT_COMPLETED / HIT_FAILED / a released- or stale-reclaim
    WON / IN_FLIGHT.
    """
    row = get(pk, sk)
    if row is None:
        # Vanished between the failed conditional write and this read
        # (TTL/reclaim race); treat as retryable rather than executing
        # unprotected.
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
    if isinstance(created_at, (int, float, Decimal)) and (now - float(created_at)) > lease_seconds():
        if _reclaim_stale(pk, sk, seen_created_at=created_at, now=now):
            return ReserveResult(ReserveOutcome.WON, reclaimed=True)
    return ReserveResult(ReserveOutcome.IN_FLIGHT, row=row)


def _reserve_fenced(
    item: dict[str, Any],
    *,
    pk: str,
    sk: str,
    execution_id: str,
    node_id: str,
    dispatch_generation: int,
    now: float,
) -> ReserveResult:
    """Reserve with the dispatch-generation fence in ONE atomic transaction.

    Security condition C2: the generation guard is a ``ConditionCheck`` on the
    execution row evaluated INSIDE the SAME ``TransactWriteItems`` that performs
    the reserve ``Put`` — never a separate read-then-check (which would
    reintroduce a TOCTOU window a re-dispatch could slip through). Either both
    the reserve and the fence commit, or neither does:

    * fence ``ConditionCheck`` (``nodeResults.<nodeId>.dispatchGeneration =
      :gen``) fails  -> the worker is stale -> :class:`StaleWorkerFencedError`,
      no side effect;
    * reserve ``Put`` (``attribute_not_exists``) fails -> the key already
      exists for the CURRENT generation -> resolve the existing row (dedupe
      hit / in-flight / reclaim), exactly as the non-fenced path.
    """
    ledger_table = os.environ.get("TOOL_EXECUTION_LEDGER_TABLE")
    exec_table = os.environ.get("EXECUTIONS_TABLE")
    if not ledger_table:
        raise LedgerError(
            "TOOL_EXECUTION_LEDGER_TABLE not configured — cannot reserve (fail-closed)"
        )
    if not exec_table:
        # A generation was threaded but there is no execution table to fence
        # against — fail closed rather than silently downgrade to unfenced.
        raise LedgerError(
            "dispatch fence requested but EXECUTIONS_TABLE not configured — "
            "cannot evaluate the generation guard (fail-closed)"
        )
    # Native values ONLY. The resource-backed client (see _get_dynamodb_client)
    # auto-marshals these exactly once, matching the single-item paths. Passing
    # pre-marshalled AttributeValue maps here would double-marshal and DynamoDB
    # would reject the ledger pk as type M (expected S).
    transact_items = [
        {
            "Put": {
                "TableName": ledger_table,
                "Item": item,
                "ConditionExpression": f"attribute_not_exists({PK_ATTR})",
            }
        },
        {
            "ConditionCheck": {
                "TableName": exec_table,
                "Key": {"executionId": execution_id},
                "ConditionExpression": "nodeResults.#nid.#gen = :gen",
                "ExpressionAttributeNames": {"#nid": node_id, "#gen": "dispatchGeneration"},
                "ExpressionAttributeValues": {":gen": int(dispatch_generation)},
            }
        },
    ]
    try:
        _get_dynamodb_client().transact_write_items(TransactItems=transact_items)
        return ReserveResult(ReserveOutcome.WON)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code != "TransactionCanceledException":
            raise LedgerError(f"ledger fenced reserve failed for {pk!r}/{sk!r}: {exc}") from exc
        reasons = exc.response.get("CancellationReasons") or []
        fence_failed = len(reasons) > 1 and reasons[1].get("Code") == "ConditionalCheckFailed"
        put_failed = len(reasons) > 0 and reasons[0].get("Code") == "ConditionalCheckFailed"
        if fence_failed:
            raise StaleWorkerFencedError(
                f"worker dispatchGeneration {dispatch_generation} is stale for node "
                f"{node_id!r} (execution {execution_id!r}); refused at reserve fence "
                "before any side effect"
            ) from exc
        if put_failed:
            return _resolve_existing(pk, sk, now)
        raise LedgerError(
            f"ledger fenced reserve cancelled for {pk!r}/{sk!r}: {reasons}"
        ) from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger fenced reserve transport error for {pk!r}/{sk!r}: {exc}") from exc


def reserve(
    pk: str,
    sk: str,
    *,
    tool_name: str,
    dispatch_generation: int | None = None,
    execution_id: str | None = None,
    node_id: str | None = None,
    now: float | None = None,
) -> ReserveResult:
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

    When ``dispatch_generation`` is provided (a workflow-node tool call), the
    reserve is fenced: the generation guard is evaluated in the SAME atomic
    transaction as the reserve (see :func:`_reserve_fenced`), and a stale
    worker raises :class:`StaleWorkerFencedError`. When it is ``None`` (a
    supervisor task, or a pre-feature caller) the reserve is the unfenced
    conditional ``PutItem`` — exactly-once-within-attempt only.
    """
    now = time.time() if now is None else now
    now_i = int(now)
    item = {
        PK_ATTR: pk,
        SK_ATTR: sk,
        "status": STATUS_IN_FLIGHT,
        "toolName": tool_name,
        # Timestamps stored as INTEGER epoch seconds: boto3's DynamoDB marshaller
        # (resource Table AND the resource-backed client behind the fenced
        # transact) rejects native ``float`` ("Float types are not supported");
        # ints marshal cleanly and second precision is ample for a 48h TTL /
        # lease window.
        "createdAt": now_i,
        "updatedAt": now_i,
        # TTL derived from SERVER write-time (not a producer clock), so a
        # skewed/malicious producer cannot force early expiry.
        "ttl": now_i + ttl_seconds(),
    }
    if dispatch_generation is not None:
        if not (execution_id and node_id):
            raise LedgerError(
                "dispatch_generation requires execution_id and node_id to locate "
                "the fence row (fail-closed)"
            )
        item["dispatchGeneration"] = int(dispatch_generation)
        return _reserve_fenced(
            item, pk=pk, sk=sk, execution_id=execution_id, node_id=node_id,
            dispatch_generation=int(dispatch_generation), now=now,
        )
    try:
        _table().put_item(Item=item, ConditionExpression=f"attribute_not_exists({PK_ATTR})")
        return ReserveResult(ReserveOutcome.WON)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise LedgerError(f"ledger reserve failed for {pk!r}/{sk!r}: {exc}") from exc
    except BotoCoreError as exc:
        raise LedgerError(f"ledger reserve transport error for {pk!r}/{sk!r}: {exc}") from exc

    # Reservation exists — resolve its current status.
    return _resolve_existing(pk, sk, now)


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
    values: dict[str, Any] = {":inflight": STATUS_IN_FLIGHT, ":now": int(now)}
    set_parts = ["#s = :status", "updatedAt = :now"]
    for i, (key, value) in enumerate(attributes.items()):
        # 'status' is written via the fixed ``#s = :status`` clause above; it
        # must NOT also get an ``#a{i}`` name alias, or that alias is declared
        # in ExpressionAttributeNames but never referenced — which real
        # DynamoDB rejects ("Value provided in ExpressionAttributeNames unused
        # in expressions"). Only non-status attributes contribute an aliased
        # ``#a{i} = :v{i}`` assignment.
        if key == "status":
            values[":status"] = value
            continue
        placeholder = f":v{i}"
        name_placeholder = f"#a{i}"
        names[name_placeholder] = key
        values[placeholder] = value
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
    """Record a successful execution result (in_flight -> completed).

    Small results are stored inline; an oversized result is offloaded to S3
    (CMK-encrypted, org-prefixed) and only a ``resultRef`` pointer is stored,
    so a redelivered caller can fetch the FULL body (faithful replay).
    """
    now = time.time() if now is None else now
    inline, result_ref = _prepare_result(result, pk=pk, sk=sk)
    attrs: dict[str, Any] = {"status": STATUS_COMPLETED, "resultTruncated": False}
    if result_ref is not None:
        attrs["resultRef"] = result_ref
        attrs["resultOffloaded"] = True
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
    now = int(time.time())
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


def _fetch_result_ref(pk: str, result_ref: dict[str, Any]) -> Any:
    """Fetch an offloaded result from S3 after re-checking its org prefix.

    Defense-in-depth (security condition C3): the stored key MUST live under
    the ``tool-results/{orgId}/{executionId}/`` prefix derived from the ledger
    PK the caller located this row by. A ref pointing outside that prefix — a
    forged or confused-deputy pointer — is refused (:class:`CrossOrgResultRefError`)
    rather than fetched, so one org can never read another org's object even
    if a ref were tampered with.
    """
    if not isinstance(result_ref, dict):
        raise CrossOrgResultRefError(f"malformed resultRef on ledger row: {result_ref!r}")
    key = result_ref.get("key")
    bucket = result_ref.get("bucket")
    if not isinstance(key, str) or not isinstance(bucket, str) or not key or not bucket:
        raise CrossOrgResultRefError(f"incomplete resultRef on ledger row: {result_ref!r}")
    org_id, execution_id = _split_pk(pk)
    expected_prefix = f"tool-results/{org_id}/{execution_id}/"
    if not key.startswith(expected_prefix):
        raise CrossOrgResultRefError(
            f"resultRef key {key!r} is outside the caller's org/execution prefix "
            f"{expected_prefix!r}; refusing cross-org result read"
        )
    try:
        resp = _get_s3_client().get_object(Bucket=bucket, Key=key)
        body = resp["Body"].read()
    except (ClientError, BotoCoreError, KeyError) as exc:
        raise LedgerError(f"offloaded result fetch failed for {key!r}: {exc}") from exc
    try:
        return json.loads(body)
    except (ValueError, TypeError) as exc:
        raise LedgerError(f"offloaded result at {key!r} is not valid JSON: {exc}") from exc


def _recorded_result(row: dict[str, Any], pk: str | None = None) -> Any:
    """Extract the recorded result from a completed row.

    An offloaded result (``resultRef``) is fetched from S3 with an org-prefix
    re-check; an inline result is parsed from JSON. ``pk`` is required to fetch
    an offloaded ref (it carries the org/execution prefix to validate against);
    if a ref is present but no ``pk`` was supplied, we fail closed rather than
    trust the ref.
    """
    result_ref = row.get("resultRef")
    if result_ref is not None:
        if pk is None:
            raise LedgerError(
                "cannot resolve an offloaded resultRef without the ledger PK "
                "for the org-prefix re-check (fail-closed)"
            )
        return _fetch_result_ref(pk, result_ref)
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
    dispatch_generation: int | None = None,
    execution_id: str | None = None,
    node_id: str | None = None,
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

    When ``dispatch_generation`` is provided the reserve is FENCED against the
    execution row's current generation (see :func:`reserve`); a stale
    re-dispatched-away worker raises :class:`StaleWorkerFencedError` and NEVER
    executes.
    """
    # Lazy import (deployed convention): ``MODE_BYPASS`` lives in the worker
    # bundle's ``tool_idempotency`` module, which sits at the worker Lambda's
    # task root (and is wired onto sys.path by arbiter/conftest.py under
    # pytest). This ``governance`` module ships in the SHARED ArbiterCatalogLayer;
    # importing the worker-only ``tool_idempotency`` at module load would make
    # the whole layer unimportable by any other carrier Lambda (and used an
    # ``arbiter.*`` prefix that does not exist in the deployed bundle — the
    # "No module named arbiter" class of failure). Deferring it here keeps the
    # layer self-contained while still resolving in the worker at call time.
    from tool_idempotency import MODE_BYPASS

    if mode == MODE_BYPASS:
        return run_tool()

    now = time.time() if now is None else now
    reservation = reserve(
        pk, sk, tool_name=tool_name, dispatch_generation=dispatch_generation,
        execution_id=execution_id, node_id=node_id, now=now,
    )

    if reservation.outcome == ReserveOutcome.HIT_COMPLETED:
        return _recorded_result(reservation.row or {}, pk)
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
            return _recorded_result(settled, pk)
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
