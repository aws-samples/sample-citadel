"""Approval-required tool gating tests (finding c947aa77).

REAL-FRAMEWORK discipline (finding ee38af53): these drive the REAL
``ComposedToolHook`` + REAL ``GovernanceEvaluator`` on the SAME
``BeforeToolCallEvent`` seam production uses. We do NOT stub the agent
boundary — the framework converts a tool refusal into an error-status
ToolResult and lets the turn complete, so we assert on the ToolResult PAYLOAD
and the drained refusal SINK, never on a raised exception.

The approval STORE (``governance.tool_approval``) is monkeypatched here at the
read/consume level so these tests isolate the SEAM behaviour (ordering,
tool-swap, refusal-sink, fail-safe direction). The store's own DynamoDB
contract — deterministic ids, atomic single-use, int timestamps, expiry — is
covered end-to-end against moto in ``test_tool_approval_contract_moto.py``.

strands is not installed in this env, so the seam is simulated with the same
minimal fakes the sibling ``test_composed_tool_governance.py`` uses.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types

import pytest

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

_HERE_WW = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _HERE_WW not in sys.path:
    sys.path.insert(0, _HERE_WW)

import governance_tool_hook  # noqa: E402,F401
import tool_idempotency_hook  # noqa: E402
from governance_tool_hook import GovernanceEvaluator, _GovernanceDeniedTool  # noqa: E402
from tool_idempotency_hook import ComposedToolHook, IdempotencyToolHook, _IdempotentToolWrapper  # noqa: E402
from governance import tool_approval  # noqa: E402

# Patch the exact ledger object the idempotency hook holds (module-identity
# trap — see test_composed_tool_governance.py).
ledger = tool_idempotency_hook.ledger  # noqa: E402

_ORG = "orgA"
_WFDEF = "wf-def-1"
_NODE = "node-1"
_EXEC = "exec-1"
_GATED = "gated_tool"


@pytest.fixture(autouse=True)
def _governance_writes_succeed(monkeypatch):
    """Make the audit finding write succeed so a PERMIT is not fail-closed
    blocked, and drain the shared refusal sink around each test for isolation."""
    import governed_tool_handler
    monkeypatch.setattr(governed_tool_handler, "write_finding", lambda *a, **k: None)
    tool_idempotency_hook.drain_governance_refusals()
    yield
    tool_idempotency_hook.drain_governance_refusals()


# --- strands seam fakes (mirror test_composed_tool_governance.py) ------------


class _FakeEvent:
    def __init__(self, name, tool_use_id, tool_input, selected_tool):
        self.tool_use = {"name": name, "toolUseId": tool_use_id, "input": tool_input}
        self.selected_tool = selected_tool


class _FakeInnerTool:
    def __init__(self, name, executed_log, result=None):
        self._name = name
        self._log = executed_log
        self._result = result or {"toolUseId": "tu", "status": "success", "content": [{"text": "ran"}]}

    @property
    def tool_name(self):
        return self._name

    async def stream(self, tool_use, invocation_state, **kwargs):
        from strands.types._events import ToolResultEvent

        self._log.append(self._name)
        yield ToolResultEvent(self._result)


@pytest.fixture
def fake_tool_result_event(monkeypatch):
    mod = types.ModuleType("strands.types._events")

    class ToolResultEvent:
        def __init__(self, tool_result):
            self.tool_result = tool_result

    mod.ToolResultEvent = ToolResultEvent
    strands_mod = sys.modules.get("strands") or types.ModuleType("strands")
    types_mod = sys.modules.get("strands.types") or types.ModuleType("strands.types")
    monkeypatch.setitem(sys.modules, "strands", strands_mod)
    monkeypatch.setitem(sys.modules, "strands.types", types_mod)
    monkeypatch.setitem(sys.modules, "strands.types._events", mod)
    return ToolResultEvent


def _drain(agen):
    async def _run():
        out = []
        async for ev in agen:
            out.append(ev)
        return out

    return asyncio.run(_run())


def _evaluator(gated=(_GATED,)):
    return GovernanceEvaluator(
        agent_id="agent-1", workflow_id=_EXEC, denied_tools=set(),
        approval_required_tools=set(gated),
        org_id=_ORG, workflow_definition_id=_WFDEF, execution_id=_EXEC, node_id=_NODE,
    )


def _idempotency():
    return IdempotencyToolHook(org_id=_ORG, execution_id=_EXEC, node_id=_NODE)


def _valid_grant():
    import time
    return {
        "category": tool_approval.APPROVAL_GRANT_CATEGORY,
        "orgId": _ORG, "workflowDefinitionId": _WFDEF, "nodeId": _NODE, "toolName": _GATED,
        "expiresAt": int(time.time()) + 3600, "decidedBy": "alice",
    }


# ===========================================================================
# 1. Real-framework refusal: gated tool, no approval ⇒ error payload + sink
# ===========================================================================
class TestGatedRefusalRealFramework:
    def test_absent_approval_refuses_payload_and_records_node_failing_sink(
        self, monkeypatch, fake_tool_result_event
    ):
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: None)
        consume_calls = []
        monkeypatch.setattr(tool_approval, "consume", lambda *a, **k: consume_calls.append(a))
        reserve_calls = []
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: reserve_calls.append((a, k)))

        executed: list = []
        inner = _FakeInnerTool(_GATED, executed)
        event = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())._on_before_tool_call(event)

        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert reserve_calls == []          # ORDERING: refusal leaves no reservation
        assert consume_calls == []          # absent grant ⇒ never attempts consume

        events = _drain(event.selected_tool.stream(event.tool_use, {}))
        assert executed == []               # gated tool NEVER ran (no side effect)
        assert events[0].tool_result["status"] == "error"
        assert "requires a pre-granted approval" in events[0].tool_result["content"][0]["text"]

        refusals = tool_idempotency_hook.drain_governance_refusals()
        assert len(refusals) == 1
        assert refusals[0]["errorClass"] == "ApprovalRequiredError"
        assert refusals[0]["retryable"] is False

    def test_valid_approval_consumed_permits_and_runs_tool(
        self, monkeypatch, fake_tool_result_event
    ):
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: _valid_grant())
        monkeypatch.setattr(tool_approval, "consume", lambda *a, **k: True)  # WON single-use
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: ledger.ReserveResult(ledger.ReserveOutcome.WON))
        monkeypatch.setattr(ledger, "finalize_success", lambda *a, **k: None)

        executed: list = []
        inner = _FakeInnerTool(_GATED, executed)
        event = _FakeEvent(_GATED, "tu-2", {"x": 1}, inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())._on_before_tool_call(event)

        assert isinstance(event.selected_tool, _IdempotentToolWrapper)
        _drain(event.selected_tool.stream(event.tool_use, {}))
        assert executed == [_GATED]         # approved tool ran once
        assert tool_idempotency_hook.drain_governance_refusals() == []

    def test_already_consumed_refuses(self, monkeypatch, fake_tool_result_event):
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: _valid_grant())
        monkeypatch.setattr(tool_approval, "consume", lambda *a, **k: False)  # LOST single-use
        inner = _FakeInnerTool(_GATED, [])
        event = _FakeEvent(_GATED, "tu-3", {"x": 1}, inner)
        _evaluator().evaluate(event)
        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert tool_idempotency_hook.drain_governance_refusals()[0]["errorClass"] == "ApprovalRequiredError"


# ===========================================================================
# 2. Differential RED proof: removing the gate lets the gated tool execute
# ===========================================================================
class TestApprovalRemovalRedProof:
    def test_gated_tool_blocked_with_gate_but_executes_without(
        self, monkeypatch, fake_tool_result_event
    ):
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: None)
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: ledger.ReserveResult(ledger.ReserveOutcome.WON))
        monkeypatch.setattr(ledger, "finalize_success", lambda *a, **k: None)

        with_exec: list = []
        inner1 = _FakeInnerTool(_GATED, with_exec)
        ev1 = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner1)
        ComposedToolHook(governance=_evaluator(gated=(_GATED,)), idempotency=_idempotency())._on_before_tool_call(ev1)
        _drain(ev1.selected_tool.stream(ev1.tool_use, {}))
        assert with_exec == []
        assert isinstance(ev1.selected_tool, _GovernanceDeniedTool)

        without_exec: list = []
        inner2 = _FakeInnerTool(_GATED, without_exec)
        ev2 = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner2)
        ComposedToolHook(governance=_evaluator(gated=()), idempotency=_idempotency())._on_before_tool_call(ev2)
        _drain(ev2.selected_tool.stream(ev2.tool_use, {}))
        assert without_exec == [_GATED]     # RED: ungated ⇒ tool executed
        assert isinstance(ev2.selected_tool, _IdempotentToolWrapper)


# ===========================================================================
# 3. Fail-safe direction
# ===========================================================================
class TestFailSafe:
    def test_malformed_grant_missing_expiry_refuses(self, monkeypatch, fake_tool_result_event):
        monkeypatch.setattr(
            tool_approval, "read_grant",
            lambda *a, **k: {"category": tool_approval.APPROVAL_GRANT_CATEGORY,
                             "orgId": _ORG, "workflowDefinitionId": _WFDEF,
                             "nodeId": _NODE, "toolName": _GATED},  # no expiresAt
        )
        consume_calls = []
        monkeypatch.setattr(tool_approval, "consume", lambda *a, **k: consume_calls.append(a))
        inner = _FakeInnerTool(_GATED, [])
        event = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner)
        _evaluator().evaluate(event)
        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert consume_calls == []          # invalid grant ⇒ never consumed
        assert tool_idempotency_hook.drain_governance_refusals()[0]["errorClass"] == "ApprovalRequiredError"

    def test_unreadable_record_fails_loud_infra_refusal(self, monkeypatch, fake_tool_result_event):
        def _boom(*a, **k):
            raise tool_approval.ApprovalReadError("ledger unreadable")
        monkeypatch.setattr(tool_approval, "read_grant", _boom)
        inner = _FakeInnerTool(_GATED, [])
        event = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner)
        _evaluator().evaluate(event)
        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        refusals = tool_idempotency_hook.drain_governance_refusals()
        assert refusals[0]["errorClass"] == "ApprovalReadError"
        assert refusals[0]["retryable"] is True

    def test_incomplete_context_refuses(self, monkeypatch, fake_tool_result_event):
        read_calls = []
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: read_calls.append(a))
        ev_eval = GovernanceEvaluator(
            agent_id="a", workflow_id="w", denied_tools=set(),
            approval_required_tools={_GATED},
            org_id=_ORG, workflow_definition_id="", execution_id="", node_id="",
        )
        inner = _FakeInnerTool(_GATED, [])
        event = _FakeEvent(_GATED, "tu-1", {"x": 1}, inner)
        ev_eval.evaluate(event)
        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert read_calls == []
        assert tool_idempotency_hook.drain_governance_refusals()[0]["errorClass"] == "ApprovalRequiredError"

    def test_ungated_tool_untouched(self, monkeypatch, fake_tool_result_event):
        # A tool NOT in the approval-required set is never read/consumed and
        # permits straight through (byte-identical to pre-feature).
        called = []
        monkeypatch.setattr(tool_approval, "read_grant", lambda *a, **k: called.append(a))
        inner = _FakeInnerTool("safe_tool", [])
        event = _FakeEvent("safe_tool", "tu-1", {"x": 1}, inner)
        assert _evaluator().evaluate(event) is False
        assert event.selected_tool is inner
        assert called == []


# ===========================================================================
# 4. Expiry / validity (unit — on the store's predicate)
# ===========================================================================
class TestValidity:
    def _grant(self, **over):
        import time
        g = {
            "category": tool_approval.APPROVAL_GRANT_CATEGORY,
            "orgId": _ORG, "workflowDefinitionId": _WFDEF, "nodeId": _NODE, "toolName": _GATED,
            "expiresAt": int(time.time()) + 3600,
        }
        g.update(over)
        return g

    def test_expired_grant_is_invalid(self):
        import time
        assert tool_approval.grant_is_valid(
            self._grant(expiresAt=int(time.time()) - 5), _ORG, _WFDEF, _NODE, _GATED
        ) is False

    def test_future_grant_is_valid(self):
        assert tool_approval.grant_is_valid(self._grant(), _ORG, _WFDEF, _NODE, _GATED) is True

    def test_tuple_mismatch_is_invalid(self):
        assert tool_approval.grant_is_valid(
            self._grant(orgId="other-org"), _ORG, _WFDEF, _NODE, _GATED
        ) is False

    def test_none_grant_is_invalid(self):
        assert tool_approval.grant_is_valid(None, _ORG, _WFDEF, _NODE, _GATED) is False


# ===========================================================================
# 5. Deterministic id derivation: FULL tuple, no prefix matching
# ===========================================================================
class TestIdDerivation:
    def test_full_tuple_distinct_ids_no_prefix_collision(self):
        base = tool_approval.grant_finding_id(_ORG, _WFDEF, _NODE, _GATED)
        assert base != tool_approval.grant_finding_id("orgB", _WFDEF, _NODE, _GATED)
        assert base != tool_approval.grant_finding_id(_ORG, "wf-def-2", _NODE, _GATED)
        assert base != tool_approval.grant_finding_id(_ORG, _WFDEF, "node-2", _GATED)
        assert base != tool_approval.grant_finding_id(_ORG, _WFDEF, _NODE, "other_tool")
        # Separator-injection cannot forge a boundary match.
        assert (
            tool_approval.grant_finding_id("a", "b", _NODE, _GATED)
            != tool_approval.grant_finding_id("a\x00b", "", _NODE, _GATED)
        )
        # Grant and consumption ids never collide for the same tuple.
        assert base != tool_approval.consumption_finding_id(_ORG, _WFDEF, _NODE, _GATED)
