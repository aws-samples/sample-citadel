"""
Correlation-logging tests for the worker's workflow-node path.

The worker's ``_process_workflow_node`` must emit structured JSON log lines
that carry ``executionId``, ``nodeId`` and ``workflowId`` on both the success
and failure paths, so a log search can stitch a node's worker-side execution
to the step runner's coordinator-side view of the same execution.

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


def _json_logs(capsys):
    logs = []
    for line in capsys.readouterr().out.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                logs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return logs


def _has_correlation(logs):
    return [
        log for log in logs
        if log.get('executionId') == 'exec-1'
        and log.get('nodeId') == 'n0'
        and log.get('workflowId') == 'wf-1'
    ]


class TestWorkerNodeCorrelationLogging:
    def test_success_path_logs_execution_node_workflow_ids(self, capsys):
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

        assert _has_correlation(_json_logs(capsys)), \
            "expected a structured log carrying executionId/nodeId/workflowId on success"

    def test_failure_path_logs_execution_node_workflow_ids(self, capsys):
        # Non-zero subprocess exit → node.failed path.
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

        matches = _has_correlation(_json_logs(capsys))
        assert matches, \
            "expected a structured log carrying executionId/nodeId/workflowId on failure"
        # The failure log should reference the error.
        assert any('error' in log for log in matches)


# ---------------------------------------------------------------------------
# Cold-start metric: module-scope flag flipped on first invocation, emitted
# exactly once per (simulated) container lifetime via CloudWatch PutMetricData.
# ---------------------------------------------------------------------------

def _cw_calls(mock_cw, metric_name):
    calls = []
    for call in mock_cw.put_metric_data.call_args_list:
        data = call.kwargs.get('MetricData', [])
        if data and data[0].get('MetricName') == metric_name:
            calls.append(call.kwargs)
    return calls


class TestWorkerColdStartMetric:
    def test_first_invocation_in_fresh_container_emits_cold_start(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        mock_cw = MagicMock()

        def _client(name, *a, **kw):
            return mock_cw if name == 'cloudwatch' else mock_events

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', side_effect=_client):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        calls = _cw_calls(mock_cw, 'NodeColdStart')
        assert len(calls) == 1
        assert calls[0]['Namespace'] == 'Citadel/Workflows'
        datum = calls[0]['MetricData'][0]
        assert datum['Unit'] == 'Count'
        assert datum['Value'] == 1
        assert datum['Dimensions'] == [{'Name': 'AgentId', 'Value': 'agent-A'}]

    def test_second_invocation_in_same_container_does_not_re_emit(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        mock_cw = MagicMock()

        def _client(name, *a, **kw):
            return mock_cw if name == 'cloudwatch' else mock_events

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', side_effect=_client):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    # Two invocations in the same (never-reset) module state,
                    # simulating a warm container serving a second node.
                    index.process_event(dict(NODE_MESSAGE), {})
                    index.process_event(dict(NODE_MESSAGE), {})

        assert len(_cw_calls(mock_cw, 'NodeColdStart')) == 1

    def test_cold_start_metric_failure_does_not_break_dispatch(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        mock_cw = MagicMock()
        mock_cw.put_metric_data.side_effect = RuntimeError('cloudwatch down')

        def _client(name, *a, **kw):
            return mock_cw if name == 'cloudwatch' else mock_events

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', side_effect=_client):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    # Must not raise despite the metric backend failing.
                    index.process_event(dict(NODE_MESSAGE), {})

        mock_events.put_events.assert_called_once()


# ---------------------------------------------------------------------------
# Queue-wait timestamp forwarding: dispatchedAt (from the parsed dispatch
# message) and workerStartedAt (captured at the top of _process_workflow_node)
# both ride the node-result event Detail, regardless of success/failure.
# ---------------------------------------------------------------------------

class TestWorkerQueueWaitTimestampForwarding:
    def test_success_result_carries_dispatched_at_and_worker_started_at(self):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        message = dict(NODE_MESSAGE)
        message['dispatchedAt'] = '2026-01-01T00:00:00+00:00'

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(message, {})

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['dispatchedAt'] == '2026-01-01T00:00:00+00:00'
        assert isinstance(detail.get('workerStartedAt'), str) and detail['workerStartedAt']

    def test_failure_result_also_carries_dispatched_at_and_worker_started_at(self):
        mock_result = MagicMock(returncode=1, stdout='', stderr='boom')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}
        message = dict(NODE_MESSAGE)
        message['dispatchedAt'] = '2026-01-01T00:00:00+00:00'

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(message, {})

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['dispatchedAt'] == '2026-01-01T00:00:00+00:00'
        assert isinstance(detail.get('workerStartedAt'), str) and detail['workerStartedAt']

    def test_absent_dispatched_at_omits_the_key_rather_than_fabricating(self):
        """Pre-feature dispatcher: no dispatchedAt on the message. The result
        detail must not carry a fabricated dispatchedAt — only the worker's
        own workerStartedAt (which the worker CAN measure) is present."""
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                getattr(index, '__reset_cold_start_for_test')()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert 'dispatchedAt' not in detail
        assert isinstance(detail.get('workerStartedAt'), str) and detail['workerStartedAt']


# ---------------------------------------------------------------------------
# Usage capture is additive on both the supervisor-task and workflow-node
# paths: task.completion Detail gains a 'usage' key without disturbing any
# existing key, and workflow node completed output gains 'usage' alongside
# the existing 'response' key. The failure path is unchanged (no usage key
# expected there — a failed run never produced a response envelope either).
# ---------------------------------------------------------------------------

class TestUsageCaptureAdditive:
    def test_task_completion_detail_carries_usage_additively(self):
        """post_task_complete's EventBridge Detail gains 'usage' without
        disturbing orchestration_id/data/agent_use_id/node."""
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'COMPLETION_BUS_NAME': 'test-bus',
        }):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                usage_records = [
                    {'modelId': 'm', 'inputTokens': 1, 'outputTokens': 2,
                     'latencyMs': 3, 'callIndex': 0,
                     'capturedAt': '2024-01-01T00:00:00Z', 'source': 'worker'},
                ]
                index.post_task_complete(
                    'a response', 'agent-use-1', 'agent-A', 'orch-1',
                    usage=usage_records,
                )

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['orchestration_id'] == 'orch-1'
        assert detail['agent_use_id'] == 'agent-use-1'
        assert detail['node'] == 'agent-A'
        assert 'data' in detail
        assert detail['usage'] == usage_records

    def test_task_completion_detail_usage_defaults_to_empty_list(self):
        """When no usage is captured, the Detail still carries 'usage': []
        rather than omitting the key or passing None through."""
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'COMPLETION_BUS_NAME': 'test-bus',
        }):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                index.post_task_complete('a response', 'agent-use-1', 'agent-A', 'orch-1')

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['usage'] == []

    def test_workflow_node_completed_output_carries_usage_additively(self, capsys):
        """_process_workflow_node's success output gains 'usage' alongside
        the existing 'response' key."""
        mock_result = MagicMock(
            returncode=0,
            stdout=json.dumps({'response': 'done', 'usage': [
                {'modelId': 'm', 'inputTokens': 5, 'outputTokens': 6,
                 'latencyMs': 7, 'callIndex': 0,
                 'capturedAt': '2024-01-01T00:00:00Z', 'source': 'worker'},
            ]}),
            stderr='',
        )
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

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        output = detail.get('output', {})
        assert output.get('response') == 'done'
        assert len(output.get('usage', [])) == 1
        assert output['usage'][0]['source'] == 'worker'

    def test_workflow_node_failure_path_unchanged_no_usage_key_required(self, capsys):
        """Failure path is unchanged: no 'output'/'usage' key is required
        on a workflow.node.failed event."""
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

        call_args = mock_events.put_events.call_args
        entry = call_args[1]['Entries'][0] if 'Entries' in call_args[1] else call_args[0][0]['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail.get('status') == 'failed' or 'error' in detail
