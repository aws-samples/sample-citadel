"""CIT-030/CIT-031 tests — REQUIRE_APPROVAL governance decision handling.

Covers:
  - REQUIRE_APPROVAL + APPROVAL_GATE_ENABLED → no tool execution,
    awaiting-approval signal recorded, tool swapped
  - REQUIRE_APPROVAL + flag off → treated as DENY (fail-closed)
  - PERMIT unchanged when no governance engine callback configured
  - PERMIT unchanged when engine returns PERMIT
  - Idempotency key preserved in the awaiting-approval signal
  - drain_awaiting_approval returns and clears the signal list
"""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

import pytest

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governance.models import ArbitrationDecision
from governed_tool_handler import (
    _AWAITING_APPROVAL,
    drain_awaiting_approval,
    record_awaiting_approval,
)
from governance_tool_hook import GovernanceEvaluator


def _make_event(tool_name='my_tool', tool_use_id='tu-1'):
    """Build a minimal BeforeToolCallEvent-like object."""
    selected = SimpleNamespace(tool_name=tool_name)
    return SimpleNamespace(
        tool_use={'name': tool_name, 'toolUseId': tool_use_id},
        selected_tool=selected,
    )


@pytest.fixture(autouse=True)
def _clear_awaiting():
    """Ensure the awaiting-approval signal list is clean between tests."""
    _AWAITING_APPROVAL.clear()
    yield
    _AWAITING_APPROVAL.clear()


class TestRequireApprovalGateEnabled:
    """APPROVAL_GATE_ENABLED=true + governance engine → REQUIRE_APPROVAL."""

    @patch.dict(os.environ, {'APPROVAL_GATE_ENABLED': 'true'})
    @patch('governed_tool_handler.write_finding')
    def test_tool_not_executed_and_signal_recorded(self, mock_write):
        """REQUIRE_APPROVAL → tool swapped (no execution), signal recorded."""
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
            execution_id='exec-1',
            node_id='node-1',
            governance_engine_decision_fn=lambda _: ArbitrationDecision.REQUIRE_APPROVAL,
        )
        event = _make_event('dangerous_tool', 'tu-42')
        refused = evaluator.evaluate(event)

        assert refused is True
        # Tool was swapped — original tool should not be used
        assert event.selected_tool.tool_name != 'dangerous_tool' or hasattr(event.selected_tool, '_error_result')
        # Awaiting-approval signal recorded
        signals = drain_awaiting_approval()
        assert len(signals) == 1
        assert signals[0]['toolName'] == 'dangerous_tool'
        assert signals[0]['executionId'] == 'exec-1'
        assert signals[0]['nodeId'] == 'node-1'

    @patch.dict(os.environ, {'APPROVAL_GATE_ENABLED': 'true'})
    @patch('governed_tool_handler.write_finding')
    def test_idempotency_key_preserved(self, mock_write):
        """The idempotency key in the signal contains execution/node/tool context."""
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
            execution_id='exec-99',
            node_id='node-7',
            governance_engine_decision_fn=lambda _: ArbitrationDecision.REQUIRE_APPROVAL,
        )
        event = _make_event('write_db', 'tu-123')
        evaluator.evaluate(event)

        signals = drain_awaiting_approval()
        assert len(signals) == 1
        key = signals[0]['idempotencyKey']
        assert 'exec-99' in key
        assert 'node-7' in key
        assert 'write_db' in key
        assert 'tu-123' in key


class TestRequireApprovalFlagOff:
    """APPROVAL_GATE_ENABLED unset/false + REQUIRE_APPROVAL → DENY fallback."""

    @patch.dict(os.environ, {}, clear=False)
    @patch('governed_tool_handler.write_finding')
    def test_require_approval_treated_as_deny_when_flag_off(self, mock_write):
        """Flag off: REQUIRE_APPROVAL falls back to DENY (fail-closed)."""
        os.environ.pop('APPROVAL_GATE_ENABLED', None)
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
            governance_engine_decision_fn=lambda _: ArbitrationDecision.REQUIRE_APPROVAL,
        )
        event = _make_event('dangerous_tool')
        refused = evaluator.evaluate(event)

        assert refused is True
        # No awaiting-approval signal — it's a plain deny
        assert drain_awaiting_approval() == []


class TestPermitUnchanged:
    """PERMIT behaviour unchanged with the new code paths."""

    @patch('governed_tool_handler.write_finding')
    def test_permit_when_no_engine_callback(self, mock_write):
        """No governance_engine_decision_fn → evaluate_require_approval is no-op."""
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
        )
        event = _make_event('safe_tool')
        refused = evaluator.evaluate(event)

        assert refused is False
        assert drain_awaiting_approval() == []

    @patch('governed_tool_handler.write_finding')
    def test_permit_when_engine_returns_permit(self, mock_write):
        """Engine returns PERMIT → no refusal, no signal."""
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
            governance_engine_decision_fn=lambda _: ArbitrationDecision.PERMIT,
        )
        event = _make_event('safe_tool')
        refused = evaluator.evaluate(event)

        assert refused is False
        assert drain_awaiting_approval() == []

    @patch('governed_tool_handler.write_finding')
    def test_deny_list_still_takes_precedence(self, mock_write):
        """A denied tool is denied even when the engine would say REQUIRE_APPROVAL."""
        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools={'blocked_tool'},
            governance_engine_decision_fn=lambda _: ArbitrationDecision.REQUIRE_APPROVAL,
        )
        event = _make_event('blocked_tool')
        refused = evaluator.evaluate(event)

        assert refused is True
        # It's a deny-list refusal, not an awaiting-approval signal
        assert drain_awaiting_approval() == []


class TestDrainAwaitingApproval:
    """drain_awaiting_approval() returns and clears the accumulator."""

    def test_drain_returns_and_clears(self):
        record_awaiting_approval('tool_a', 'reason_a', 'key_a')
        record_awaiting_approval('tool_b', 'reason_b', 'key_b')

        first = drain_awaiting_approval()
        assert len(first) == 2
        assert first[0]['toolName'] == 'tool_a'
        assert first[1]['toolName'] == 'tool_b'

        # Second drain returns empty
        assert drain_awaiting_approval() == []


class TestEngineCallbackFailure:
    """A failing governance engine callback → fail-closed (tool refused)."""

    @patch.dict(os.environ, {'APPROVAL_GATE_ENABLED': 'true'})
    @patch('governed_tool_handler.write_finding')
    def test_engine_exception_treated_as_refusal(self, mock_write):
        def failing_engine(tool_name):
            raise RuntimeError('engine down')

        evaluator = GovernanceEvaluator(
            agent_id='agent-1',
            workflow_id='wf-1',
            denied_tools=set(),
            governance_engine_decision_fn=failing_engine,
        )
        event = _make_event('some_tool')
        refused = evaluator.evaluate(event)

        assert refused is True
