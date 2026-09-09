"""Governance ledger SLICE 2 — GovernedToolHandler org_id stamping tests.

Mirrors test_governed_tool_handler_eval_run_id.py's structure. org_id here
comes from the SAME server-resolved source already threaded to this worker
subprocess for the live BeforeToolCallEvent seam (governance_tool_hook.py's
GovernanceToolHook, whose __init__ already accepts org_id sourced from
CITADEL_ORG_ID / _resolve_execution_org_id) — this test file extends the
legacy GovernedToolHandler seam (and the shared build_governance_finding /
build_approval_finding / record_governance_decision helpers both seams call
through) with the same optional, additive, never-gates-decision org_id
parameter.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governed_tool_handler import (  # noqa: E402
    GovernedToolHandler,
    build_approval_finding,
    build_governance_finding,
    record_governance_decision,
)
from governance.models import ArbitrationDecision  # noqa: E402


def test_ctor_defaults_org_id_to_none():
    handler = GovernedToolHandler(denied_tools=set())
    assert handler.org_id is None


def test_deny_finding_stamped_with_org_id_when_present():
    handler = GovernedToolHandler(
        agent_id='agent-42',
        workflow_id='wf-123',
        denied_tools={'dangerous_tool'},
        org_id='org-99',
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': 'dangerous_tool', 'toolUseId': 'tu-1'})

    assert isinstance(result, dict)
    assert result['status'] == 'error'
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.DENY
    assert written_finding.org_id == 'org-99'


def test_permit_finding_stamped_with_org_id_when_present():
    handler = GovernedToolHandler(
        agent_id='agent-a', workflow_id='wf-b', denied_tools=set(),
        org_id='org-100',
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': 'safe_tool'})

    assert result is None
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.PERMIT
    assert written_finding.org_id == 'org-100'


def test_finding_org_id_none_when_absent():
    """No org context available at this write site (e.g. a
    platform-internal invocation): finding.org_id stays None — byte
    -identical to pre-slice-2 behavior. Never defaulted to a placeholder."""
    handler = GovernedToolHandler(denied_tools={'blocked'})

    with patch('governed_tool_handler.write_finding') as mock_write:
        handler.preprocess({'name': 'blocked', 'toolUseId': 'tu-x'})

    (written_finding,), _ = mock_write.call_args
    assert written_finding.org_id is None


def test_build_governance_finding_accepts_org_id_kwarg():
    finding = build_governance_finding(
        'tool-a', denied=False, agent_id='a', workflow_id='w', org_id='org-1',
    )
    assert finding.org_id == 'org-1'


def test_build_governance_finding_org_id_defaults_to_none():
    finding = build_governance_finding(
        'tool-a', denied=False, agent_id='a', workflow_id='w',
    )
    assert finding.org_id is None


def test_build_approval_finding_accepts_org_id_kwarg():
    finding = build_approval_finding(
        'tool-a', permitted=True, reason_code='approval_consumed',
        agent_id='a', workflow_id='w', org_id='org-2',
    )
    assert finding.org_id == 'org-2'


def test_build_approval_finding_org_id_defaults_to_none():
    finding = build_approval_finding(
        'tool-a', permitted=True, reason_code='approval_consumed',
        agent_id='a', workflow_id='w',
    )
    assert finding.org_id is None


def test_record_governance_decision_threads_org_id():
    with patch('governed_tool_handler.write_finding') as mock_write:
        record_governance_decision(
            'tool-a', 'tu-1',
            agent_id='a', workflow_id='w', denied_tools=set(),
            org_id='org-3',
        )
    (written_finding,), _ = mock_write.call_args
    assert written_finding.org_id == 'org-3'
