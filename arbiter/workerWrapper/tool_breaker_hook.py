"""Strands-seam glue for the per-target tool circuit breaker (task 28d624b1).

Binds the pure logic (``governance.tool_breaker_logic``) and the DynamoDB store
(``governance.tool_breaker_store``) to the live ``BeforeToolCallEvent`` seam.
Composed with governance + idempotency behind the ONE ``ComposedToolHook``
callback (``tool_idempotency_hook``), at the ordering:

    deny-list → breaker pre-check → approval-consume → idempotency
    reserve/execute/finalize → outermost breaker OBSERVER.

A breaker fast-fail happens at the pre-check phase — BEFORE approval-consume and
BEFORE the idempotency reserve — so it burns no approval single-use and leaves
no ledger reservation, and it never touches the target.

Degrades to a no-op import when ``strands`` is unavailable (dev/CI), mirroring
the sibling hooks.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from common.failure_taxonomy import classify  # noqa: E402
from governance.tool_breaker_logic import BreakerState, BreakerTarget  # noqa: E402
from governance.tool_breaker_store import (  # noqa: E402
    PreCheck,
    ToolBreakerStore,
    BreakerTransition,
)

logger = logging.getLogger(__name__)

# DISTINCT finding scope (design §6): a breaker state change is never conflated
# with a deny-list ('worker-tool-handler') or approval ('worker-tool-approval')
# decision when querying findings by scope.
SCOPE_TOOL_TARGET_BREAKER = "tool-target-breaker"

# EventBridge state-change event (console/fleet surfacing itself is DEFERRED to
# a follow-up per scope discipline — only the event + finding are emitted here).
BREAKER_EVENT_SOURCE = "citadel.tool.breaker"
BREAKER_EVENT_DETAIL_TYPE = "citadel.tool.breaker.state_changed"

try:
    from strands.hooks import BeforeToolCallEvent  # type: ignore  # noqa: F401
    from strands.types.tools import AgentTool  # type: ignore

    _STRANDS_AVAILABLE = True
except ImportError:  # pragma: no cover — dev/CI without strands-agents
    _STRANDS_AVAILABLE = False
    AgentTool = object  # type: ignore[assignment,misc]


class CircuitOpenError(Exception):
    """The per-target breaker is OPEN: the call was fast-failed without touching
    the target. Its class name classifies to ``FailureClass.CIRCUIT_OPEN``
    (disposition NEVER). Recorded into the node-failure refusal sink so the node
    fails terminally for THIS attempt (non-terminality is the deferred recovery
    queue, not built here)."""

    retryable = False


def _circuit_open_result(tool_use_id: str, tool_name: str, target: BreakerTarget) -> dict[str, Any]:
    """A ToolResult-shaped error DISTINCT from a policy denial and an approval
    refusal — so an OPEN breaker is never mistaken for a policy denial."""
    return {
        "toolUseId": tool_use_id,
        "status": "error",
        "content": [{"text": (
            f"Tool '{tool_name}' target circuit is OPEN "
            f"({target.kind}:{target.target_id}) — fast-failed without calling "
            "the target (known-bad; will be re-attempted after recovery)."
        )}],
    }


class _CircuitOpenTool(AgentTool):  # type: ignore[misc]
    """Replacement tool installed on a breaker fast-fail. Its ``stream()`` yields
    the CIRCUIT_OPEN error result and records a node-failing refusal; it never
    delegates to the real tool (no target call, no side effect). Mirrors
    ``_GovernanceDeniedTool``/``_CircuitOpenTool`` peers."""

    def __init__(self, inner: Any, target: BreakerTarget):
        try:
            super().__init__()
        except TypeError:  # pragma: no cover — base signature drift
            pass
        self._inner = inner
        self._target = target

    @property
    def tool_name(self) -> str:  # pragma: no cover — thin delegation
        return self._inner.tool_name

    @property
    def tool_spec(self) -> Any:  # pragma: no cover
        return self._inner.tool_spec

    @property
    def tool_type(self) -> str:  # pragma: no cover
        return self._inner.tool_type

    def get_display_properties(self) -> dict[str, str]:  # pragma: no cover
        return self._inner.get_display_properties()

    async def stream(self, tool_use: Any, invocation_state: dict[str, Any], **kwargs: Any):  # pragma: no cover — requires strands runtime
        from strands.types._events import ToolResultEvent

        tool_use_id = str(tool_use.get("toolUseId", "")) if hasattr(tool_use, "get") else ""
        tool_name = str(tool_use.get("name", "")) if hasattr(tool_use, "get") else ""
        # Fail the node with CIRCUIT_OPEN (interim conservative behaviour until
        # the recovery queue lands). Reuse the shared node-failure refusal sink.
        try:
            from tool_idempotency_hook import _record_governance_refusal
            _record_governance_refusal(CircuitOpenError(
                f"tool-target circuit OPEN for {self._target.kind}:{self._target.target_id}"
            ))
        except Exception:  # noqa: BLE001 — best-effort; the block itself is the guarantee
            pass
        yield ToolResultEvent(_circuit_open_result(tool_use_id, tool_name, self._target))


class _BreakerObserverTool(AgentTool):  # type: ignore[misc]
    """OUTERMOST wrapper (installed after idempotency wrapping) that observes the
    terminal outcome of a tool call and drives breaker transitions.

    An exception ESCAPING the inner stream is a target-health failure signal
    (classified via the taxonomy — only TRANSIENT/TIMEOUT, and THROTTLE when
    enabled, actually count); a completed stream (even one returning a business
    ``status:error`` result) means the target RESPONDED and is a success signal.
    The observer never suppresses an exception — it re-raises after recording."""

    def __init__(self, inner: Any, store: ToolBreakerStore, target: BreakerTarget, is_probe: bool):
        try:
            super().__init__()
        except TypeError:  # pragma: no cover
            pass
        self._inner = inner
        self._store = store
        self._target = target
        self._is_probe = is_probe

    @property
    def tool_name(self) -> str:  # pragma: no cover
        return self._inner.tool_name

    @property
    def tool_spec(self) -> Any:  # pragma: no cover
        return self._inner.tool_spec

    @property
    def tool_type(self) -> str:  # pragma: no cover
        return self._inner.tool_type

    def get_display_properties(self) -> dict[str, str]:  # pragma: no cover
        return self._inner.get_display_properties()

    async def stream(self, tool_use: Any, invocation_state: dict[str, Any], **kwargs: Any):  # pragma: no cover — requires strands runtime
        try:
            async for event in self._inner.stream(tool_use, invocation_state, **kwargs):
                yield event
        except BaseException as exc:  # noqa: BLE001 — observe then re-raise
            self._store.observe_failure(self._target, classify(exc), is_probe=self._is_probe)
            raise
        # Completed without an escaping exception ⇒ the target responded.
        self._store.observe_success(self._target, is_probe=self._is_probe)


class ToolBreaker:
    """Seam-side breaker collaborator composed into ``ComposedToolHook``.

    ``target_resolver`` maps a tool NAME to a :class:`BreakerTarget` or ``None``
    (a local tool with no external binding ⇒ ``None`` ⇒ the breaker phase is
    skipped entirely, zero DynamoDB reads — D7). ``probe_owner`` is a stable
    per-worker id (``executionId#nodeId``) used as the HALF_OPEN lease owner.
    """

    def __init__(
        self,
        *,
        store: ToolBreakerStore,
        target_resolver: Callable[[str], BreakerTarget | None],
        probe_owner: str,
    ):
        self._store = store
        self._target_resolver = target_resolver
        self._probe_owner = probe_owner or "unknown-worker"

    def pre_check(self, event: Any) -> PreCheck | None:
        """Resolve the target and consult the breaker. Returns ``None`` when the
        tool has no external target (breaker skipped, zero DDB)."""
        tool_use = getattr(event, "tool_use", None)
        if tool_use is None:
            return None
        tool_name = tool_use.get("name", "") if hasattr(tool_use, "get") else getattr(tool_use, "name", "")
        target = self._target_resolver(tool_name or "")
        if target is None:
            return None  # local tool — no breaker (D7)
        return self._store.pre_check(target, probe_owner=self._probe_owner)

    def circuit_open_tool(self, inner: Any, pre: PreCheck) -> Any:
        return _CircuitOpenTool(inner, pre.target)

    def wrap_observer(self, inner: Any, pre: PreCheck) -> Any:
        return _BreakerObserverTool(inner, self._store, pre.target, pre.is_probe)


def build_transition_emitter(
    *,
    org_id: str,
    workflow_id: str,
    agent_id: str,
    event_bus_name: str | None,
    eval_run_id: str | None = None,
) -> Callable[[BreakerTransition], None]:
    """Build the ``on_transition`` callback the store fires exactly once per
    state change (single-writer ⇒ storm-proof). Emits a DISTINCT-scope
    GovernanceFinding AND a best-effort EventBridge state-change event. Console/
    fleet GraphQL surfacing is DEFERRED to a follow-up (scope discipline)."""

    def _emit(t: BreakerTransition) -> None:
        _emit_finding(t, org_id=org_id, workflow_id=workflow_id, agent_id=agent_id, eval_run_id=eval_run_id)
        _emit_event(t, org_id=org_id, event_bus_name=event_bus_name, workflow_id=workflow_id)

    return _emit


def _emit_finding(
    t: BreakerTransition, *, org_id: str, workflow_id: str, agent_id: str, eval_run_id: str | None,
) -> None:
    try:
        from governance.models import ArbitrationDecision, GovernanceFinding
        from governance.ledger import write_finding
    except ImportError as exc:  # pragma: no cover — layer-staged package
        logger.error("tool-breaker finding import failed: %s", exc)
        return
    # A recovered (→CLOSED) transition is a PERMIT; opening/reopening (→OPEN) is
    # a DENY. Single-writer guarantees exactly one finding per transition.
    decision = (
        ArbitrationDecision.PERMIT if t.to_state == BreakerState.CLOSED
        else ArbitrationDecision.DENY
    )
    try:
        write_finding(GovernanceFinding.create(
            workflow_id=workflow_id or "unknown-workflow",
            decision=decision,
            requesting_agent=agent_id or "unknown-agent",
            target_agent=f"{t.target.kind}:{t.target.target_id}",
            reason=(
                f"circuit_{t.to_state.lower()}:{t.target.kind}:{t.target.target_id}"
                f":v{t.state_version}"
            ),
            scope_evaluated=SCOPE_TOOL_TARGET_BREAKER,
            contract_evaluated=None,
            eval_run_id=eval_run_id,
        ))
    except Exception as exc:  # noqa: BLE001 — best-effort; single-writer keeps it storm-proof
        logger.error("tool-breaker finding write failed %s->%s: %s", t.from_state, t.to_state, exc)


def _emit_event(
    t: BreakerTransition, *, org_id: str, event_bus_name: str | None, workflow_id: str,
) -> None:
    if not event_bus_name:
        return
    try:
        import boto3
        client = boto3.client("events")
        client.put_events(Entries=[{
            "Source": BREAKER_EVENT_SOURCE,
            "DetailType": BREAKER_EVENT_DETAIL_TYPE,
            "EventBusName": event_bus_name,
            "Detail": json.dumps({
                "orgId": org_id,
                "targetKind": t.target.kind,
                "targetId": t.target.target_id,
                "fromState": str(t.from_state),
                "toState": str(t.to_state),
                "stateVersion": t.state_version,
                "workflowId": workflow_id,
                "timestamp": t.now,
            }),
        }])
    except Exception as exc:  # noqa: BLE001 — best-effort surfacing, never fail the call
        logger.error("tool-breaker state-change event emit failed: %s", exc)
