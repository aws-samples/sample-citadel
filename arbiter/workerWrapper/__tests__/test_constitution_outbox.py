"""Constitution findings outbox.

The agent subprocess has no AWS credentials (``credentialMode: none``) or only
scoped STS credentials, so it cannot write the governance ledger. With
``CITADEL_GOVERNANCE_FINDINGS_OUTBOX`` set the gate appends each finding as a
JSON line to a private parent-created file instead of calling
``write_finding``; the parent drains the file with its own Lambda role after
the subprocess exits. Without the variable the gate keeps the direct,
fail-closed write.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from unittest.mock import MagicMock, patch

import pytest

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

from governance.ledger import LedgerWriteError  # noqa: E402
from governance.models import ArbitrationDecision, GovernanceFinding  # noqa: E402
from test_constitution_gate import _gate  # noqa: E402

import constitution_gate  # noqa: E402
from constitution_gate import (  # noqa: E402
    FINDINGS_OUTBOX_ENV,
    drain_findings_outbox,
    prepare_findings_outbox,
    remove_findings_outbox,
)
from test_workflow_node_dispatch import (  # noqa: E402
    NODE_MESSAGE,
    _NODE_ENV,
    _fresh_index,
)


def _no_aws_env(monkeypatch):
    for key in list(os.environ):
        if key.startswith('AWS_'):
            monkeypatch.delenv(key, raising=False)


def _credentialless_write(_finding):
    raise LedgerWriteError('Unable to locate credentials')


def _finding(decision=ArbitrationDecision.PERMIT, workflow_id='exec-1', **kw):
    return GovernanceFinding.create(
        workflow_id=workflow_id, decision=decision,
        requesting_agent='agent-1', target_agent='tool:good_tool',
        reason='r', scope_evaluated='worker-invoke-tool-all', **kw,
    )


def _outbox_line(finding) -> str:
    from governance.ledger import _serialize_finding
    return json.dumps(_serialize_finding(finding)) + '\n'


@pytest.fixture
def outbox(tmp_path, monkeypatch):
    path = tmp_path / 'findings.jsonl'
    path.write_text('')
    monkeypatch.setenv(FINDINGS_OUTBOX_ENV, str(path))
    return path


class TestChildWritesToOutbox:
    def test_permit_is_not_refused_without_aws_credentials(self, monkeypatch, outbox):
        _no_aws_env(monkeypatch)
        write = MagicMock(side_effect=_credentialless_write)
        gate = _gate(write_finding_fn=write)

        verdict = gate.evaluate('good_tool', 'tu-1', {'a': 1})

        assert verdict.refuse is False
        assert verdict.audit_write_failed is False
        assert verdict.decision == ArbitrationDecision.PERMIT
        write.assert_not_called()

    def test_finding_is_one_json_line_in_the_outbox(self, monkeypatch, outbox):
        _no_aws_env(monkeypatch)
        gate = _gate(write_finding_fn=MagicMock(side_effect=_credentialless_write))

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        lines = outbox.read_text().splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record['findingId'] == verdict.finding_id
        assert record['decision'] == 'permit'
        assert record['scope_evaluated'] == 'worker-invoke-tool-all'
        assert record['workflowId'] == 'exec-1'
        assert record['orgId'] == 'org-1'

    def test_each_evaluation_appends_a_line(self, outbox):
        gate = _gate()

        gate.evaluate('good_tool', 'tu-1', {})
        gate.evaluate('good_tool', 'tu-2', {})

        assert len(outbox.read_text().splitlines()) == 2

    def test_strict_mode_still_denies_in_the_child(self, outbox):
        gate = _gate(mode='strict', declared_tools=('good_tool',))

        verdict = gate.evaluate('other_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert verdict.audit_write_failed is False
        assert verdict.reason != 'constitution_finding_write_failed'
        record = json.loads(outbox.read_text().splitlines()[0])
        assert record['decision'] == 'deny'

    def test_shadow_mode_logs_and_proceeds_in_the_child(self, outbox):
        gate = _gate(mode='shadow', declared_tools=('good_tool',))

        verdict = gate.evaluate('other_tool', 'tu-1', {})

        assert verdict.refuse is False
        assert verdict.would_block is True
        assert len(outbox.read_text().splitlines()) == 1

    def test_unwritable_outbox_still_fails_closed(self, tmp_path, monkeypatch):
        monkeypatch.setenv(FINDINGS_OUTBOX_ENV, str(tmp_path / 'missing' / 'f.jsonl'))
        gate = _gate()

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert verdict.audit_write_failed is True
        assert verdict.reason == 'constitution_finding_write_failed'

    def test_outbox_absent_uses_direct_write_and_fails_closed(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock(side_effect=_credentialless_write)
        gate = _gate(write_finding_fn=write)

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        write.assert_called_once()
        assert verdict.refuse is True
        assert verdict.audit_write_failed is True
        assert verdict.reason == 'constitution_finding_write_failed'

    def test_outbox_absent_permit_calls_write_finding_once(self, monkeypatch):
        monkeypatch.delenv(FINDINGS_OUTBOX_ENV, raising=False)
        write = MagicMock()
        gate = _gate(write_finding_fn=write)

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        assert verdict.refuse is False
        write.assert_called_once()

    def test_gate_from_env_picks_up_the_outbox(self, monkeypatch, outbox):
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')

        gate = constitution_gate.build_constitution_gate_from_env('agent-1')

        assert gate is not None
        assert gate._findings_outbox == str(outbox)


class TestParentOutboxLifecycle:
    def test_prepare_creates_a_private_empty_file(self, tmp_path):
        path = prepare_findings_outbox(directory=str(tmp_path))

        assert path is not None
        assert os.path.dirname(path) == str(tmp_path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert os.path.getsize(path) == 0

    def test_remove_deletes_the_file_and_tolerates_missing(self, tmp_path):
        path = prepare_findings_outbox(directory=str(tmp_path))

        remove_findings_outbox(path)
        remove_findings_outbox(path)
        remove_findings_outbox(None)

        assert not os.path.exists(path)

    def test_build_subprocess_env_carries_the_outbox_path(self):
        from worker_governance import build_subprocess_env

        env = build_subprocess_env({}, governance_findings_outbox_path='/tmp/x.jsonl')

        assert env[FINDINGS_OUTBOX_ENV] == '/tmp/x.jsonl'

    def test_build_subprocess_env_omits_the_outbox_by_default(self):
        from worker_governance import build_subprocess_env

        assert FINDINGS_OUTBOX_ENV not in build_subprocess_env({})


class TestParentDrain:
    def _write(self, tmp_path, findings):
        path = tmp_path / 'out.jsonl'
        path.write_text(''.join(_outbox_line(f) for f in findings))
        return str(path)

    def test_writes_every_line_once_with_the_ledger_writer(self, tmp_path):
        a, b = _finding(), _finding(ArbitrationDecision.DENY)
        write = MagicMock()

        result = drain_findings_outbox(
            self._write(tmp_path, [a, b]), write_finding_fn=write,
        )

        assert write.call_count == 2
        written = [c.args[0] for c in write.call_args_list]
        assert [w.finding_id for w in written] == [a.finding_id, b.finding_id]
        assert written[0].decision == ArbitrationDecision.PERMIT
        assert written[1].decision == ArbitrationDecision.DENY
        assert written[0].scope_evaluated == 'worker-invoke-tool-all'
        assert result.written == 2
        assert result.failed == 0
        assert result.permit_failures == []

    def test_defaults_to_governance_ledger_write_finding(self, tmp_path):
        with patch.object(constitution_gate, 'write_finding') as write:
            drain_findings_outbox(self._write(tmp_path, [_finding()]))

        write.assert_called_once()

    def test_failed_permit_write_is_reported_and_others_still_written(self, tmp_path):
        a, b = _finding(), _finding()
        write = MagicMock(side_effect=[LedgerWriteError('ddb down'), None])

        result = drain_findings_outbox(
            self._write(tmp_path, [a, b]), write_finding_fn=write,
        )

        assert write.call_count == 2
        assert result.written == 1
        assert result.failed == 1
        assert result.permit_failures == [a.finding_id]

    def test_failed_non_permit_write_is_not_a_permit_failure(self, tmp_path):
        write = MagicMock(side_effect=LedgerWriteError('ddb down'))

        result = drain_findings_outbox(
            self._write(tmp_path, [_finding(ArbitrationDecision.DENY)]),
            write_finding_fn=write,
        )

        assert result.failed == 1
        assert result.permit_failures == []

    def test_malformed_line_is_counted_and_does_not_stop_the_drain(self, tmp_path):
        path = tmp_path / 'out.jsonl'
        path.write_text('not json\n' + _outbox_line(_finding()))
        write = MagicMock()

        result = drain_findings_outbox(str(path), write_finding_fn=write)

        write.assert_called_once()
        assert result.written == 1
        assert result.failed == 1

    def test_line_for_another_workflow_is_rejected(self, tmp_path):
        write = MagicMock()

        result = drain_findings_outbox(
            self._write(tmp_path, [_finding(workflow_id='someone-else')]),
            expected_workflow_id='exec-1', write_finding_fn=write,
        )

        write.assert_not_called()
        assert result.failed == 1

    def test_empty_or_missing_outbox_writes_nothing(self, tmp_path):
        write = MagicMock()
        empty = tmp_path / 'empty.jsonl'
        empty.write_text('')

        assert drain_findings_outbox(str(empty), write_finding_fn=write).written == 0
        assert drain_findings_outbox(
            str(tmp_path / 'gone.jsonl'), write_finding_fn=write,
        ).written == 0
        write.assert_not_called()


class TestWorkerIndexDrain:
    """index wires the outbox around the subprocess: create inside the
    try/finally, drain after exit (success or failure), always remove, and
    surface a failed PERMIT write through the existing node-failure path."""

    def _dispatch(self, run_side_effect, drain_write, events):
        captured = {}

        def fake_run(request, creds, extra_env, **kwargs):
            captured['path'] = extra_env.get(FINDINGS_OUTBOX_ENV)
            captured['mode'] = stat.S_IMODE(os.stat(captured['path']).st_mode)
            with open(captured['path'], 'a') as fh:
                fh.write(_outbox_line(_finding()))
            return run_side_effect()

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py', 'credentialMode': 'none'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(constitution_gate, 'write_finding', drain_write), \
                     patch.object(index, 'run_agent_in_subprocess', side_effect=fake_run):
                    index.process_event(dict(NODE_MESSAGE), {})
        return captured

    @staticmethod
    def _events():
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}
        return events

    @staticmethod
    def _detail_type(events):
        return events.put_events.call_args.kwargs['Entries'][0]['DetailType']

    def test_outbox_is_private_drained_once_and_removed_on_success(self):
        events, write = self._events(), MagicMock()

        captured = self._dispatch(lambda: 'done', write, events)

        assert captured['mode'] == 0o600
        write.assert_called_once()
        assert not os.path.exists(captured['path'])
        assert self._detail_type(events) == 'workflow.node.completed'

    def test_outbox_is_drained_and_removed_when_the_subprocess_fails(self):
        events, write = self._events(), MagicMock()

        def boom():
            raise RuntimeError('agent crashed')

        captured = self._dispatch(boom, write, events)

        write.assert_called_once()
        assert not os.path.exists(captured['path'])
        assert self._detail_type(events) == 'workflow.node.failed'

    def test_failed_permit_write_fails_the_node_as_audit_write_failed(self):
        events = self._events()
        write = MagicMock(side_effect=LedgerWriteError('ddb down'))

        captured = self._dispatch(lambda: 'done', write, events)

        assert not os.path.exists(captured['path'])
        entry = events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.failed'
        assert json.loads(entry['Detail'])['error'] == 'LedgerWriteError'

    def test_failed_non_permit_write_does_not_fail_a_completed_node(self):
        events = self._events()
        write = MagicMock(side_effect=LedgerWriteError('ddb down'))

        def run_deny():
            return 'done'

        with patch.object(
            sys.modules[__name__], '_finding',
            lambda *a, **k: GovernanceFinding.create(
                workflow_id='exec-1', decision=ArbitrationDecision.DENY,
                requesting_agent='agent-1', target_agent='tool:x', reason='r',
            ),
        ):
            self._dispatch(run_deny, write, events)

        assert self._detail_type(events) == 'workflow.node.completed'
