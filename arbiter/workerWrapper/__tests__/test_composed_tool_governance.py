"""Tests for the composed layer-2 governance + tool-idempotency seam
(finding 027c4a89).

Covers:
  * governance DENY swaps selected_tool BEFORE any idempotency reserve
    (deny-before-reserve ordering invariant): no reservation, no execution;
  * governance PERMIT falls through to the idempotency reserve/wrap;
  * async stream drive: a denied tool yields the deny error and NEVER calls the
    inner tool nor the ledger reserve; a permitted tool reserves (WON) then
    executes then finalizes success;
  * the differential RED proof: with the governance step REMOVED
    (governance=None) the very same denied tool proceeds to execution — this is
    exactly what made layer-2 inert, and is what the composed seam prevents;
  * the single installer `_install_tool_call_hooks`: back-compat no-op,
    fail-loud on an uninstallable control inside an active envelope, and one
    ComposedToolHook appended to Agent(hooks=...).

strands is not installed in this env, so the strands seam is simulated with a
minimal fake ``strands.types._events.ToolResultEvent`` and fake event/tool
objects — the same technique the existing agent_runner tests use.
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

import governance_tool_hook  # noqa: E402
import tool_idempotency_hook  # noqa: E402
from governance_tool_hook import GovernanceEvaluator, _GovernanceDeniedTool  # noqa: E402
from tool_idempotency_hook import ComposedToolHook, IdempotencyToolHook, _IdempotentToolWrapper  # noqa: E402

# CRITICAL (module-identity trap): the hook imports its ledger as
# ``from governance import tool_execution_ledger as ledger``. A separate
# ``arbiter.governance.tool_execution_ledger`` import is a DISTINCT module
# object, so monkeypatching it would NOT affect the hook. Patch the exact
# object the hook holds.
ledger = tool_idempotency_hook.ledger  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes for the strands seam
# ---------------------------------------------------------------------------


class _FakeEvent:
    def __init__(self, name, tool_use_id, tool_input, selected_tool):
        self.tool_use = {"name": name, "toolUseId": tool_use_id, "input": tool_input}
        self.selected_tool = selected_tool


class _FakeInnerTool:
    """A stand-in real tool. ``stream`` appends to an executed log and yields a
    single ToolResultEvent, so a test can prove whether it ran."""

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
    """Install a minimal fake ``strands.types._events.ToolResultEvent`` so the
    async wrapper streams can be driven without real strands."""
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


def _evaluator(denied=("dangerous",)):
    return GovernanceEvaluator(
        agent_id="agent-1", workflow_id="wf-1", denied_tools=set(denied), eval_run_id=None,
    )


def _idempotency():
    return IdempotencyToolHook(org_id="org-1", execution_id="exec-1", node_id="node-1")


# ---------------------------------------------------------------------------
# Ordering invariant: deny BEFORE reserve
# ---------------------------------------------------------------------------


class TestDenyBeforeReserve:
    def test_deny_swaps_selected_tool_and_never_reserves(self, monkeypatch):
        """A denied tool: selected_tool becomes the deny tool, and the
        idempotency reserve is NEVER reached (no reservation, no ledger row)."""
        reserve_calls = []
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: reserve_calls.append((a, k)))
        # write_finding will raise LedgerWriteError (no table) → caught + WARN.

        inner = _FakeInnerTool("dangerous", [])
        event = _FakeEvent("dangerous", "tu-1", {"x": 1}, inner)
        hook = ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())

        hook._on_before_tool_call(event)

        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert not isinstance(event.selected_tool, _IdempotentToolWrapper)
        assert reserve_calls == []  # deny-before-reserve: no reservation created

    def test_permit_falls_through_to_idempotency_wrap(self, monkeypatch):
        """A permitted tool is wrapped by the idempotency wrapper (reserve is
        deferred into the wrapper's stream, not called during selection)."""
        reserve_calls = []
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: reserve_calls.append((a, k)))

        inner = _FakeInnerTool("safe", [])
        event = _FakeEvent("safe", "tu-2", {"x": 1}, inner)
        hook = ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())

        hook._on_before_tool_call(event)

        assert isinstance(event.selected_tool, _IdempotentToolWrapper)
        assert reserve_calls == []  # reserve happens inside stream(), not here

    def test_permit_governance_only_leaves_tool_unchanged(self):
        """Governance-only (supervisor path): a permitted tool is left as-is."""
        inner = _FakeInnerTool("safe", [])
        event = _FakeEvent("safe", "tu-3", {"x": 1}, inner)
        hook = ComposedToolHook(governance=_evaluator(), idempotency=None)

        hook._on_before_tool_call(event)

        assert event.selected_tool is inner


