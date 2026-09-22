"""Unit tests for the worker's workflow-node SQS entry point's
execution_trace_scope usage (finding 40061019, superseding 3d92ef6b /
CIT-181): _process_workflow_node must open a trace scope stamped with
run_id/execution_id/correlation_id/node_id/workflow_id from the parsed
NodeDispatchMessage around the agent-execution work — annotating the
Lambda-owned FacadeSegment (the prior current-segment-first design)
silently dropped the annotation. annotate_from_carried remains
unchanged/additive.
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


def _patched_scope():
    scope_instance = MagicMock()
    scope_instance.__enter__ = MagicMock(return_value=scope_instance)
    scope_instance.__exit__ = MagicMock(return_value=None)
    factory = MagicMock(return_value=scope_instance)
    return factory, scope_instance


def _run_node_dispatch(message, patch_scope=True, patch_annotate_carried=False, raise_in_agent=False):
    mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
    mock_events = MagicMock()
    mock_events.put_events.return_value = {'FailedEntryCount': 0}

    with patch.dict('os.environ', _NODE_ENV):
        with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
            index = _fresh_index()
            extra_patches = []
            factory = scope_instance = None
            if patch_scope:
                factory, scope_instance = _patched_scope()
                extra_patches.append(patch.object(index, 'execution_trace_scope', factory))
            if patch_annotate_carried:
                extra_patches.append(patch.object(index, 'annotate_from_carried'))

            subprocess_patch = (
                patch('subprocess.run', side_effect=RuntimeError('boom'))
                if raise_in_agent
                else patch('subprocess.run', return_value=mock_result)
            )

            with patch.object(index, 'load_config_from_dynamodb',
                              return_value={'config': {'filename': 'agent.py'}}), \
                 patch.object(index, 'get_scoped_credentials', return_value=None), \
                 patch.object(index, 'load_file_from_s3_into_tmp'), \
                 subprocess_patch, \
                 _apply_all(extra_patches):
                record = {'body': json.dumps(message), 'messageId': 'm1'}
                index.lambda_handler({'Records': [record]}, {})
    return factory, scope_instance


class _apply_all:
    """Tiny helper to enter/exit a variable-length list of patch context
    managers without nested `with` statements."""

    def __init__(self, patches):
        self._patches = patches

    def __enter__(self):
        for p in self._patches:
            p.__enter__()
        return self

    def __exit__(self, *exc):
        for p in reversed(self._patches):
            p.__exit__(*exc)
        return False


class TestWorkerUsesExecutionTraceScope:
    def test_opens_scope_with_ids_from_parsed_dispatch_message(self):
        factory, scope_instance = _run_node_dispatch(NODE_MESSAGE)

        factory.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id=None,
            node_id='n0',
            workflow_id='wf-1',
        )
        scope_instance.__enter__.assert_called_once()
        scope_instance.__exit__.assert_called_once()

    def test_opens_scope_with_run_id_and_correlation_id_when_present_on_message(self):
        message = dict(NODE_MESSAGE)
        message['runId'] = 'run-1'
        message['correlation_id'] = 'corr-1'

        factory, _scope_instance = _run_node_dispatch(message)

        factory.assert_called_once_with(
            run_id='run-1',
            execution_id='exec-1',
            correlation_id='corr-1',
            node_id='n0',
            workflow_id='wf-1',
        )

    def test_scope_exits_even_when_the_agent_call_raises(self):
        """The failure path returns early inside the try/except, but that
        return is still inside the `with` block, so __exit__ must still
        fire (finally-equivalent context-manager semantics)."""
        factory, scope_instance = _run_node_dispatch(NODE_MESSAGE, raise_in_agent=True)

        scope_instance.__enter__.assert_called_once()
        scope_instance.__exit__.assert_called_once()

    def test_no_throw_when_tracing_unavailable(self):
        """If common.tracing is unavailable, the module-level fallback
        no-op execution_trace_scope must not break dispatch."""
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
        """annotate_from_carried is additive — the existing carried-context
        annotation call must still fire on the workflow-node dispatch path,
        independent of the trace scope."""
        message = dict(NODE_MESSAGE)
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        message['traceContext'] = carried

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
                     patch.object(index, 'annotate_from_carried') as mock_annotate_carried:
                    record = {'body': json.dumps(message), 'messageId': 'm1'}
                    index.lambda_handler({'Records': [record]}, {})

        mock_annotate_carried.assert_called_once_with(carried)
