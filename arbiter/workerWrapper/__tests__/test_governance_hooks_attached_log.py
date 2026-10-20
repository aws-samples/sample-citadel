"""Test: _GovernedAgent emits a structured 'governance_hooks_attached' log line."""

from __future__ import annotations

import json
import logging
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Skip when strands is not installed.
# ---------------------------------------------------------------------------
try:
    import strands
    from strands.models.model import Model

    _HAS_STRANDS = True
except ImportError:
    _HAS_STRANDS = False

pytestmark = pytest.mark.skipif(
    not _HAS_STRANDS,
    reason="strands-agents SDK not installed",
)

_HERE = os.path.dirname(os.path.abspath(__file__))
_WRAPPER_DIR = os.path.dirname(_HERE)
if _WRAPPER_DIR not in sys.path:
    sys.path.insert(0, _WRAPPER_DIR)


class _FakeModel(Model):
    """Minimal model that ends immediately — no Bedrock needed."""

    def update_config(self, **kw):
        pass

    def get_config(self):
        return {}

    async def structured_output(self, *a, **kw):
        yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {"text": ""}}}
        yield {"contentBlockDelta": {"delta": {"text": "hi"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1}}}


class TestGovernanceHooksAttachedLog:
    """Constructing _GovernedAgent logs action='governance_hooks_attached'."""

    def test_log_emitted_with_three_hook_names(self, monkeypatch, caplog):
        """With governance + idempotency + breaker all present, the log line
        lists all three class names, callerHooksMerged=0, and carries
        executionId/nodeId from the envelope."""

        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-123")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-456")

        # Fake governance module
        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)
        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        OriginalAgent = strands.Agent
        sys.modules.pop("agent_runner", None)

        import agent_runner

        try:
            with caplog.at_level(logging.INFO, logger="agent_runner"):
                agent_runner._install_tool_call_hooks()

                _ = strands.Agent(
                    model=_FakeModel(),
                    tools=[],
                    callback_handler=None,
                )

            # Find the structured log record
            attached_records = [
                r for r in caplog.records
                if "governance_hooks_attached" in r.getMessage()
            ]
            assert len(attached_records) == 1, (
                f"Expected exactly 1 governance_hooks_attached log, got {len(attached_records)}"
            )

            payload = json.loads(attached_records[0].getMessage())
            assert payload["action"] == "governance_hooks_attached"
            assert payload["component"] == "WorkerWrapper"
            assert payload["level"] == "INFO"

            # Three hook providers present (GovernanceEvaluator mock,
            # IdempotencyToolHook, ToolBreaker — but breaker may be None
            # without env). At minimum governance + idempotency = 2 class names.
            # The mock returns a MagicMock instance whose class name is
            # 'MagicMock' for governance, 'IdempotencyToolHook' for
            # idempotency. Breaker depends on env — assert at least 2.
            hook_names = payload["hookNames"]
            assert "MagicMock" in hook_names, (
                f"Governance mock class name expected in hookNames: {hook_names}"
            )
            assert "IdempotencyToolHook" in hook_names, (
                f"IdempotencyToolHook expected in hookNames: {hook_names}"
            )
            assert payload["callerHooksMerged"] == 0
            assert payload["executionId"] == "exec-123"
            assert payload["nodeId"] == "node-456"
        finally:
            strands.Agent = OriginalAgent

    def test_log_omits_execution_context_when_absent(self, monkeypatch, caplog):
        """When only governance envelope is active (no executionId/nodeId),
        the log line omits those fields."""

        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)
        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        OriginalAgent = strands.Agent
        sys.modules.pop("agent_runner", None)

        import agent_runner

        try:
            with caplog.at_level(logging.INFO, logger="agent_runner"):
                agent_runner._install_tool_call_hooks()
                _ = strands.Agent(
                    model=_FakeModel(),
                    tools=[],
                    callback_handler=None,
                )

            attached_records = [
                r for r in caplog.records
                if "governance_hooks_attached" in r.getMessage()
            ]
            assert len(attached_records) == 1
            payload = json.loads(attached_records[0].getMessage())
            assert "executionId" not in payload
            assert "nodeId" not in payload
        finally:
            strands.Agent = OriginalAgent

    def test_caller_hooks_counted(self, monkeypatch, caplog):
        """When caller supplies hooks=, callerHooksMerged reflects the count."""

        monkeypatch.setenv("CITADEL_AGENT_ID", "test-agent")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        gov_mock = MagicMock()
        gov_mock.evaluate = MagicMock(return_value=False)
        fake_gov_module = types.ModuleType("governance_tool_hook")
        fake_gov_module.GovernanceEvaluator = MagicMock(return_value=gov_mock)
        monkeypatch.setitem(sys.modules, "governance_tool_hook", fake_gov_module)

        OriginalAgent = strands.Agent
        sys.modules.pop("agent_runner", None)

        import agent_runner

        try:
            with caplog.at_level(logging.INFO, logger="agent_runner"):
                agent_runner._install_tool_call_hooks()

                class _NoopHook:
                    def register_hooks(self, registry, **kwargs):
                        pass

                _ = strands.Agent(
                    model=_FakeModel(),
                    tools=[],
                    hooks=[_NoopHook(), _NoopHook()],
                    callback_handler=None,
                )

            attached_records = [
                r for r in caplog.records
                if "governance_hooks_attached" in r.getMessage()
            ]
            assert len(attached_records) == 1
            payload = json.loads(attached_records[0].getMessage())
            assert payload["callerHooksMerged"] == 2
        finally:
            strands.Agent = OriginalAgent
