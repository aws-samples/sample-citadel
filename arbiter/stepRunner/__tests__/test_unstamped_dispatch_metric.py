"""Tests for the UnstampedDispatch runtime backstop metric (Pass 1,
decision f1cbd5ef, silent-regression guard layer 3): executor.invoke_node
emits a WARN-level CloudWatch count metric, using the pinned
metrics_constants module, whenever it dispatches a node with no run_id.
Observability only — never gates dispatch.
"""
import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock

SAMPLE_WORKFLOW = {
    'workflowId': 'wf-001',
    'orgId': 'org-001',
    'name': 'Test Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Node A'}},
        ],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

SAMPLE_EXECUTION_WITH_RUN_ID = {
    'executionId': 'exec-001',
    'workflowId': 'wf-001',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'runId': 'run-abc123',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}

SAMPLE_EXECUTION_WITHOUT_RUN_ID = {
    'executionId': 'exec-002',
    'workflowId': 'wf-001',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}


@pytest.fixture
def mock_executor(monkeypatch):
    import executor

    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.example.com/queue')

    mock_wf_table = MagicMock()
    mock_exec_table = MagicMock()
    mock_events = MagicMock()
    mock_sqs = MagicMock()
    mock_cloudwatch = MagicMock()

    with patch.object(executor, '_workflows_table', mock_wf_table), \
         patch.object(executor, '_executions_table', mock_exec_table), \
         patch.object(executor, 'events', mock_events), \
         patch.object(executor, '_get_sqs_client', return_value=mock_sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=mock_cloudwatch):
        yield {
            'workflows_table': mock_wf_table,
            'executions_table': mock_exec_table,
            'events': mock_events,
            'sqs': mock_sqs,
            'cloudwatch': mock_cloudwatch,
        }


class TestUnstampedDispatchMetric:
    def test_emits_unstamped_dispatch_when_run_id_absent(self, mock_executor):
        import executor

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITHOUT_RUN_ID),
        }

        executor.start_execution('exec-002', 'wf-001')

        put_calls = mock_executor['cloudwatch'].put_metric_data.call_args_list
        metric_names = [
            datum['MetricName']
            for call in put_calls
            for datum in call.kwargs['MetricData']
        ]
        assert 'UnstampedDispatch' in metric_names

    def test_does_not_emit_unstamped_dispatch_when_run_id_present(self, mock_executor):
        import executor

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITH_RUN_ID),
        }

        executor.start_execution('exec-001', 'wf-001')

        put_calls = mock_executor['cloudwatch'].put_metric_data.call_args_list
        metric_names = [
            datum['MetricName']
            for call in put_calls
            for datum in call.kwargs['MetricData']
        ]
        assert 'UnstampedDispatch' not in metric_names

    def test_unstamped_dispatch_metric_never_gates_dispatch_on_cloudwatch_failure(self, mock_executor):
        """Best-effort discipline: a CloudWatch failure must never prevent
        the SQS dispatch from happening."""
        import executor

        mock_executor['cloudwatch'].put_metric_data.side_effect = RuntimeError('throttled')
        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITHOUT_RUN_ID),
        }

        # Must not raise, and SQS dispatch must still happen.
        executor.start_execution('exec-002', 'wf-001')
        mock_executor['sqs'].send_message.assert_called_once()

    def test_metric_uses_pinned_constant_not_a_retyped_literal(self, mock_executor):
        """Guards the 'do NOT retype metric names' lesson: the emitted
        metric name must equal the pinned constant, verified by importing
        it directly rather than hardcoding the string a second time."""
        import executor
        from common.metrics_constants import METRIC_UNSTAMPED_DISPATCH

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITHOUT_RUN_ID),
        }

        executor.start_execution('exec-002', 'wf-001')

        put_calls = mock_executor['cloudwatch'].put_metric_data.call_args_list
        metric_names = [
            datum['MetricName']
            for call in put_calls
            for datum in call.kwargs['MetricData']
        ]
        assert METRIC_UNSTAMPED_DISPATCH in metric_names
