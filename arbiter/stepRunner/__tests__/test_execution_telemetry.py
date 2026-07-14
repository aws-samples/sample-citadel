"""
Telemetry tests for the step runner executor.

Two concerns are covered:

* **Metrics** — the executor emits CloudWatch custom metrics, best-effort,
  from a lazily-created boto3 cloudwatch client:
    - ``NodeDurationMs`` (Milliseconds) on node completion, computed from the
      node's persisted ``startedAt`` when available.
    - ``NodeFailure`` (Count) on terminal node failure (not on a retry).
  Both go to the ``Citadel/Workflows`` namespace. A metric-emit failure must
  never break execution — the workflow still advances / completes / fails.

* **Correlation logging** — node dispatch, completion, and failure emit
  structured JSON log lines carrying ``executionId``, ``nodeId`` and
  ``workflowId`` so a log search can stitch a single execution together.

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock

METRIC_NAMESPACE = 'Citadel/Workflows'


# ---------------------------------------------------------------------------
# Sample data — single-node workflow, easy to drive to a terminal state.
# ---------------------------------------------------------------------------

SINGLE_WF = {
    'workflowId': 'wf-single',
    'name': 'Single',
    'definition': json.dumps({
        'nodes': [{'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

RETRY_WF = {
    'workflowId': 'wf-single',
    'name': 'Single',
    'definition': json.dumps({
        'nodes': [{
            'id': 'n0', 'type': 'agent', 'agentId': 'agent-A',
            'data': {'retryPolicy': {
                'maxRetries': 3, 'backoffBase': 1.0, 'backoffMax': 10.0,
                'retryableErrors': ['TimeoutError'],
            }},
        }],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}


def _single_exec(*, started_at=None, status='running'):
    node = {'nodeId': 'n0', 'agentId': 'agent-A', 'status': status, 'retryCount': 0}
    if started_at is not None:
        node['startedAt'] = started_at
    return {
        'executionId': 'exec-single',
        'workflowId': 'wf-single',
        'appId': 'app-1',
        'status': 'running',
        'nodeResults': {'n0': node},
    }


def _metric_calls(cw, metric_name):
    """Return the put_metric_data kwargs whose first datum has metric_name."""
    calls = []
    for call in cw.put_metric_data.call_args_list:
        data = call.kwargs.get('MetricData', [])
        if data and data[0].get('MetricName') == metric_name:
            calls.append(call.kwargs)
    return calls


def _json_logs(capsys):
    """Parse JSON structured log lines emitted to stdout."""
    out = capsys.readouterr().out
    logs = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                logs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return logs


@pytest.fixture
def mock_exec():
    """Patch executor's tables, events, SQS, and CloudWatch clients."""
    import executor

    m = {
        'workflows_table': MagicMock(),
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'sqs': MagicMock(),
        'cw': MagicMock(),
    }
    with patch.object(executor, '_workflows_table', m['workflows_table']), \
         patch.object(executor, '_executions_table', m['executions_table']), \
         patch.object(executor, 'events', m['events']), \
         patch.object(executor, '_get_sqs_client', return_value=m['sqs']), \
         patch.object(executor, '_get_cloudwatch_client', return_value=m['cw']):
        yield m


# ---------------------------------------------------------------------------
# NodeDurationMs on completion
# ---------------------------------------------------------------------------

