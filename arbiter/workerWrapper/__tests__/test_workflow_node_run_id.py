"""Unit tests for run_id propagation through the worker's node-result
emission (Pass 1, decision f1cbd5ef) — mirrors
TestWorkerNodeResultTraceContext in test_workflow_node_trace_context.py.
The dispatch message's ``runId`` (server-minted upstream) must reach the
emitted node.completed / node.failed Detail unchanged, and be absent when
the dispatch message carries no runId.
"""
import json
import sys
from unittest.mock import patch, MagicMock

NODE_MESSAGE = {
    'message_type': 'workflow_node',
    'execution_id': 'exec-1',
    'node_id': 'n0',
    'workflow_id': 'wf-1',
    'agent_id': 'agent-A',
    'input': {'taskDetails': 'do the thing'},
    'configuration': {},
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


class TestWorkerNodeResultRunId:
    def test_run_id_carried_from_dispatch_message_to_completed_detail(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        message = dict(NODE_MESSAGE)
        message['runId'] = 'run-abc123'

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    record = {'body': json.dumps(message), 'messageId': 'm1'}
                    index.lambda_handler({'Records': [record]}, {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['runId'] == 'run-abc123'

    def test_run_id_absent_from_completed_detail_when_dispatch_message_has_none(self):
        """Byte-identical to the pre-runId shape when the dispatch message
        carries no runId (pre-runId execution)."""
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
                    record = {'body': json.dumps(NODE_MESSAGE), 'messageId': 'm1'}
                    index.lambda_handler({'Records': [record]}, {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert 'runId' not in detail

    def test_run_id_carried_from_dispatch_message_to_failed_detail(self):
        """Failure path: run_id must also reach the node.failed Detail."""
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        message = dict(NODE_MESSAGE)
        message['runId'] = 'run-fail456'

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', side_effect=RuntimeError('boom')):
                    record = {'body': json.dumps(message), 'messageId': 'm1'}
                    index.lambda_handler({'Records': [record]}, {})

        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['runId'] == 'run-fail456'
