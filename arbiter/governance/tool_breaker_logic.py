"""Pure decision logic for the per-target tool circuit breaker (task 28d624b1).

This module holds ONLY pure, I/O-free logic — target resolution, the coarse
failure window, whether a failure class is a target-health signal, and the
transition predicates. The DynamoDB conditional writes, the per-subprocess
cache, and the fail-open behaviour live in ``tool_breaker_store.py``; the
Strands-seam glue lives in ``arbiter/workerWrapper/tool_breaker_hook.py``.

Design (grounded in the task-28d624b1 level-2 design):

* The breaker isolates a TARGET (an MCP server / integration / datastore),
  never an individual tool: tools that share one external binding resolve to
  the SAME key, so a failing server is isolated once, not per-tool.
* Failure counting REUSES ``common.failure_taxonomy`` (no parallel notion of
  failure): a tool outcome increments the breaker iff its class is a genuine
  target-health signal (TRANSIENT / TIMEOUT, and THROTTLE only when explicitly
  enabled — D4). CIRCUIT_OPEN itself is never counted (a fast-fail is not a
  fresh target failure), and business/validation/policy classes are neutral.
* Single-target resolution only (D3 — YAGNI on multi-binding fan-out): a tool
  bound to more than one external target resolves to its FIRST binding and the
  ambiguity is logged loudly (no evidenced multi-binding instance exists).
* Local/deterministic tools with NO external binding get NO breaker (D7):
  :func:`resolve_breaker_target` returns ``None`` and the store/seam skip the
  breaker phase entirely (zero DynamoDB reads for them).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

from common.failure_taxonomy import FailureClass

logger = logging.getLogger(__name__)


class BreakerState(str, Enum):
    """The three breaker states. ``str`` mixin per repo convention so a member
    compares/serialises as its value across module-identity boundaries."""

    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


# Target kinds. ``tool`` is defined for completeness but is NOT produced by
# :func:`resolve_breaker_target` — a local tool with no external binding is
# excluded from the breaker (D7). The three external kinds are what the breaker
# isolates.
TARGET_KIND_MCP_SERVER = "mcp_server"
TARGET_KIND_INTEGRATION = "integration"
TARGET_KIND_DATASTORE = "datastore"

SK_STATE = "STATE"  # single item per target ⇒ each target is its own partition


@dataclass(frozen=True)
class BreakerTarget:
    """The resolved external target a tool call is gated on."""

    kind: str
    target_id: str


def _binding_is_mcp(binding: dict) -> bool:
    """True when an integration binding names an MCP server integration.

    The MCP integration RECORD id is the stable breaker key (never the endpoint
    URL, which rotates and is secret-adjacent). We detect MCP via the binding's
    declared type/kind; an unknown/absent type falls back to the generic
    ``integration`` kind (still correct — two tools on the same integration id
    share the key regardless)."""
    for key in ("integrationType", "type", "kind", "protocol"):
        value = binding.get(key)
        if isinstance(value, str) and value.strip().lower() in (
            "mcp", "mcp_server", "agentcore_mcp", "external_mcp",
        ):
            return True
    return False


def resolve_breaker_target(tool_config: dict) -> BreakerTarget | None:
    """Resolve the SINGLE external target a tool is gated on, or ``None``.

    Returns ``None`` for a local/deterministic tool with no external binding
    (D7 — the breaker phase is then skipped entirely, zero DynamoDB reads).

    Single-target (D3): an integration binding is preferred over a datastore
    binding, and the FIRST binding wins. If a tool config carries MORE THAN ONE
    external binding, that ambiguity is logged loudly (WARN) — no evidenced
    multi-binding instance exists, so multi-binding fan-out is deliberately not
    built; if one ever appears the log/assert surfaces it for a follow-up.
    """
    if not isinstance(tool_config, dict):
        return None
    integration_bindings = tool_config.get("integrationBindings") or []
    datastore_bindings = tool_config.get("dataStoreBindings") or []
    external_bindings = [
        b for b in integration_bindings if isinstance(b, dict) and b.get("integrationId")
    ] + [
        b for b in datastore_bindings if isinstance(b, dict) and b.get("dataStoreId")
    ]
    if not external_bindings:
        return None  # local tool — no breaker (D7)

    if len(external_bindings) > 1:
        logger.warning(
            "tool %r has %d external bindings; single-target breaker gates the "
            "FIRST only (multi-binding fan-out is intentionally not built — D3). "
            "This is unexpected: no evidenced multi-binding tool exists.",
            tool_config.get("toolId", "unknown"), len(external_bindings),
        )

    first = external_bindings[0]
    integration_id = first.get("integrationId")
    if integration_id:
        kind = TARGET_KIND_MCP_SERVER if _binding_is_mcp(first) else TARGET_KIND_INTEGRATION
        return BreakerTarget(kind=kind, target_id=str(integration_id))
    # datastore binding
    return BreakerTarget(kind=TARGET_KIND_DATASTORE, target_id=str(first["dataStoreId"]))


def breaker_pk(org_id: str, target: BreakerTarget) -> str:
    """The org-scoped partition key ``orgId#targetKind#targetId``.

    ``org_id`` may be empty (executionId-style global uniqueness); the org
    prefix is defense-in-depth cross-org isolation, not the uniqueness
    guarantee. It is always resolved server-side, never from a subprocess
    payload.
    """
    return f"{org_id}#{target.kind}#{target.target_id}"


def window_start(now_epoch: int, window_seconds: int) -> int:
    """Coarse fixed-window bucket start (bounds counter cardinality)."""
    if window_seconds <= 0:
        return int(now_epoch)
    return (int(now_epoch) // window_seconds) * window_seconds


def should_count_failure(failure_class: FailureClass, *, include_throttle: bool) -> bool:
    """True iff a tool-call outcome is a genuine TARGET-HEALTH signal that
    should increment the breaker's failure counter.

    TRANSIENT and TIMEOUT are always health signals (D4). THROTTLE counts ONLY
    when ``include_throttle`` is set (env-gated, default OFF): a throttle is
    provider backpressure, not a broken target, so by default it surfaces as a
    distinct metric rather than opening the breaker. Every other class —
    VALIDATION / POLICY_DENIED / AUTHZ / APPROVAL_ABSENT / INDETERMINATE /
    UNKNOWN and CIRCUIT_OPEN itself — is breaker-NEUTRAL (a fast-fail is not a
    fresh failure; a business/validation error is not target health).
    """
    if failure_class in (FailureClass.TRANSIENT, FailureClass.TIMEOUT):
        return True
    if failure_class == FailureClass.THROTTLE:
        return include_throttle
    return False


def is_probe_eligible(
    state: str, opened_at: int, now_epoch: int, recovery_seconds: int
) -> bool:
    """True when an OPEN breaker has waited out its recovery window and a single
    HALF_OPEN probe may now be attempted (the lease decides the sole prober)."""
    return state == BreakerState.OPEN and int(now_epoch) >= int(opened_at) + int(recovery_seconds)


def is_open_fast_fail(
    state: str, opened_at: int, now_epoch: int, recovery_seconds: int
) -> bool:
    """True when an OPEN breaker is still inside its recovery window ⇒ the call
    must fast-fail WITHOUT touching the target and WITHOUT any DynamoDB write."""
    return state == BreakerState.OPEN and int(now_epoch) < int(opened_at) + int(recovery_seconds)


def crosses_threshold(failure_count: int, threshold: int) -> bool:
    """True when a windowed failure count has reached the open threshold."""
    return int(failure_count) >= int(threshold)


def cache_entry_fresh(
    state: str,
    cached_at: int,
    now_epoch: int,
    *,
    open_ttl_seconds: int,
    closed_ttl_seconds: int,
) -> bool:
    """Asymmetric cache freshness (D5, security lens): an OPEN entry is sticky
    up to ``open_ttl_seconds`` (stale-OPEN fails closed — bounded, self-
    correcting, safe), while a CLOSED/HALF_OPEN entry is only fresh for the
    short ``closed_ttl_seconds`` (stale-CLOSED would hit a known-bad target, so
    it is minimised). Process lifetime is the real bound; the TTL is a safety
    cap on top of it.
    """
    age = int(now_epoch) - int(cached_at)
    if age < 0:
        return False
    if state == BreakerState.OPEN:
        return age < int(open_ttl_seconds)
    return age < int(closed_ttl_seconds)