class TestNodeDurationMetric:
    def test_completion_emits_duration_metric_from_started_at(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        monkeypatch.setattr(executor, '_now_iso',
                            lambda: '2026-01-01T00:00:01.500000+00:00')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {
            'Item': _single_exec(started_at='2026-01-01T00:00:00+00:00')
        }

        executor.handle_node_completion('exec-single', 'n0', {'ok': True})

        calls = _metric_calls(mock_exec['cw'], 'NodeDurationMs')
        assert len(calls) == 1
        assert calls[0]['Namespace'] == METRIC_NAMESPACE
        datum = calls[0]['MetricData'][0]
        assert datum['Unit'] == 'Milliseconds'
        assert datum['Value'] == pytest.approx(1500.0)

    def test_completion_without_started_at_skips_duration_but_completes(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_completion('exec-single', 'n0', {'ok': True})

        # Best-effort: no startedAt → no duration metric, but the workflow
        # still reaches its terminal completed state.
        assert _metric_calls(mock_exec['cw'], 'NodeDurationMs') == []
        mock_exec['events'].publish_workflow_completed.assert_called_once()

    def test_metric_failure_does_not_break_completion(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        monkeypatch.setattr(executor, '_now_iso',
                            lambda: '2026-01-01T00:00:01+00:00')
        mock_exec['cw'].put_metric_data.side_effect = RuntimeError('cloudwatch down')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {
            'Item': _single_exec(started_at='2026-01-01T00:00:00+00:00')
        }

        # Must not raise despite the metric backend failing.
        executor.handle_node_completion('exec-single', 'n0', {'ok': True})

        mock_exec['events'].publish_workflow_completed.assert_called_once()


# ---------------------------------------------------------------------------
# NodeFailure on terminal failure
# ---------------------------------------------------------------------------

class TestNodeFailureMetric:
    def test_terminal_failure_emits_nodefailure_count(self, mock_exec):
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_failure('exec-single', 'n0', 'FatalError')

        calls = _metric_calls(mock_exec['cw'], 'NodeFailure')
        assert len(calls) == 1
        assert calls[0]['Namespace'] == METRIC_NAMESPACE
        datum = calls[0]['MetricData'][0]
        assert datum['Unit'] == 'Count'
        assert datum['Value'] == pytest.approx(1.0)

    def test_retryable_failure_does_not_emit_nodefailure(self, mock_exec):
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(RETRY_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_failure('exec-single', 'n0', 'TimeoutError')

        # Retry path — not a terminal failure, so no NodeFailure metric.
        assert _metric_calls(mock_exec['cw'], 'NodeFailure') == []
        mock_exec['events'].publish_node_retrying.assert_called_once()

    def test_metric_failure_does_not_break_failure_handling(self, mock_exec):
        import executor

        mock_exec['cw'].put_metric_data.side_effect = RuntimeError('cloudwatch down')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_failure('exec-single', 'n0', 'FatalError')

        mock_exec['events'].publish_workflow_failed.assert_called_once()


# ---------------------------------------------------------------------------
# Correlation logging
# ---------------------------------------------------------------------------

class TestCorrelationLogging:
    def test_completion_logs_execution_and_node_ids(self, mock_exec, capsys, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_completion('exec-single', 'n0', {'ok': True})

        logs = _json_logs(capsys)
        assert any(
            log.get('executionId') == 'exec-single'
            and log.get('nodeId') == 'n0'
            and log.get('workflowId') == 'wf-single'
            for log in logs
        )

    def test_failure_logs_execution_node_ids_and_error(self, mock_exec, capsys):
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WF)}
        mock_exec['executions_table'].get_item.return_value = {'Item': _single_exec()}

        executor.handle_node_failure('exec-single', 'n0', 'FatalError')

        logs = _json_logs(capsys)
        assert any(
            log.get('executionId') == 'exec-single'
            and log.get('nodeId') == 'n0'
            and log.get('workflowId') == 'wf-single'
            and 'FatalError' in json.dumps(log)
            for log in logs
        )

    def test_invoke_node_logs_correlation_fields(self, mock_exec, capsys, monkeypatch):
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        node = {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}

        executor.invoke_node('exec-1', 'wf-1', node, {}, {})

        logs = _json_logs(capsys)
        assert any(
            log.get('executionId') == 'exec-1'
            and log.get('nodeId') == 'n0'
            and log.get('workflowId') == 'wf-1'
            for log in logs
        )
