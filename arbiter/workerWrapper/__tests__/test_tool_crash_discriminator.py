"""Three-way failure discriminator + finalize-on-raise tests (finding 4595b730).

STRUCTURAL basis (never error-message matching):
  * infra/governance REFUSAL  -> LedgerError from reserve/finalize -> node FAILS
  * tool UNHANDLED EXCEPTION   -> an exception ESCAPES the tool's stream()
                                  -> node FAILS (a crash is not a business outcome)
  * tool-returned STRUCTURED   -> the tool RETURNS {"status":"error"}
    domain error                 -> node COMPLETES

Plus FINALIZE ON RAISE: when a tool raises, the reservation is finalized FAILED
so no ledger row is left in_flight, and 'indeterminate' is reserved strictly
for a genuinely-unknown outcome (ToolOutcomeError side_effect='unknown').

strands is stubbed with a minimal fake ToolResultEvent, mirroring
test_composed_tool_governance.py.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import tempfile
import types
from unittest.mock import patch

import pytest

_HERE_WW = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _HERE_WW not in sys.path:
    sys.path.insert(0, _HERE_WW)

import tool_idempotency_hook  # noqa: E402
from tool_idempotency_hook import _IdempotentToolWrapper  # noqa: E402

ledger = tool_idempotency_hook.ledger  # patch the exact object the hook holds


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


class _InnerRaises:
    """Inner tool whose stream RAISES (an exception escapes the tool)."""

    def __init__(self, exc):
        self._exc = exc

    tool_name = "boom"

    async def stream(self, tool_use, invocation_state, **kwargs):
        raise self._exc
        yield  # pragma: no cover — unreachable, makes this an async generator


class _InnerReturns:
    """Inner tool whose stream RETURNS a ToolResult payload (no exception)."""

    def __init__(self, result):
        self._result = result

    tool_name = "ok"

    async def stream(self, tool_use, invocation_state, **kwargs):
        from strands.types._events import ToolResultEvent

        yield ToolResultEvent(self._result)


def _drive(inner, monkeypatch):
    """Reserve=WON (no real DDB), capture finalize calls, drive the wrapper."""
    finals: list = []
    monkeypatch.setattr(ledger, "reserve", lambda *a, **k: ledger.ReserveResult(ledger.ReserveOutcome.WON))
    monkeypatch.setattr(ledger, "finalize_success", lambda pk, sk, **k: finals.append(("success", k)))
    monkeypatch.setattr(ledger, "finalize_failure", lambda pk, sk, **k: finals.append(("failure", k)))
    monkeypatch.setattr(ledger, "release", lambda pk, sk, **k: finals.append(("release", {})))
    tool_idempotency_hook.drain_tool_crashes()
    tool_idempotency_hook.drain_governance_refusals()

    wrapper = _IdempotentToolWrapper(inner, "pk", "sk", inner.tool_name, "ledger")

    async def _run():
        out = []
        async for ev in wrapper.stream({"toolUseId": "tu"}, {}):
            out.append(ev)
        return out

    return finals, _run


class TestDiscriminatorStructural:
    def test_tool_unhandled_exception_fails_node_and_finalizes_failed(
        self, monkeypatch, fake_tool_result_event
    ):
        finals, run = _drive(_InnerRaises(RuntimeError("kaboom")), monkeypatch)
        with pytest.raises(RuntimeError):
            asyncio.run(run())
        # A tool crash is recorded (node FAILS) ...
        crashes = tool_idempotency_hook.drain_tool_crashes()
        assert len(crashes) == 1 and crashes[0]["errorClass"] == "RuntimeError"
        # ... and the reservation is finalized FAILED (no in_flight leak), NOT
        # indeterminate (a bare crash is a determinate failure).
        assert finals == [("failure", {"error_type": "RuntimeError", "retryable": False})]

    def test_tool_returned_structured_error_completes_node(
        self, monkeypatch, fake_tool_result_event
    ):
        finals, run = _drive(
            _InnerReturns({"toolUseId": "tu", "status": "error", "content": [{"text": "nope"}]}),
            monkeypatch,
        )
        events = asyncio.run(run())
        assert len(events) == 1
        # No crash recorded -> node COMPLETES; ledger row finalized failed.
        assert tool_idempotency_hook.drain_tool_crashes() == []
        assert finals == [("failure", {"error_type": "tool_error_result", "retryable": False})]

    def test_tool_success_completes_and_finalizes_success(
        self, monkeypatch, fake_tool_result_event
    ):
        finals, run = _drive(
            _InnerReturns({"toolUseId": "tu", "status": "success", "content": [{"text": "ran"}]}),
            monkeypatch,
        )
        asyncio.run(run())
        assert tool_idempotency_hook.drain_tool_crashes() == []
        assert finals and finals[0][0] == "success"

    def test_tool_outcome_unknown_is_the_only_indeterminate(
        self, monkeypatch, fake_tool_result_event
    ):
        exc = ledger.ToolOutcomeError("5xx", side_effect="unknown", error_type="Http500")
        finals, run = _drive(_InnerRaises(exc), monkeypatch)
        with pytest.raises(ledger.ToolOutcomeError):
            asyncio.run(run())
        # Recorded as a crash (escaped the tool) -> node FAILS, and THIS is the
        # branch that marks the ledger indeterminate.
        assert tool_idempotency_hook.drain_tool_crashes()[0]["errorClass"] == "ToolOutcomeError"
        assert finals == [("failure", {"error_type": "Http500", "retryable": False, "outcome_indeterminate": True})]

    def test_tool_outcome_not_sent_releases_reservation(
        self, monkeypatch, fake_tool_result_event
    ):
        exc = ledger.ToolOutcomeError("conn refused", side_effect="not_sent", retryable=True)
        finals, run = _drive(_InnerRaises(exc), monkeypatch)
        with pytest.raises(ledger.ToolOutcomeError):
            asyncio.run(run())
        # not_sent -> reservation RELEASED (re-reservable), no in_flight leak.
        assert finals == [("release", {})]
        assert tool_idempotency_hook.drain_tool_crashes()[0]["retryable"] is True


class TestToolCrashEnvelope:
    def test_build_tool_crash_envelope_carries_marker_and_class(self):
        import agent_runner
        env = agent_runner.build_tool_crash_envelope(
            [{"errorClass": "RuntimeError", "error": "kaboom", "retryable": False}],
            [{"inputTokens": 3}],
        )
        assert env[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
        assert env[agent_runner.TOOL_CRASH_MARKER] is True
        assert env["errorClass"] == "RuntimeError"
        assert "kaboom" in env["error"]
        assert env["usage"] == [{"inputTokens": 3}]

    def test_crash_envelope_distinct_from_refusal_marker(self):
        import agent_runner
        env = agent_runner.build_tool_crash_envelope([{"errorClass": "X", "error": "y"}], [])
        assert agent_runner.GOVERNANCE_REFUSAL_MARKER not in env


class TestMainDrainsToolCrash:
    def test_completed_turn_with_recorded_crash_fails(self):
        import agent_runner
        import tool_idempotency_hook as hook
        hook.drain_tool_crashes()

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(
                "import tool_idempotency_hook as hook\n"
                "def handler(**kwargs):\n"
                "    hook._record_tool_crash(RuntimeError('tool blew up'))\n"
                "    return 'the agent finished its turn normally'\n"
            )
            module_path = f.name
        try:
            payload = json.dumps({"modulePath": module_path, "request": {}})
            fake_stdout = io.StringIO()
            with patch("sys.stdin") as mock_stdin, patch("sys.stdout", fake_stdout):
                mock_stdin.read.return_value = payload
                with pytest.raises(SystemExit) as excinfo:
                    agent_runner.main()
            assert excinfo.value.code != 0
            parsed = json.loads(fake_stdout.getvalue())
            assert parsed[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
            assert parsed[agent_runner.TOOL_CRASH_MARKER] is True
            assert parsed["errorClass"] == "RuntimeError"
            assert "response" not in parsed
        finally:
            os.unlink(module_path)
            hook.drain_tool_crashes()


class TestStructuralGuardCoversCrash:
    @pytest.mark.parametrize("returncode", [0, 1])
    @pytest.mark.parametrize("raise_on_error", [True, False])
    def test_crash_envelope_always_raises(self, returncode, raise_on_error):
        env = {
            "AGENT_CONFIG_TABLE": "t", "AGENT_BUCKET_NAME": "b",
            "COMPLETION_BUS_NAME": "c", "EXECUTIONS_TABLE": "e",
        }
        with patch.dict("os.environ", env):
            sys.modules.pop("index", None)
            import index
            stdout = json.dumps({
                "agentExecutionFailed": True, "toolExecutionCrashed": True,
                "errorClass": "RuntimeError", "error": "kaboom", "usage": [],
            })
            with pytest.raises(index.AgentExecutionError) as excinfo:
                index._interpret_agent_result(returncode, stdout, raise_on_error=raise_on_error)
        assert excinfo.value.error_class == "RuntimeError"
