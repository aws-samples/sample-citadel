"""
Unit tests for the worker's workflow-node execution path.

A workflow-node message (carrying the shared contract's discriminator) is
routed to the existing agent-execution path — config load → credential vend →
S3 module load → agent_runner subprocess — and its result is emitted as a
workflow.node.completed / workflow.node.failed event on the agent event bus the
step runner consumes. A subprocess failure emits node.failed, never a canned
success. A supervisor task message (no discriminator) still takes the existing
task.completion path unchanged.

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


class TestWorkflowNodeRouting:
    def test_node_message_runs_agent_and_emits_node_completed(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        mock_events.put_events.assert_called_once()
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['Source'] == 'citadel.workflows'
        assert entry['DetailType'] == 'workflow.node.completed'
        assert entry['EventBusName'] == 'citadel-agents-test'

        detail = json.loads(entry['Detail'])
        assert detail['executionId'] == 'exec-1'
        assert detail['nodeId'] == 'n0'
        assert detail['workflowId'] == 'wf-1'
        assert detail['agentId'] == 'agent-A'
        assert detail['status'] == 'completed'
        assert detail['output'] == {'response': 'done'}

    def test_node_message_subprocess_failure_emits_node_failed(self):
        # Non-zero exit → run_agent_in_subprocess(raise_on_error=True) raises →
        # node.failed, NOT a canned success.
        mock_result = MagicMock(returncode=1, stdout='', stderr='boom')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['Source'] == 'citadel.workflows'
        assert entry['DetailType'] == 'workflow.node.failed'
        detail = json.loads(entry['Detail'])
        assert detail['status'] == 'failed'
        assert detail['error']  # non-empty error string
        assert 'output' not in detail

    def test_node_message_config_error_emits_node_failed(self):
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  side_effect=KeyError('Item')), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.failed'
        assert json.loads(entry['Detail'])['status'] == 'failed'


class TestSupervisorTaskUnchanged:
    def test_supervisor_message_takes_task_completion_path(self):
        mock_events = MagicMock()

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py', 'tools': []}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'build_subprocess_env', return_value={}), \
                     patch.object(index, 'run_agent_in_subprocess', return_value='resp'), \
                     patch.object(index, 'post_task_complete') as mock_ptc, \
                     patch.object(index, '_process_workflow_node') as mock_node:
                    index.process_event(dict(SUPERVISOR_MESSAGE), {})

        # Routing: supervisor task path taken, workflow-node path not invoked.
        mock_node.assert_not_called()
        mock_ptc.assert_called_once()
