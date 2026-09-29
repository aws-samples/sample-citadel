"""
CIT-041 PR2 — worker-side second layer (defence in depth) for registry
record approval, beside the exec-spec ExecutionSpecification gate.

Covers ``_check_approval_gate`` on BOTH the workflow-node dispatch path
(``_process_workflow_node`` via ``process_event``) and the supervisor task
path (``process_event`` with no ``message_type`` discriminator):

* strict + REJECTED (NOT_APPROVED) -> node/task fails with error class
  ``RecordNotApprovedError`` (classify() -> APPROVAL_ABSENT) and the agent
  subprocess is never invoked.
* shadow -> proceeds (log-only would-block), agent runs.
* APPROVED -> proceeds, agent runs.
* missing registryStatus + createdAt before the governance cutoff ->
  grandfathered, agent runs.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
"""

import json
import sys
from unittest.mock import patch, MagicMock

import pytest


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

_NODE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _make_state(enforcement_mode='shadow', effective_at=None):
    state = MagicMock()
    state.enforcement_mode = enforcement_mode
    state.effective_at = effective_at
    return state


class TestWorkflowNodePathSecondLayer:
    def test_strict_rejected_fails_node_and_agent_never_invoked(self):
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('strict')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py'},
                                      'registryStatus': 'REJECTED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials') as mock_creds, \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run') as mock_run:
                    index.process_event(dict(NODE_MESSAGE), {})

        mock_creds.assert_not_called()
        mock_run.assert_not_called()
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.failed'
        detail = json.loads(entry['Detail'])
        assert detail['error'] == 'RecordNotApprovedError'

    def test_shadow_runs_agent(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('shadow')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py'},
                                      'registryStatus': 'REJECTED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'

    def test_strict_approved_runs_agent(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('strict')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py'},
                                      'registryStatus': 'APPROVED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'

    def test_strict_missing_status_grandfathered_before_cutoff_runs_agent(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(
                    index, 'load_governance_state',
                    return_value=_make_state('strict', effective_at='2026-01-01T00:00:00Z'),
                ), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py'},
                                      'createdAt': '2025-01-01T00:00:00Z',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'


class TestSupervisorTaskPathSecondLayer:
    def test_strict_rejected_raises_and_agent_never_invoked(self):
        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('strict')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py', 'tools': []},
                                      'registryStatus': 'REJECTED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials') as mock_creds, \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'run_agent_in_subprocess') as mock_run:
                    with pytest.raises(index.RecordNotApprovedError):
                        index.process_event(dict(SUPERVISOR_MESSAGE), {})

        mock_creds.assert_not_called()
        mock_run.assert_not_called()

    def test_shadow_runs_agent(self):
        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('shadow')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py', 'tools': []},
                                      'registryStatus': 'REJECTED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'run_agent_in_subprocess',
                                  return_value='ok') as mock_run, \
                     patch.object(index, 'post_task_complete'):
                    index.process_event(dict(SUPERVISOR_MESSAGE), {})

        mock_run.assert_called_once()

    def test_approved_runs_agent(self):
        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(index, 'load_governance_state',
                                  return_value=_make_state('strict')), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py', 'tools': []},
                                      'registryStatus': 'APPROVED',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'run_agent_in_subprocess',
                                  return_value='ok') as mock_run, \
                     patch.object(index, 'post_task_complete'):
                    index.process_event(dict(SUPERVISOR_MESSAGE), {})

        mock_run.assert_called_once()

    def test_missing_status_grandfathered_before_cutoff_runs_agent(self):
        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(
                    index, 'load_governance_state',
                    return_value=_make_state('strict', effective_at='2026-01-01T00:00:00Z'),
                ), \
                     patch.object(index, 'load_config_from_dynamodb',
                                  return_value={
                                      'config': {'filename': 'agent.py', 'tools': []},
                                      'createdAt': '2025-01-01T00:00:00Z',
                                  }), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'run_agent_in_subprocess',
                                  return_value='ok') as mock_run, \
                     patch.object(index, 'post_task_complete'):
                    index.process_event(dict(SUPERVISOR_MESSAGE), {})

        mock_run.assert_called_once()
