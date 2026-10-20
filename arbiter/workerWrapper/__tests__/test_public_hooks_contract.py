"""Contract tests: governance hooks via public ``hooks`` kwarg on real strands SDK.

These tests run against the REAL strands-agents SDK (1.59+) to verify that
the agent_runner's _GovernedAgent subclass correctly injects governance,
idempotency, and breaker hooks through the SDK's public ``hooks`` parameter,
and that BeforeToolCallEvent is dispatched to those hooks when a tool call
occurs.

Run with the strands venv:
    /tmp/strands-venv/bin/python -m pytest \\
        arbiter/workerWrapper/__tests__/test_public_hooks_contract.py -v

Skip marker: tests are skipped when strands is not installed (e.g. the
system-Python test runner).
"""

from __future__ import annotations

import os
import sys

import pytest

# ---------------------------------------------------------------------------
# Skip the entire module when strands is not installed.
# ---------------------------------------------------------------------------
try:
    import strands
    from strands.hooks import BeforeToolCallEvent
    from strands.models.model import Model
    _HAS_STRANDS = True
except ImportError:
    _HAS_STRANDS = False

pytestmark = pytest.mark.skipif(
    not _HAS_STRANDS,
    reason="strands-agents SDK not installed — run with /tmp/strands-venv/bin/python",
)

# Put the workerWrapper dir on the path so agent_runner can be imported.
_HERE = os.path.dirname(os.path.abspath(__file__))
_WRAPPER_DIR = os.path.dirname(_HERE)
if _WRAPPER_DIR not in sys.path:
    sys.path.insert(0, _WRAPPER_DIR)


