"""DynamoDB-backed per-target circuit-breaker store (task 28d624b1).

Shares breaker state across the short-lived worker subprocesses via conditional
writes, exactly as ``tool_execution_ledger.py`` shares idempotency state. This
module owns ALL I/O (DynamoDB reads/writes + a per-subprocess in-process cache);
the pure decision logic is in ``tool_breaker_logic.py`` and the Strands-seam
glue is in ``arbiter/workerWrapper/tool_breaker_hook.py``.

Load-bearing invariants (grounded in the level-2 design):

* **Fast-fail is local.** A steady-state OPEN target fast-fails from the
  per-subprocess cache with ZERO DynamoDB calls and without touching the
  target — the <100ms budget is met structurally, not by a wall-clock race.
* **Two concurrent workers never double-probe.** OPEN→HALF_OPEN is a single
  conditional-write lease (guarded on the lease expiry); exactly one worker
  wins and becomes the sole prober, every other worker's conditional write is
  refused and it fast-fails as OPEN. An EXPIRED lease is re-acquirable so a
  crashed prober can never wedge the breaker.
* **Transitions are single-writer ⇒ findings are storm-proof.** Every state
  transition is a conditional write guarded on the monotonic ``stateVersion``
  (or the probe-lease owner), so exactly one worker performs it and emits
  exactly one transition side-effect — regardless of call volume.
* **Fail-OPEN (D7).** The breaker is an availability optimisation, NOT a
  security control. If its OWN store is unavailable, every store operation
  degrades to "proceed" (treat as CLOSED) so a breaker-store outage can never
  become a fleet-wide tool-call outage. The genuine controls (deny-list,
  failure taxonomy) are independent of this store and still run.
* **Float-safe writes.** Every item write goes through
  ``common.ddb_marshalling.marshal_ddb_item`` with int-epoch timestamps.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from common.ddb_marshalling import marshal_ddb_item
from governance.tool_breaker_logic import (
    BreakerState,
    BreakerTarget,
    breaker_pk,
    cache_entry_fresh,
    crosses_threshold,
    is_open_fast_fail,
    is_probe_eligible,
    window_start,
)

logger = logging.getLogger(__name__)

SK_STATE = "STATE"

# --- Tunables (env-overridable, delivered CDK -> Lambda env -> subprocess) ---

DEFAULT_FAILURE_THRESHOLD = 5           # N failures in window W ⇒ OPEN
DEFAULT_WINDOW_SECONDS = 60             # W — coarse failure-count bucket
DEFAULT_RECOVERY_SECONDS = 30           # OPEN dwell before a probe is eligible
DEFAULT_PROBE_LEASE_SECONDS = 30        # HALF_OPEN probe lease lifetime
DEFAULT_CACHE_TTL_SECONDS = 3           # SAFETY CAP for a CLOSED/HALF_OPEN cache entry
DEFAULT_TTL_SECONDS = 24 * 3600         # idle-row self-clean (RETAIN guards the table)


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class BreakerConfig:
    """Resolved breaker tunables. ``open_cache_ttl_seconds`` is the recovery
    window (an OPEN cache entry is sticky until a probe becomes eligible, then
    a DynamoDB read is forced anyway); ``closed_cache_ttl_seconds`` is the short
    SAFETY CAP that minimises the stale-CLOSED window (D5)."""

    failure_threshold: int = DEFAULT_FAILURE_THRESHOLD
    window_seconds: int = DEFAULT_WINDOW_SECONDS
    recovery_seconds: int = DEFAULT_RECOVERY_SECONDS
    probe_lease_seconds: int = DEFAULT_PROBE_LEASE_SECONDS
    closed_cache_ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    include_throttle: bool = False

    @property
    def open_cache_ttl_seconds(self) -> int:
        # Stale-OPEN is acceptable (fails closed, self-correcting); the cap is
        # the recovery window — past it a probe is eligible and we must read.
        return self.recovery_seconds

    @classmethod
    def from_env(cls) -> "BreakerConfig":
        return cls(
            failure_threshold=_int_env("TOOL_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD),
            window_seconds=_int_env("TOOL_BREAKER_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS),
            recovery_seconds=_int_env("TOOL_BREAKER_RECOVERY_SECONDS", DEFAULT_RECOVERY_SECONDS),
            probe_lease_seconds=_int_env("TOOL_BREAKER_PROBE_LEASE_SECONDS", DEFAULT_PROBE_LEASE_SECONDS),
            closed_cache_ttl_seconds=_int_env("TOOL_BREAKER_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS),
            ttl_seconds=_int_env("TOOL_BREAKER_TTL_SECONDS", DEFAULT_TTL_SECONDS),
            include_throttle=_bool_env("TOOL_BREAKER_OPEN_ON_THROTTLE"),
        )


class PreCheckDecision(str, Enum):
    PROCEED = "proceed"      # CLOSED (or fail-open): run the tool, observe outcome
    FAST_FAIL = "fast_fail"  # OPEN (or lease lost): fast-fail, do NOT touch target
    PROBE = "probe"          # this worker won the HALF_OPEN lease: run + observe


@dataclass
class PreCheck:
    decision: PreCheckDecision
    target: BreakerTarget
    state: str = BreakerState.CLOSED

    @property
    def fast_fail(self) -> bool:
        return self.decision is PreCheckDecision.FAST_FAIL

    @property
    def observing(self) -> bool:
        # We observe (and may transition) on the CLOSED path and on the probe
        # path — never on a fast-fail (nothing ran).
        return self.decision in (PreCheckDecision.PROCEED, PreCheckDecision.PROBE)

    @property
    def is_probe(self) -> bool:
        return self.decision is PreCheckDecision.PROBE


@dataclass
class BreakerTransition:
    target: BreakerTarget
    from_state: str
    to_state: str
    state_version: int
    now: int


@dataclass
class _CacheEntry:
    state: str
    opened_at: int
    state_version: int
    cached_at: int


# --- Lazy boto3 resource (mirrors the ledger's lazy seam) --------------------

_ddb_resource: Any = None


def _get_dynamodb_resource() -> Any:
    global _ddb_resource
    if _ddb_resource is None:
        _ddb_resource = boto3.resource("dynamodb")
    return _ddb_resource


def __reset_breaker_client_for_test() -> None:
    """Test-only: clear the cached boto3 resource."""
    global _ddb_resource
    _ddb_resource = None


class ToolBreakerStore:
    """Conditional-write breaker store with a per-instance (per-subprocess)
    cache. One instance is built per worker subprocess (like the idempotency
    hook), so the cache is process-scoped by construction.
    """

    def __init__(
        self,
        *,
        table_name: str,
        org_id: str = "",
        config: BreakerConfig | None = None,
        on_transition: Callable[[BreakerTransition], None] | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self._table_name = table_name
        self._org_id = org_id or ""
        self._config = config or BreakerConfig()
        self._on_transition = on_transition
        self._clock = clock
        self._cache: dict[str, _CacheEntry] = {}
        # Observability for tests + telemetry: DynamoDB op count on this store.
        self.ddb_op_count = 0
        # Set True by _get_row when the store read failed (drives fail-open).
        self._store_unavailable = False

    # --- table access --------------------------------------------------------

    def _table(self) -> Any:
        return _get_dynamodb_resource().Table(self._table_name)

    def _now(self) -> int:
        return int(self._clock())

    # --- pre-check -----------------------------------------------------------

    def pre_check(self, target: BreakerTarget, *, probe_owner: str) -> PreCheck:
        """Decide fast-fail / proceed / probe for a target.

        A steady-state OPEN target fast-fails from cache with ZERO DynamoDB
        calls. On a cache miss/stale entry a single eventually-consistent
        GetItem resolves the state (fail-OPEN on any store error). An
        OPEN-past-recovery target attempts the single conditional probe lease.
        """
        pk = breaker_pk(self._org_id, target)
        now = self._now()
        cfg = self._config

        cached = self._cache.get(pk)
        if cached is not None and cache_entry_fresh(
            cached.state, cached.cached_at, now,
            open_ttl_seconds=cfg.open_cache_ttl_seconds,
            closed_ttl_seconds=cfg.closed_cache_ttl_seconds,
        ):
            if is_open_fast_fail(cached.state, cached.opened_at, now, cfg.recovery_seconds):
                # Cached OPEN, still inside recovery ⇒ fast-fail, ZERO DDB.
                return PreCheck(PreCheckDecision.FAST_FAIL, target, BreakerState.OPEN)
            if cached.state == BreakerState.CLOSED:
                return PreCheck(PreCheckDecision.PROCEED, target, BreakerState.CLOSED)
            # Cached OPEN-past-recovery or HALF_OPEN: fall through to DDB (a
            # probe-lease decision must be made against authoritative state).

        row = self._get_row(pk)
        if row is None and self._store_unavailable:
            # FAIL-OPEN: store unreachable ⇒ treat as CLOSED, never block.
            return PreCheck(PreCheckDecision.PROCEED, target, BreakerState.CLOSED)
        if not row:
            self._cache[pk] = _CacheEntry(BreakerState.CLOSED, 0, 0, now)
            return PreCheck(PreCheckDecision.PROCEED, target, BreakerState.CLOSED)

        state = str(row.get("state", BreakerState.CLOSED))
        opened_at = int(row.get("openedAt", 0) or 0)
        state_version = int(row.get("stateVersion", 0) or 0)
        self._cache[pk] = _CacheEntry(state, opened_at, state_version, now)

        if state == BreakerState.CLOSED:
            return PreCheck(PreCheckDecision.PROCEED, target, BreakerState.CLOSED)

        if is_open_fast_fail(state, opened_at, now, cfg.recovery_seconds):
            return PreCheck(PreCheckDecision.FAST_FAIL, target, BreakerState.OPEN)

        if is_probe_eligible(state, opened_at, now, cfg.recovery_seconds) or (
            state == BreakerState.HALF_OPEN
        ):
            # OPEN past recovery, or a HALF_OPEN whose prober may be dead:
            # attempt the single conditional probe lease.
            if self._try_acquire_probe_lease(pk, owner=probe_owner, now=now):
                return PreCheck(PreCheckDecision.PROBE, target, BreakerState.HALF_OPEN)
            # Lost the lease ⇒ another worker is the sole prober ⇒ fast-fail.
            return PreCheck(PreCheckDecision.FAST_FAIL, target, BreakerState.OPEN)

        return PreCheck(PreCheckDecision.PROCEED, target, state)

    # --- observation (drives transitions) ------------------------------------

    def observe_success(self, target: BreakerTarget, *, is_probe: bool) -> None:
        """Record a healthy outcome. On the probe path this closes the breaker
        (HALF_OPEN→CLOSED). On the CLOSED happy path it is WRITE-QUIET (no DDB
        write) so a healthy target never contends the hot item."""
        if not is_probe:
            return  # write-quiet when healthy
        pk = breaker_pk(self._org_id, target)
        now = self._now()
        self._transition_from_probe(
            pk, target, to_state=BreakerState.CLOSED, now=now, owner_required=True,
            reset_failures=True,
        )

    def observe_failure(
        self, target: BreakerTarget, failure_class: Any, *, is_probe: bool
    ) -> None:
        """Record a target-health failure. On the probe path this reopens the
        breaker (HALF_OPEN→OPEN). On the CLOSED path it increments the windowed
        counter and, on crossing the threshold, opens (CLOSED→OPEN)."""
        from governance.tool_breaker_logic import should_count_failure

        if not should_count_failure(failure_class, include_throttle=self._config.include_throttle):
            return  # neutral class — not a target-health signal
        pk = breaker_pk(self._org_id, target)
        now = self._now()
        if is_probe:
            self._transition_from_probe(
                pk, target, to_state=BreakerState.OPEN, now=now, owner_required=True,
                reset_failures=False,
            )
            return
        self._count_and_maybe_open(pk, target, now=now)

    # --- conditional writes --------------------------------------------------

    def _get_row(self, pk: str) -> dict[str, Any] | None:
        self._store_unavailable = False
        try:
            self.ddb_op_count += 1
            resp = self._table().get_item(Key={"pk": pk, "sk": SK_STATE})
        except (ClientError, BotoCoreError) as exc:
            # FAIL-OPEN: a read failure must not block the call.
            logger.error("tool-breaker get_item FAILED (fail-open) pk=%s: %s", pk, exc)
            self._store_unavailable = True
            return None
        item = resp.get("Item")
        return item if isinstance(item, dict) else None

    def _try_acquire_probe_lease(self, pk: str, *, owner: str, now: int) -> bool:
        """OPEN→HALF_OPEN single-prober lease. Guarded on the lease being absent
        or EXPIRED so exactly one worker wins and a dead prober can't wedge the
        breaker. Returns True iff this worker acquired the lease.

        This conditional guard is the two-workers-never-double-probe control —
        replacing it with an unconditional write is the adversarial RED bite."""
        lease_expiry = now + self._config.probe_lease_seconds
        item_ttl = now + self._config.ttl_seconds
        try:
            self.ddb_op_count += 1
            self._table().update_item(
                Key={"pk": pk, "sk": SK_STATE},
                UpdateExpression=(
                    "SET #state = :half, probeLeaseOwner = :owner, "
                    "probeLeaseExpiresAt = :expiry, updatedAt = :now, #ttl = :itl "
                    "ADD stateVersion :one"
                ),
                ConditionExpression=(
                    "#state IN (:open, :half) AND "
                    "(attribute_not_exists(probeLeaseExpiresAt) OR probeLeaseExpiresAt < :now)"
                ),
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues=marshal_ddb_item({
                    ":half": BreakerState.HALF_OPEN.value,
                    ":open": BreakerState.OPEN.value,
                    ":owner": owner,
                    ":expiry": lease_expiry,
                    ":now": now,
                    ":itl": item_ttl,
                    ":one": 1,
                }),
            )
            self._cache.pop(pk, None)
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            logger.error("tool-breaker lease acquire FAILED (fail-open) pk=%s: %s", pk, exc)
            return False
        except BotoCoreError as exc:
            logger.error("tool-breaker lease acquire transport error (fail-open) pk=%s: %s", pk, exc)
            return False

    def _transition_from_probe(
        self, pk: str, target: BreakerTarget, *, to_state: str, now: int,
        owner_required: bool, reset_failures: bool,
    ) -> None:
        """HALF_OPEN→{CLOSED,OPEN} guarded on ``state=HALF_OPEN`` — only the
        current prober transitions. Best-effort (fail-open) but single-writer,
        so exactly one recovered/reopen finding is emitted."""
        item_ttl = now + self._config.ttl_seconds
        to_value = to_state.value if isinstance(to_state, BreakerState) else str(to_state)
        set_parts = ["#state = :to", "updatedAt = :now", "#ttl = :itl"]
        values: dict[str, Any] = {
            ":to": to_value, ":half": BreakerState.HALF_OPEN.value,
            ":now": now, ":itl": item_ttl, ":one": 1,
        }
        if reset_failures:
            set_parts.append("failureCount = :zero")
            values[":zero"] = 0
        if to_state == BreakerState.OPEN:
            set_parts.append("openedAt = :now")
        expr = "SET " + ", ".join(set_parts) + " ADD stateVersion :one REMOVE probeLeaseOwner, probeLeaseExpiresAt"
        try:
            self.ddb_op_count += 1
            resp = self._table().update_item(
                Key={"pk": pk, "sk": SK_STATE},
                UpdateExpression=expr,
                ConditionExpression="#state = :half",
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues=marshal_ddb_item(values),
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return  # not the prober / already transitioned
            logger.error("tool-breaker probe transition FAILED (fail-open) pk=%s: %s", pk, exc)
            return
        except BotoCoreError as exc:
            logger.error("tool-breaker probe transition transport error (fail-open) pk=%s: %s", pk, exc)
            return
        new = resp.get("Attributes", {}) or {}
        self._cache.pop(pk, None)
        self._emit(target, BreakerState.HALF_OPEN, to_state, int(new.get("stateVersion", 0) or 0), now)

    def _count_and_maybe_open(self, pk: str, target: BreakerTarget, *, now: int) -> None:
        """Increment the windowed failure counter (CLOSED only) then, on
        crossing the threshold, transition CLOSED→OPEN via a ``stateVersion``-
        guarded conditional write (exactly one worker opens ⇒ one finding).

        Removing the ``stateVersion = :seen`` guard on the CLOSED→OPEN write is
        the adversarial RED bite (a storm files >1 finding)."""
        cfg = self._config
        cur_window = window_start(now, cfg.window_seconds)
        item_ttl = now + cfg.ttl_seconds
        new_row = self._increment_failure(pk, now=now, cur_window=cur_window, item_ttl=item_ttl)
        if new_row is None:
            return  # not CLOSED (already OPEN/HALF_OPEN) or store error — fail-open
        failure_count = int(new_row.get("failureCount", 0) or 0)
        state_version = int(new_row.get("stateVersion", 0) or 0)
        if str(new_row.get("state", BreakerState.CLOSED)) != BreakerState.CLOSED:
            return
        if not crosses_threshold(failure_count, cfg.failure_threshold):
            return
        try:
            self.ddb_op_count += 1
            resp = self._table().update_item(
                Key={"pk": pk, "sk": SK_STATE},
                UpdateExpression=(
                    "SET #state = :open, openedAt = :now, updatedAt = :now, #ttl = :itl "
                    "ADD stateVersion :one"
                ),
                ConditionExpression="#state = :closed AND stateVersion = :seen",
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues=marshal_ddb_item({
                    ":open": BreakerState.OPEN.value,
                    ":closed": BreakerState.CLOSED.value,
                    ":now": now,
                    ":itl": item_ttl,
                    ":seen": state_version,
                    ":one": 1,
                }),
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return  # another worker opened it (or a stale snapshot) — no dup finding
            logger.error("tool-breaker open transition FAILED (fail-open) pk=%s: %s", pk, exc)
            return
        except BotoCoreError as exc:
            logger.error("tool-breaker open transition transport error (fail-open) pk=%s: %s", pk, exc)
            return
        new = resp.get("Attributes", {}) or {}
        self._cache.pop(pk, None)
        self._emit(target, BreakerState.CLOSED, BreakerState.OPEN, int(new.get("stateVersion", 0) or 0), now)

    def _increment_failure(
        self, pk: str, *, now: int, cur_window: int, item_ttl: int
    ) -> dict[str, Any] | None:
        """Windowed ADD failureCount, only while CLOSED. Returns the new row
        (ALL_NEW) or None (not CLOSED / store error). Two attempts: increment
        within the current window, else roll/create the window."""
        try:
            self.ddb_op_count += 1
            resp = self._table().update_item(
                Key={"pk": pk, "sk": SK_STATE},
                UpdateExpression="SET updatedAt = :now, #ttl = :itl ADD failureCount :one",
                ConditionExpression="#state = :closed AND windowStart = :cur",
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues=marshal_ddb_item({
                    ":now": now, ":itl": item_ttl, ":one": 1,
                    ":closed": BreakerState.CLOSED.value, ":cur": cur_window,
                }),
                ReturnValues="ALL_NEW",
            )
            return resp.get("Attributes", {}) or {}
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                logger.error("tool-breaker failure incr FAILED (fail-open) pk=%s: %s", pk, exc)
                return None
        except BotoCoreError as exc:
            logger.error("tool-breaker failure incr transport error (fail-open) pk=%s: %s", pk, exc)
            return None
        # Window rolled, or the row does not yet exist: create/reset the window
        # (still CLOSED). Guarded so we never resurrect an OPEN/HALF_OPEN row.
        try:
            self.ddb_op_count += 1
            resp = self._table().update_item(
                Key={"pk": pk, "sk": SK_STATE},
                UpdateExpression=(
                    "SET #state = if_not_exists(#state, :closed), windowStart = :cur, "
                    "failureCount = :one, stateVersion = if_not_exists(stateVersion, :zero), "
                    "openedAt = if_not_exists(openedAt, :zero), updatedAt = :now, #ttl = :itl"
                ),
                ConditionExpression=(
                    "attribute_not_exists(pk) OR "
                    "(#state = :closed AND (attribute_not_exists(windowStart) OR windowStart < :cur))"
                ),
                ExpressionAttributeNames={"#state": "state", "#ttl": "ttl"},
                ExpressionAttributeValues=marshal_ddb_item({
                    ":closed": BreakerState.CLOSED.value, ":cur": cur_window,
                    ":one": 1, ":zero": 0, ":now": now, ":itl": item_ttl,
                }),
                ReturnValues="ALL_NEW",
            )
            return resp.get("Attributes", {}) or {}
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None  # not CLOSED — already OPEN/HALF_OPEN
            logger.error("tool-breaker window roll FAILED (fail-open) pk=%s: %s", pk, exc)
            return None
        except BotoCoreError as exc:
            logger.error("tool-breaker window roll transport error (fail-open) pk=%s: %s", pk, exc)
            return None

    def _emit(self, target: BreakerTarget, from_state: str, to_state: str, state_version: int, now: int) -> None:
        if self._on_transition is None:
            return
        try:
            self._on_transition(BreakerTransition(target, from_state, to_state, state_version, now))
        except Exception as exc:  # noqa: BLE001 — emission must never crash the call
            logger.error("tool-breaker transition emit failed %s->%s: %s", from_state, to_state, exc)
