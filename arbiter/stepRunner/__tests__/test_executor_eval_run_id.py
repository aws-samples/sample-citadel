"""Tests for evalRunId threading through stepRunner/executor.py completion
events (CIT-102 Pass B) — additive, optional, omitted-when-absent,
mirroring the run_id precedent in test_executor_run_id.py. The execution
row's evalRunId (frozen contract, stamped by the eval-runner driver on the
EXECUTION-kind case's execution row) must reach the workflow.completed /
workflow.failed events unchanged, and be absent when the execution row
carries no evalRunId (the additive-contract guarantee: absent contract
keys => zero behavior change).
"""
import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock

SINGLE_WORKFLOW = {
    'workflowId': 'wf-single',
    'name': 'Single',
    'definition': json.dumps({
        'nodes': [{'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

SINGLE_EXEC_WITH_EVAL_RUN_ID = {
    'executionId': 'exec-eval-1',
    'workflowId': 'wf-single',
    'appId': 'app-1',
    'status': 'running',
    'evalRunId': 'eval-run-777',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
    },
}

SINGLE_EXEC_WITHOUT_EVAL_RUN_ID = {
    'executionId': 'exec-normal-1',
    'workflowId': 'wf-single',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
    },
}


@pytest.fixture
def mock_exec():
    import executor

    tables = {
        'workflows_table': MagicMock(),
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'sqs': MagicMock(),
    }
    with patch.object(executor, '_workflows_table', tables['workflows_table']), \
         patch.object(executor, '_executions_table', tables['executions_table']), \
         patch.object(executor, 'events', tables['events']), \
         patch.object(executor, '_get_sqs_client', return_value=tables['sqs']):
        yield tables


class TestHandleNodeCompletionThreadsEvalRunId:
    def test_workflow_completed_carries_eval_run_id_when_present(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SINGLE_EXEC_WITH_EVAL_RUN_ID),
        }

        executor.handle_node_completion('exec-eval-1', 'n0', {'ok': True})

        mock_exec['events'].publish_workflow_completed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_completed.call_args.kwargs
        assert kwargs.get('eval_run_id') == 'eval-run-777'

    def test_workflow_completed_eval_run_id_none_when_absent(self, mock_exec, monkeypatch):
        """Additive-contract guarantee: a non-eval execution produces a
        byte-identical (eval_run_id=None) publish_workflow_completed call."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SINGLE_EXEC_WITHOUT_EVAL_RUN_ID),
        }

        executor.handle_node_completion('exec-normal-1', 'n0', {'ok': True})

        mock_exec['events'].publish_workflow_completed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_completed.call_args.kwargs
        assert kwargs.get('eval_run_id') is None


class TestHandleNodeFailureThreadsEvalRunId:
    def test_workflow_failed_carries_eval_run_id_when_present(self, mock_exec):
        import executor

        exec_row = copy.deepcopy(SINGLE_EXEC_WITH_EVAL_RUN_ID)
        exec_row['nodeResults']['n0']['retryCount'] = 0
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': exec_row}

        executor.handle_node_failure('exec-eval-1', 'n0', 'FatalError')

        mock_exec['events'].publish_workflow_failed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_failed.call_args.kwargs
        assert kwargs.get('eval_run_id') == 'eval-run-777'

    def test_workflow_failed_eval_run_id_none_when_absent(self, mock_exec):
        import executor

        exec_row = copy.deepcopy(SINGLE_EXEC_WITHOUT_EVAL_RUN_ID)
        exec_row['nodeResults']['n0']['retryCount'] = 0
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': exec_row}

        executor.handle_node_failure('exec-normal-1', 'n0', 'FatalError')

        mock_exec['events'].publish_workflow_failed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_failed.call_args.kwargs
        assert kwargs.get('eval_run_id') is None


class TestCancelExecutionThreadsEvalRunId:
    def test_cancel_execution_carries_eval_run_id_when_present(self, mock_exec):
        import executor

        mock_exec['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SINGLE_EXEC_WITH_EVAL_RUN_ID),
        }

        executor.cancel_execution('exec-eval-1')

        mock_exec['events'].publish_workflow_failed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_failed.call_args.kwargs
        assert kwargs.get('eval_run_id') == 'eval-run-777'

    def test_cancel_execution_eval_run_id_none_when_absent(self, mock_exec):
        import executor

        mock_exec['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SINGLE_EXEC_WITHOUT_EVAL_RUN_ID),
        }

        executor.cancel_execution('exec-normal-1')

        mock_exec['events'].publish_workflow_failed.assert_called_once()
        kwargs = mock_exec['events'].publish_workflow_failed.call_args.kwargs
        assert kwargs.get('eval_run_id') is None