# ---------------------------------------------------------------------------
# Fake model: yields one tool-call turn then a final text turn, no Bedrock.
# ---------------------------------------------------------------------------
class _FakeModel(Model):
    """Minimal Model that requests a single tool call then finishes."""

    def __init__(self):
        self._calls = 0

    def update_config(self, **kw):
        pass

    def get_config(self):
        return {}

    async def structured_output(self, *a, **kw):
        yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self._calls += 1
        if self._calls == 1:
            # First turn: request a tool call
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {"toolUse": {
                "toolUseId": "call-1", "name": "greet",
            }}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {
                "input": '{"name": "world"}',
            }}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}}
        else:
            # Second turn: final text response
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {"text": ""}}}
            yield {"contentBlockDelta": {"delta": {"text": "done"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}}


# ---------------------------------------------------------------------------
# A trivial strands tool for the agent to call.
# ---------------------------------------------------------------------------
@strands.tool
def greet(name: str) -> str:
    """Greet someone by name."""
    return f"hello {name}"


# ---------------------------------------------------------------------------
# Recording hook: a HookProvider that logs every BeforeToolCallEvent it sees.
# ---------------------------------------------------------------------------
class _RecordingHook:
    """HookProvider that records every BeforeToolCallEvent it receives."""

    def __init__(self):
        self.events: list = []

    def register_hooks(self, registry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event):
        self.events.append(event)


# ---------------------------------------------------------------------------
# Contract tests
# ---------------------------------------------------------------------------


class TestPublicHooksContract:
    """Verify that _GovernedAgent injects hooks through the public SDK API."""

    def test_hooks_receive_before_tool_call_event(self):
        """Construct a real strands.Agent with the ComposedToolHook injected
        via the public ``hooks`` kwarg and verify the composed hook's
        governance evaluator is invoked on BeforeToolCallEvent for a tool
        call — proving the public API path works end to end."""
        from tool_idempotency_hook import ComposedToolHook
        from unittest.mock import MagicMock

        # A mock governance evaluator that permits all tools
        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)  # False = permit

        composed = ComposedToolHook(
            governance=gov_mock,
            idempotency=None,
            breaker=None,
        )

        # Construct an Agent with the composed hook injected via hooks= kwarg
        agent = strands.Agent(
            model=_FakeModel(),
            tools=[greet],
            hooks=[composed],
            callback_handler=None,
        )

        result = agent("call greet with name world")

        # The governance evaluator should have been called with a
        # BeforeToolCallEvent when the tool call was dispatched.
        assert gov_mock.evaluate.called, (
            "Governance evaluator should have been called on tool use"
        )
        event = gov_mock.evaluate.call_args[0][0]
        assert type(event).__name__ == "BeforeToolCallEvent"

    def test_governed_agent_subclass_injects_hooks(self, monkeypatch):
        """_install_tool_call_hooks creates a _GovernedAgent subclass of
        strands.Agent that passes hooks to super().__init__(). Verify with
        the real SDK that the injected hook receives BeforeToolCallEvent."""

        # Activate the governance envelope
        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        # We need to re-import agent_runner fresh so _install_tool_call_hooks
        # sees the real strands module. But _install_tool_call_hooks also
        # imports governance_tool_hook, which needs governance infra. We'll
        # mock just the governance module to avoid needing DynamoDB etc.
        import types
        from unittest.mock import MagicMock

        # Create a minimal GovernanceEvaluator mock
        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)  # permit all

        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        # ComposedToolHook needs to be importable from tool_idempotency_hook
        # (it already is via sys.path setup above)

        # Capture the original Agent class before install
        OriginalAgent = strands.Agent

        sys.modules.pop("agent_runner", None)
        import agent_runner

        try:
            installed = agent_runner._install_tool_call_hooks()
            assert installed is True

            # strands.Agent should now be the _GovernedAgent subclass
            assert strands.Agent is not OriginalAgent
            assert issubclass(strands.Agent, OriginalAgent)

            # Construct an agent through the governed subclass
            agent = strands.Agent(
                model=_FakeModel(),
                tools=[greet],
                callback_handler=None,
            )

            # Verify the hooks registry has callbacks (the composed hook
            # was injected)
            assert agent.hooks.has_callbacks()

            # Run the agent — this triggers BeforeToolCallEvent
            result = agent("call greet")

            # The governance evaluator mock should have been called
            assert gov_mock.evaluate.called or gov_mock.evaluate_denylist.called, (
                "Governance evaluator should have been called on tool use"
            )
        finally:
            # Restore original Agent class
            strands.Agent = OriginalAgent

    def test_caller_hooks_preserved_with_real_sdk(self, monkeypatch):
        """When customer code passes hooks=, the _GovernedAgent subclass
        APPENDS our hook and preserves the caller's."""

        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        import types
        from unittest.mock import MagicMock

        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)

        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        OriginalAgent = strands.Agent

        sys.modules.pop("agent_runner", None)
        import agent_runner

        try:
            agent_runner._install_tool_call_hooks()

            # A caller-provided hook
            caller_hook = _RecordingHook()

            agent = strands.Agent(
                model=_FakeModel(),
                tools=[greet],
                hooks=[caller_hook],
                callback_handler=None,
            )

            result = agent("call greet")

            # The caller's hook should have received the BeforeToolCallEvent
            assert len(caller_hook.events) >= 1, (
                f"Caller hook should receive BeforeToolCallEvent, got {len(caller_hook.events)} events"
            )
            assert type(caller_hook.events[0]).__name__ == "BeforeToolCallEvent"
        finally:
            strands.Agent = OriginalAgent

    def test_model_override_with_real_sdk(self, monkeypatch):
        """MODEL_OVERRIDE env var forces BedrockModel.model_id through the
        __init__ patch, verified against the real SDK class."""
        from strands.models import BedrockModel

        monkeypatch.setenv("MODEL_OVERRIDE", "us.test.override-model")

        original_init = BedrockModel.__init__

        sys.modules.pop("agent_runner", None)
        import agent_runner

        try:
            installed = agent_runner._install_model_override()
            assert installed is True

            # BedrockModel.__init__ should now force model_id. We can't
            # actually construct a BedrockModel without AWS credentials, but
            # we can verify the patch is installed by checking __init__ was
            # replaced.
            assert BedrockModel.__init__ is not original_init
        finally:
            BedrockModel.__init__ = original_init

    def test_isinstance_preserved_with_governed_subclass(self, monkeypatch):
        """Instances created through _GovernedAgent are still isinstance of
        the original strands.Agent — important for code that type-checks."""

        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        import types
        from unittest.mock import MagicMock

        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)

        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        OriginalAgent = strands.Agent

        sys.modules.pop("agent_runner", None)
        import agent_runner

        try:
            agent_runner._install_tool_call_hooks()

            agent = strands.Agent(
                model=_FakeModel(),
                tools=[greet],
                callback_handler=None,
            )

            # The governed agent is an instance of the original Agent
            assert isinstance(agent, OriginalAgent), (
                "_GovernedAgent instances must pass isinstance(obj, Agent)"
            )
        finally:
            strands.Agent = OriginalAgent
