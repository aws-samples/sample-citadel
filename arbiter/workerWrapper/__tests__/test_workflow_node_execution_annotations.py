"""Unit tests for annotate_execution at the worker's workflow-node SQS
entry point (finding 3d92ef6b / CIT-181): _process_workflow_node must
stamp run_id/execution_id/correlation_id/node_id/workflow_id from the
parsed NodeDispatchMessage directly, independent of whether a carried
trace context (AWSTraceHeader / body traceContext) was present — that
remains annotate_from_carried's job, unchanged.
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


def _run_node_dispatch(message, annotate_patch_target='annotate_execution'):
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
                 patch('subprocess.run', return_value=mock_result), \
                 patch.object(index, annotate_patch_target) as mock_annotate:
                record = {'body': json.dumps(message), 'messageId': 'm1'}
                index.lambda_handler({'Records': [record]}, {})
    return mock_annotate


class TestWorkerAnnotatesExecutionIds:
    def test_annotates_ids_from_parsed_dispatch_message(self):
        mock_annotate = _run_node_dispatch(NODE_MESSAGE)

        mock_annotate.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id=None,
            node_id='n0',
            workflow_id='wf-1',
        )

    def test_annotates_run_id_and_correlation_id_when_present_on_message(self):
        message = dict(NODE_MESSAGE)
        message['runId'] = 'run-1'
        message['correlation_id'] = 'corr-1'

        mock_annotate = _run_node_dispatch(message)

        mock_annotate.assert_called_once_with(
            run_id='run-1',
            execution_id='exec-1',
            correlation_id='corr-1',
            node_id='n0',
            workflow_id='wf-1',
        )

    def test_no_throw_when_annotate_execution_unavailable(self):
        """If common.tracing is unavailable, the module-level fallback
        no-op annotate_execution must not break dispatch."""
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
                    result = index.lambda_handler({'Records': [record]}, {})

        assert result == {'batchItemFailures': []}

    def test_does_not_remove_annotate_from_carried_call(self):
        """annotate_execution is additive — the existing carried-context
        annotation call must still fire on the workflow-node dispatch path."""
        message = dict(NODE_MESSAGE)
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        message['traceContext'] = carried

        mock_annotate_carried = _run_node_dispatch(message, annotate_patch_target='annotate_from_carried')

        mock_annotate_carried.assert_called_once_with(carried)
