"""Unit tests for trace-context propagation in the worker (architect task
f4f4bab3-7a07-4acf-ba43-ba43bb488444, H3 SQS hop — design §"File-by-file
list" item 9):

* R16 — consume: extract the AWSTraceHeader SQS MessageAttribute (falling
  back to the body ``traceContext``), annotate the active segment. No-op-safe
  when neither is present.
* R17 — node-result emit: carry ``traceContext`` in the node-result Detail
  when available at dispatch time.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
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


class TestWorkerConsumeTraceContext:
    def test_r16_no_op_safe_when_neither_attribute_nor_body_trace_context_present(self):
        """R16 no-op-safety: an SQS record with no AWSTraceHeader attribute
        and a body carrying no traceContext must not throw, and the emitted
        node-result Detail carries no traceContext key."""
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
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert 'traceContext' not in detail

    def test_r16_extracts_body_trace_context_and_annotates_when_no_attribute(self):
        """When the SQS record carries no AWSTraceHeader MessageAttribute but
        the body has a traceContext, the worker still annotates from it."""
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        message = dict(NODE_MESSAGE)
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        message['traceContext'] = carried

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result), \
                     patch.object(index, 'annotate_from_carried') as mock_annotate:
                    record = {'body': json.dumps(message), 'messageId': 'm1'}
                    index.lambda_handler({'Records': [record]}, {})

        mock_annotate.assert_called_once_with(carried)

    def test_r16_extracts_aws_trace_header_message_attribute(self):
        """The AWSTraceHeader MessageAttribute (SQS's native X-Ray-linked
        attribute) takes priority and is passed through to annotation."""
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
                     patch.object(index, 'annotate_from_carried') as mock_annotate:
                    record = {
                        'body': json.dumps(NODE_MESSAGE),
                        'messageId': 'm1',
                        'messageAttributes': {
                            'AWSTraceHeader': {
                                'stringValue': 'Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1',
                                'dataType': 'String',
                            },
                        },
                    }
                    index.lambda_handler({'Records': [record]}, {})

        mock_annotate.assert_called_once()
        (called_ctx,) = mock_annotate.call_args.args
        assert called_ctx.get('xrayTraceHeader') == (
            'Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1'
        )


class TestWorkerNodeResultTraceContext:
    def test_r17_node_result_carries_trace_context_when_available(self):
        """R17: when the incoming message/segment yields a trace context, the
        emitted node.completed Detail carries a top-level traceContext key."""
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        message = dict(NODE_MESSAGE)
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        message['traceContext'] = carried

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
        assert detail['traceContext'] == carried