# ---------------------------------------------------------------------------
# Async stream drive — the real side-effect boundary
# ---------------------------------------------------------------------------


class TestStreamExecution:
    def test_denied_stream_yields_error_and_never_runs_inner_or_reserves(
        self, monkeypatch, fake_tool_result_event
    ):
        reserve_calls = []
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: reserve_calls.append((a, k)))

        executed: list = []
        inner = _FakeInnerTool("dangerous", executed)
        event = _FakeEvent("dangerous", "tu-1", {"x": 1}, inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())._on_before_tool_call(event)

        events = _drain(event.selected_tool.stream(event.tool_use, {}))

        assert executed == []           # inner tool NEVER ran (no side effect)
        assert reserve_calls == []      # no reservation
        assert len(events) == 1
        assert events[0].tool_result["status"] == "error"
        assert "not authorised" in events[0].tool_result["content"][0]["text"]

    def test_permitted_stream_reserves_won_then_executes_then_finalizes(
        self, monkeypatch, fake_tool_result_event
    ):
        reserve_calls = []
        finalize_calls = []

        def _fake_reserve(pk, sk, **k):
            reserve_calls.append((pk, sk, k))
            return ledger.ReserveResult(ledger.ReserveOutcome.WON)

        monkeypatch.setattr(ledger, "reserve", _fake_reserve)
        monkeypatch.setattr(
            ledger, "finalize_success",
            lambda pk, sk, **k: finalize_calls.append(("success", pk, sk, k)),
        )

        executed: list = []
        inner = _FakeInnerTool("safe", executed)
        event = _FakeEvent("safe", "tu-2", {"x": 1}, inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())._on_before_tool_call(event)

        events = _drain(event.selected_tool.stream(event.tool_use, {}))

        assert executed == ["safe"]              # permitted tool ran once
        assert len(reserve_calls) == 1           # reserved exactly once
        assert finalize_calls and finalize_calls[0][0] == "success"
        assert len(events) == 1


# ---------------------------------------------------------------------------
# Differential RED proof: removing the governance step lets a denied tool run
# ---------------------------------------------------------------------------


class TestGovernanceRemovalRedProof:
    """RED proof (finding 027c4a89): with the governance step present a denied
    tool is blocked; with governance REMOVED (governance=None — the inert
    pre-fix state where only idempotency was installed) the SAME denied tool
    proceeds to idempotency wrapping and would execute. Differential in one
    test so the guard can never silently regress to the inert state again."""

    def test_denied_tool_blocked_with_governance_but_executes_without(
        self, monkeypatch, fake_tool_result_event
    ):
        monkeypatch.setattr(
            ledger, "reserve", lambda *a, **k: ledger.ReserveResult(ledger.ReserveOutcome.WON)
        )
        monkeypatch.setattr(ledger, "finalize_success", lambda *a, **k: None)

        # WITH governance: denied → deny tool, inner never runs.
        with_exec: list = []
        inner1 = _FakeInnerTool("dangerous", with_exec)
        ev1 = _FakeEvent("dangerous", "tu-1", {"x": 1}, inner1)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency())._on_before_tool_call(ev1)
        _drain(ev1.selected_tool.stream(ev1.tool_use, {}))
        assert with_exec == []
        assert isinstance(ev1.selected_tool, _GovernanceDeniedTool)

        # WITHOUT governance (the inert pre-fix state): the SAME denied tool is
        # wrapped only for idempotency and DOES execute — the vulnerability.
        without_exec: list = []
        inner2 = _FakeInnerTool("dangerous", without_exec)
        ev2 = _FakeEvent("dangerous", "tu-1", {"x": 1}, inner2)
        ComposedToolHook(governance=None, idempotency=_idempotency())._on_before_tool_call(ev2)
        _drain(ev2.selected_tool.stream(ev2.tool_use, {}))
        assert without_exec == ["dangerous"]  # RED: denied tool executed
        assert isinstance(ev2.selected_tool, _IdempotentToolWrapper)


