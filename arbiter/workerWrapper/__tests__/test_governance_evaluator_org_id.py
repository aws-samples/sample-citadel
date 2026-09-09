"""Governance ledger SLICE 2 — GovernanceEvaluator (governance_tool_hook.py)
org_id stamping tests.

``GovernanceEvaluator.__init__`` already accepts ``org_id`` (threaded from
``CITADEL_ORG_ID`` / ``_resolve_execution_org_id`` — see agent_runner.py) and
already USES it for approval-scope gating (the (org, workflowDef, node,
tool) grant tuple). This slice threads the SAME already-available value onto
every finding the evaluator writes (deny-list PERMIT/DENY, and the
always-visible approval PERMIT/DENY findings) — it was previously computed
and stored but never passed to ``build_governance_finding`` /
``build_approval_finding``.

Uses plain duck-typed objects for the BeforeToolCallEvent seam (tool_use /
selected_tool attributes), same minimal-fake style as
test_governed_tool_handler_org_id.py, to avoid depending on the strands
runtime being importable.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governance_tool_hook import GovernanceEvaluator  # noqa: E402
from governance.models import ArbitrationDecision  # noqa: E402


class _FakeToolUse(dict):
    """Plain dict subclass — duck-typed as the strands ToolUse mapping."""


class _FakeEvent:
    def __init__(self, name: str, tool_use_id: str, selected_tool=object()):
        self.tool_use = _FakeToolUse({'name': name, 'toolUseId': tool_use_id})
        self.selected_tool = selected_tool


def test_evaluate_denylist_permit_finding_stamped_with_org_id():
    evaluator = GovernanceEvaluator(
        agent_id='agent-1', workflow_id='wf-1', denied_tools=set(),
        org_id='org-1',
    )
    with patch('governed_tool_handler.write_finding') as mock_write:
        outcome = evaluator.evaluate_denylist(_FakeEvent('safe_tool', 'tu-1'))

    assert outcome.refused is False
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.PERMIT
    assert written_finding.org_id == 'org-1'


def test_evaluate_denylist_deny_finding_stamped_with_org_id():
    evaluator = GovernanceEvaluator(
        agent_id='agent-1', workflow_id='wf-1', denied_tools={'bad_tool'},
        org_id='org-2',
    )
    with patch('governed_tool_handler.write_finding') as mock_write:
        outcome = evaluator.evaluate_denylist(_FakeEvent('bad_tool', 'tu-2'))

    assert outcome.refused is True
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.DENY
    assert written_finding.org_id == 'org-2'


def test_evaluate_denylist_finding_org_id_none_when_absent():
    """Default org_id ("") on GovernanceEvaluator normalises to None on the
    finding — never an empty-string placeholder standing in for
    'unavailable'."""
    evaluator = GovernanceEvaluator(
        agent_id='agent-1', workflow_id='wf-1', denied_tools=set(),
    )
    with patch('governed_tool_handler.write_finding') as mock_write:
        evaluator.evaluate_denylist(_FakeEvent('safe_tool', 'tu-3'))

    (written_finding,), _ = mock_write.call_args
    assert written_finding.org_id is None


def test_approval_refuse_finding_stamped_with_org_id_via_incomplete_context():
    """The fail-safe DENY branch (incomplete (org, workflowDef, node, exec)
    context) is deterministic without a real approval store — it is hit
    whenever ANY of the four scope fields is falsy. Drive it with org_id set
    but node_id/execution_id absent so `_refuse` -> `record_approval_finding`
    runs, and assert the written DENY finding carries org_id."""
    evaluator = GovernanceEvaluator(
        agent_id='agent-1', workflow_id='wf-1', denied_tools=set(),
        approval_required_tools={'gated_tool'},
        org_id='org-4', workflow_definition_id='wfdef-1',
        execution_id='', node_id='',
    )
    with patch('governed_tool_handler.write_finding') as mock_write:
        refused = evaluator._evaluate_approval(
            _FakeEvent('gated_tool', 'tu-5'), object(), 'gated_tool', 'tu-5',
        )
    assert refused is True
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.DENY
    assert written_finding.org_id == 'org-4'
