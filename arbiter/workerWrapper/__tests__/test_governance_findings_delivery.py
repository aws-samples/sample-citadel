"""Every child-side governance finding is delivered through the parent outbox.

The agent subprocess of a ``credentialMode: none`` node has no AWS
credentials, so a direct ``write_finding`` there raises ``LedgerWriteError``
("Unable to locate credentials"), the tool is refused and the node fails.
With ``CITADEL_GOVERNANCE_FINDINGS_OUTBOX`` set, ``deliver_finding`` appends
the finding as one JSON line for the parent to write with its Lambda role.
Without the variable the direct write is kept (tests, supervisor paths).
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock

import pytest

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

import constitution_gate  # noqa: E402
import governed_tool_handler  # noqa: E402
import tool_breaker_hook  # noqa: E402
from constitution_gate import (  # noqa: E402
    FINDINGS_OUTBOX_ENV,
    deliver_finding,
    drain_findings_outbox,
)
from governance.ledger import LedgerWriteError  # noqa: E402
from governance.models import ArbitrationDecision, GovernanceFinding  # noqa: E402
from governed_tool_handler import (  # noqa: E402
    record_approval_finding,
    record_governance_decision,
)


def _no_aws_env(monkeypatch):
    for key in list(os.environ):
        if key.startswith('AWS_'):
            monkeypatch.delenv(key, raising=False)


def _credentialless_write(_finding):
    raise LedgerWriteError('Unable to locate credentials')


@pytest.fixture
def child(tmp_path, monkeypatch):
    """A credential-less child: no AWS_* env, outbox set, direct writes fail."""
    _no_aws_env(monkeypatch)
    path = tmp_path / 'findings.jsonl'
    path.write_text('')
    monkeypatch.setenv(FINDINGS_OUTBOX_ENV, str(path))
    monkeypatch.setattr(governed_tool_handler, 'write_finding', _credentialless_write)
    monkeypatch.setattr(constitution_gate, 'write_finding', _credentialless_write)
    monkeypatch.setattr('governance.ledger.write_finding', _credentialless_write)
    return path


def _lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _finding(decision=ArbitrationDecision.PERMIT):
    return GovernanceFinding.create(
        workflow_id='exec-1', decision=decision, requesting_agent='agent-1',
        target_agent='tool:good_tool', reason='r',
    )


class TestDeliverFinding:
    def test_appends_one_json_line_when_outbox_is_set(self, child):
        finding = _finding()

        deliver_finding(finding)

        (record,) = _lines(child)
        assert record['findingId'] == finding.finding_id
        assert record['decision'] == 'permit'

    def test_uses_the_direct_write_when_outbox_is_absent(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock()
        finding = _finding()

        deliver_finding(finding, write_fn=write)

        write.assert_called_once_with(finding)

    def test_default_direct_write_is_the_ledger_write_finding(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock()
        monkeypatch.setattr(constitution_gate, 'write_finding', write)

        deliver_finding(_finding())

        write.assert_called_once()

    def test_unwritable_outbox_raises_ledger_write_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv(FINDINGS_OUTBOX_ENV, str(tmp_path / 'missing' / 'f.jsonl'))
        write = MagicMock()

        with pytest.raises(LedgerWriteError):
            deliver_finding(_finding(), write_fn=write)

        write.assert_not_called()


class TestChildDecisionWithoutCredentials:
    def test_permitted_tool_is_permitted_and_queued(self, child):
        blocked, result = record_governance_decision(
            'good_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(),
        )

        assert (blocked, result) == (False, None)
        (record,) = _lines(child)
        assert record['decision'] == 'permit'
        assert record['workflowId'] == 'exec-1'

    def test_denied_tool_is_denied_and_queued(self, child):
        blocked, result = record_governance_decision(
            'bad_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools={'bad_tool'},
        )

        assert blocked is True
        assert result is not None
        (record,) = _lines(child)
        assert record['decision'] == 'deny'

    def test_approval_finding_is_queued_without_raising(self, child):
        record_approval_finding(
            'good_tool', True, 'approval_consumed',
            agent_id='agent-1', workflow_id='exec-1',
        )

        (record,) = _lines(child)
        assert record['decision'] == 'permit'
        assert record['workflowId'] == 'exec-1'

    def test_refused_approval_finding_is_queued_as_deny(self, child):
        record_approval_finding(
            'good_tool', False, 'approval_required',
            agent_id='agent-1', workflow_id='exec-1',
        )

        (record,) = _lines(child)
        assert record['decision'] == 'deny'

    def test_tool_breaker_transition_finding_is_queued(self, child):
        t = MagicMock()
        t.to_state = 'OPEN'
        t.from_state = 'CLOSED'
        t.state_version = 1
        t.target.kind = 'tool'
        t.target.target_id = 'good_tool'

        tool_breaker_hook._emit_finding(
            t, org_id='org-1', workflow_id='exec-1', agent_id='agent-1',
            eval_run_id=None,
        )

        (record,) = _lines(child)
        assert record['decision'] == 'deny'
        assert record['workflowId'] == 'exec-1'

    def test_unwritable_outbox_refuses_the_tool_fail_closed(
        self, tmp_path, monkeypatch,
    ):
        monkeypatch.setenv(FINDINGS_OUTBOX_ENV, str(tmp_path / 'missing' / 'f.jsonl'))
        refusals = []
        monkeypatch.setattr(
            governed_tool_handler, '_record_audit_write_refusal', refusals.append,
        )

        blocked, result = record_governance_decision(
            'good_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(),
        )

        assert blocked is True
        assert result is not None
        assert len(refusals) == 1


class TestChildWithoutOutboxKeepsDirectWrite:
    def test_decision_calls_module_write_finding_once(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock()
        monkeypatch.setattr(governed_tool_handler, 'write_finding', write)

        blocked, _ = record_governance_decision(
            'good_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(),
        )

        assert blocked is False
        write.assert_called_once()

    def test_approval_calls_module_write_finding_once(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock()
        monkeypatch.setattr(governed_tool_handler, 'write_finding', write)

        record_approval_finding(
            'good_tool', True, 'approval_consumed',
            agent_id='agent-1', workflow_id='exec-1',
        )

        write.assert_called_once()

    def test_direct_write_failure_still_fails_closed(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        monkeypatch.setattr(governed_tool_handler, 'write_finding', _credentialless_write)
        monkeypatch.setattr(
            governed_tool_handler, '_record_audit_write_refusal', lambda exc: None,
        )

        blocked, result = record_governance_decision(
            'good_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(),
        )

        assert blocked is True
        assert result is not None


class TestParentDrainsEveryQueuedFinding:
    def test_each_queued_finding_is_written_once(self, child):
        record_governance_decision(
            'good_tool', 'tu-1', agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(),
        )
        record_approval_finding(
            'good_tool', True, 'approval_consumed',
            agent_id='agent-1', workflow_id='exec-1',
        )
        record_governance_decision(
            'bad_tool', 'tu-2', agent_id='agent-1', workflow_id='exec-1',
            denied_tools={'bad_tool'},
        )
        write = MagicMock()

        result = drain_findings_outbox(
            str(child), expected_workflow_id='exec-1', write_finding_fn=write,
        )

        assert write.call_count == 3
        assert [c.args[0].decision for c in write.call_args_list] == [
            ArbitrationDecision.PERMIT,
            ArbitrationDecision.PERMIT,
            ArbitrationDecision.DENY,
        ]
        assert (result.written, result.failed, result.permit_failures) == (3, 0, [])
