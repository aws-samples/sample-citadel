"""Gate-level (dispatch-path) verification of PR-4 fail-closed credentialing.

Exercises the two REAL worker dispatch paths — ``_process_workflow_node`` via
``process_event`` (workflow-node message) and the supervisor task path via
``process_event`` (legacy message) — rather than the helper functions in
isolation, and asserts the externally observable outcome on every refusal:

* ``subprocess.run`` is NEVER called (no agent subprocess spawned);
* a governance ledger finding is written (``governance.ledger.write_finding``);
* workflow path: a ``workflow.node.failed`` event with ``error ==
  'CredentialRefusal'`` is emitted;
* supervisor path: ``post_task_complete`` is called with a refusal message and
  ``CredentialRefusal`` propagates to ``lambda_handler`` which acks (does NOT
  add the record to ``batchItemFailures``).

Also a regression guard that, with vending unavailable and NO sentinel, the
child environment is never built with ambient AWS credentials (the deleted
ambient-inherit branch stays deleted).

All AWS (boto3, subprocess) is mocked; no network.
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import credential_guard as cg  # noqa: E402


NODE_MESSAGE = {
    'message_type': 'workflow_node',
    'execution_id': 'exec-1',
    'node_id': 'n0',
    'workflow_id': 'wf-1',
    'agent_id': 'agent-A',
    'input': {'taskDetails': 'do the thing'},
    'configuration': {},
}

SUPERVISOR_MESSAGE = {
    'orchestration_id': 'orch-1',
    'agent_use_id': 'use-1',
    'agent_input': {'taskDetails': 'do the thing'},
    'node': 'agent-A',
}

_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'CREDENTIAL_VENDER_FUNCTION': 'test-vender',
    'AWS_ACCESS_KEY_ID': 'AMBIENT-KEY',
    'AWS_SECRET_ACCESS_KEY': 'AMBIENT-SECRET',
    'AWS_SESSION_TOKEN': 'AMBIENT-TOKEN',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _node_failed_entries(mock_events):
    out = []
    for call in mock_events.put_events.call_args_list:
        for entry in call.kwargs['Entries']:
            if entry.get('DetailType') == 'workflow.node.failed':
                out.append(json.loads(entry['Detail']))
    return out


class TestWorkflowNodeGate:
    def _run(self, config, scoped_side_effect=None, scoped_return=None):
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': config}), \
                     patch.object(index, 'load_file_from_s3_into_tmp') as mock_s3, \
                     patch.object(index, '_write_credential_refusal_finding') as mock_ledger, \
                     patch('subprocess.run') as mock_run:
                    if scoped_side_effect is not None:
                        ctx = patch.object(index, 'get_scoped_credentials',
                                           side_effect=scoped_side_effect)
                    else:
                        ctx = patch.object(index, 'get_scoped_credentials',
                                           return_value=scoped_return)
                    with ctx:
                        index.process_event(dict(NODE_MESSAGE), {})
        return mock_events, mock_run, mock_ledger, mock_s3

    def test_absent_permissions_refused_no_spawn_failed_event_ledger(self):
        mock_events, mock_run, mock_ledger, mock_s3 = self._run({'filename': 'agent.py'})
        mock_run.assert_not_called()
        mock_s3.assert_not_called()  # refused before any further dispatch work
        mock_ledger.assert_called_once()
        assert mock_ledger.call_args.kwargs['reason'] == cg.NO_REQUIRED_PERMISSIONS
        failed = _node_failed_entries(mock_events)
        assert len(failed) == 1
        assert failed[0]['status'] == 'failed'
        assert failed[0]['error'] == 'CredentialRefusal'

    def test_empty_permissions_refused(self):
        mock_events, mock_run, mock_ledger, _ = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': [], 'dataStores': []}})
        mock_run.assert_not_called()
        mock_ledger.assert_called_once()
        assert _node_failed_entries(mock_events)[0]['error'] == 'CredentialRefusal'

    def test_vend_failure_refused_no_spawn_failed_event(self):
        mock_events, mock_run, mock_ledger, mock_s3 = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': ['int-1']}},
            scoped_side_effect=cg.CredentialRefusal(cg.VEND_FAILED, 'agent-A'))
        mock_run.assert_not_called()
        mock_s3.assert_not_called()
        failed = _node_failed_entries(mock_events)
        assert len(failed) == 1 and failed[0]['error'] == 'CredentialRefusal'

    def test_vend_failure_writes_ledger_finding(self):
        """Design §1d: EVERY CredentialRefusal outcome (not only the
        absent-permissions gate) produces a governance ledger finding."""
        _, _, mock_ledger, _ = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': ['int-1']}},
            scoped_side_effect=cg.CredentialRefusal(cg.VEND_REFUSED, 'agent-A'))
        mock_ledger.assert_called_once()

    def test_vender_unset_returns_none_still_never_spawns(self):
        """Regression for the deleted ambient-inherit branch: perms declared,
        vending yields None (CREDENTIAL_VENDER_FUNCTION unset case) and no
        sentinel → refused at env build, subprocess never spawned, node failed."""
        mock_events, mock_run, _, _ = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': ['int-1']}},
            scoped_return=None)
        mock_run.assert_not_called()
        assert _node_failed_entries(mock_events)[0]['error'] == 'CredentialRefusal'

    def test_sentinel_none_runs_with_scrubbed_env(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'ok'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py', 'credentialMode': 'none'}}), \
                     patch.object(index, 'get_scoped_credentials') as mock_vend, \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result) as mock_run:
                    index.process_event(dict(NODE_MESSAGE), {})
        mock_vend.assert_not_called()
        env = mock_run.call_args.kwargs['env']
        assert not (set(env) & cg.AMBIENT_AWS_KEYS)

    def test_scoped_creds_injected_and_ambient_scrubbed(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'ok'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        creds = {'accessKeyId': 'SCOPED', 'secretAccessKey': 'S', 'sessionToken': 'T'}
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py',
                                                           'requiredPermissions': {'integrations': ['i']}}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=creds), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result) as mock_run:
                    index.process_event(dict(NODE_MESSAGE), {})
        env = mock_run.call_args.kwargs['env']
        assert env['AWS_ACCESS_KEY_ID'] == 'SCOPED'
        assert env['AWS_SESSION_TOKEN'] == 'T'
        assert (set(env) & cg.AMBIENT_AWS_KEYS) == {
            'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'}


class TestSupervisorGate:
    def _run(self, config, scoped_side_effect=None):
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': config}), \
                     patch.object(index, 'load_file_from_s3_into_tmp') as mock_s3, \
                     patch.object(index, 'post_task_complete') as mock_post, \
                     patch.object(index, '_write_credential_refusal_finding') as mock_ledger, \
                     patch('subprocess.run') as mock_run:
                    ctx = (patch.object(index, 'get_scoped_credentials', side_effect=scoped_side_effect)
                           if scoped_side_effect is not None else
                           patch.object(index, 'get_scoped_credentials', return_value=None))
                    with ctx, pytest.raises(cg.CredentialRefusal):
                        index.process_event(dict(SUPERVISOR_MESSAGE), {})
        return mock_run, mock_post, mock_ledger, mock_s3

    def test_absent_permissions_refused_no_spawn_posts_failure_ledger(self):
        mock_run, mock_post, mock_ledger, mock_s3 = self._run({'filename': 'agent.py'})
        mock_run.assert_not_called()
        mock_s3.assert_not_called()
        mock_ledger.assert_called_once()
        mock_post.assert_called_once()
        assert 'refused' in mock_post.call_args.args[0]

    def test_vend_failure_refused_no_spawn_posts_failure(self):
        mock_run, mock_post, _, mock_s3 = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': ['i']}},
            scoped_side_effect=cg.CredentialRefusal(cg.VEND_FAILED, 'agent-A'))
        mock_run.assert_not_called()
        mock_s3.assert_not_called()
        mock_post.assert_called_once()

    def test_vend_failure_writes_ledger_finding(self):
        _, _, mock_ledger, _ = self._run(
            {'filename': 'agent.py', 'requiredPermissions': {'integrations': ['i']}},
            scoped_side_effect=cg.CredentialRefusal(cg.VEND_FAILED, 'agent-A'))
        mock_ledger.assert_called_once()

    def test_lambda_handler_acks_refusal_not_batch_failure(self):
        record = {'messageId': 'm1', 'body': json.dumps(SUPERVISOR_MESSAGE), 'messageAttributes': {}}
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'post_task_complete'), \
                     patch.object(index, '_write_credential_refusal_finding'), \
                     patch('subprocess.run') as mock_run:
                    result = index.lambda_handler({'Records': [record]}, {})
        mock_run.assert_not_called()
        assert result == {'batchItemFailures': []}


class TestLedgerFindingHelper:
    def test_ledger_write_finding_called_with_deny(self):
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch('governance.ledger.write_finding') as mock_wf:
                    index._write_credential_refusal_finding(
                        agent_id='agent-A', reason=cg.NO_REQUIRED_PERMISSIONS,
                        workflow_id='wf-1', org_id='org-1')
        mock_wf.assert_called_once()
        finding = mock_wf.call_args.args[0]
        assert 'credential_refusal_fail_closed' in finding.reason