# ---------------------------------------------------------------------------
# Single installer — envelopes + fail-loud
# ---------------------------------------------------------------------------


def _fresh_agent_runner():
    sys.modules.pop("agent_runner", None)
    import agent_runner
    return agent_runner


def _install_fake_hooks_strands(monkeypatch):
    """Install a fake ``strands`` whose Agent accepts hooks (not tool_handler).

    A FRESH Agent class per call so the ``Agent.__init__`` wrapping done by
    ``_install_tool_call_hooks`` never accumulates across tests."""
    class _FreshHooksAgent:
        def __init__(self, model=None, tools=None, hooks=None):
            self.tools = tools
            self.hooks = hooks

    fake = types.ModuleType("strands")
    fake.Agent = _FreshHooksAgent
    monkeypatch.setitem(sys.modules, "strands", fake)
    return fake


class TestInstallToolCallHooks:
    def test_backcompat_noop_when_no_envelope(self, monkeypatch):
        for v in ("CITADEL_AGENT_ID", "CITADEL_EXECUTION_ID", "CITADEL_NODE_ID"):
            monkeypatch.delenv(v, raising=False)
        monkeypatch.setitem(sys.modules, "strands", None)
        agent_runner = _fresh_agent_runner()
        assert agent_runner._install_tool_call_hooks() is False

    def test_governance_envelope_installs_composed_hook(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        fake = _install_fake_hooks_strands(monkeypatch)
        agent_runner = _fresh_agent_runner()

        assert agent_runner._install_tool_call_hooks() is True
        a = fake.Agent(tools=[])
        assert isinstance(a.hooks, list) and len(a.hooks) == 1
        composed = a.hooks[0]
        assert composed.governance is not None
        assert composed.idempotency is None

    def test_both_envelopes_install_governance_and_idempotency(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        fake = _install_fake_hooks_strands(monkeypatch)
        agent_runner = _fresh_agent_runner()

        assert agent_runner._install_tool_call_hooks() is True
        a = fake.Agent(tools=[])
        composed = a.hooks[0]
        assert composed.governance is not None
        assert composed.idempotency is not None

    def test_composed_hook_appended_to_caller_hooks(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        fake = _install_fake_hooks_strands(monkeypatch)
        agent_runner = _fresh_agent_runner()
        agent_runner._install_tool_call_hooks()

        sentinel = object()
        a = fake.Agent(hooks=[sentinel])
        assert a.hooks[0] is sentinel and len(a.hooks) == 2

    def test_fail_loud_governance_envelope_strands_unavailable(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        monkeypatch.setitem(sys.modules, "strands", None)  # import strands -> ImportError
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="governance/idempotency REQUIRED"):
            agent_runner._install_tool_call_hooks()

    def test_fail_loud_governance_module_unimportable(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        _install_fake_hooks_strands(monkeypatch)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="layer-2 tool governance REQUIRED"):
            agent_runner._install_tool_call_hooks()

    def test_fail_loud_idempotency_module_unimportable(self, monkeypatch):
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        _install_fake_hooks_strands(monkeypatch)
        monkeypatch.setitem(sys.modules, "tool_idempotency_hook", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="idempotency hook REQUIRED"):
            agent_runner._install_tool_call_hooks()
