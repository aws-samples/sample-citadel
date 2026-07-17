"""
Unit + property tests for duplicate-delivery safety of the step runner.

At-least-once transports (SQS / EventBridge) can deliver the same
node-completed / node-failed event more than once. The completion and
failure handlers must therefore be idempotent: a second delivery of an
event for a node that has already reached its terminal state must not
re-advance the DAG, re-invoke downstream nodes, or re-emit the terminal
workflow event.

Duplicate detection is based on the persisted node status read back from
the executions table:
  * completion  → terminal when the node is already 'completed'
  * failure     → terminal when the node is already 'failed'
A node still 'running' / 'pending' is NOT terminal, so the legitimate
retry path (a failure with retries remaining) must continue to work.

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st


# ---------------------------------------------------------------------------
# Sample data — a two-node chain (n0 -> n1) and a single-node workflow.
# ---------------------------------------------------------------------------

CHAIN_WORKFLOW = {
    'workflowId': 'wf-chain',
    'name': 'Chain',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {}},
        ],
        'edges': [{'id': 'e0', 'source': 'n0', 'target': 'n1'}],
    }),
    'configuration': json.dumps({}),
}

CHAIN_EXEC = {
    'executionId': 'exec-chain',
    'workflowId': 'wf-chain',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
    },
}

SINGLE_WORKFLOW = {
    'workflowId': 'wf-single',
    'name': 'Single',
    'definition': json.dumps({
        'nodes': [{'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

SINGLE_EXEC = {
    'executionId': 'exec-single',
    'workflowId': 'wf-single',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
    },
}


@pytest.fixture
def mock_exec():
    """Patch the module-level tables, events, and SQS client on executor."""
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


def _exec_get_item_first_running_then(status_after: str, node_id: str, base_exec: dict):
    """Return a get_item side effect: first call reflects the node still
    'running', every subsequent call reflects the persisted terminal status —
    exactly what DynamoDB would return after the first delivery persisted it."""
    call_count = [0]

    def side_effect(**kwargs):
        call_count[0] += 1
        e = copy.deepcopy(base_exec)
        if call_count[0] == 1:
            e['nodeResults'][node_id]['status'] = 'running'
        else:
            e['nodeResults'][node_id]['status'] = status_after
        return {'Item': e}

    return side_effect


# ---------------------------------------------------------------------------
# Duplicate completion
# ---------------------------------------------------------------------------

class TestDuplicateCompletion:
    def test_first_completion_advances_and_dispatches_next(self, mock_exec, monkeypatch):
        """Regression guard: the FIRST completion still advances the DAG."""
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_EXEC)}

        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})

        mock_exec['events'].publish_node_started.assert_called_once()
        mock_exec['sqs'].send_message.assert_called_once()
        body = json.loads(mock_exec['sqs'].send_message.call_args.kwargs['MessageBody'])
        assert body['node_id'] == 'n1'

    def test_duplicate_completion_does_not_reinvoke_downstream(self, mock_exec, monkeypatch):
        """A duplicate node-completed delivery must not dispatch n1 twice."""
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.side_effect = \
            _exec_get_item_first_running_then('completed', 'n0', CHAIN_EXEC)

        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})  # duplicate

        # Downstream n1 dispatched exactly once across both deliveries.
        assert mock_exec['sqs'].send_message.call_count == 1
        assert mock_exec['events'].publish_node_started.call_count == 1

    def test_duplicate_completion_of_last_node_completes_execution_once(self, mock_exec, monkeypatch):
        """A duplicate completion of the terminal node emits workflow.completed once."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.side_effect = \
            _exec_get_item_first_running_then('completed', 'n0', SINGLE_EXEC)

        executor.handle_node_completion('exec-single', 'n0', {'ok': True})
        executor.handle_node_completion('exec-single', 'n0', {'ok': True})  # duplicate

        mock_exec['events'].publish_workflow_completed.assert_called_once()

    @given(dup_count=st.integers(min_value=0, max_value=5))
    @settings(max_examples=25, deadline=None)
    def test_any_number_of_duplicates_invoke_downstream_once(self, dup_count):
        """Property: 1 real completion + N duplicates ⇒ downstream invoked once."""
        import executor

        wf_table = MagicMock()
        exec_table = MagicMock()
        ev = MagicMock()
        sqs = MagicMock()
        wf_table.get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        exec_table.get_item.side_effect = \
            _exec_get_item_first_running_then('completed', 'n0', CHAIN_EXEC)

        with patch.object(executor, '_workflows_table', wf_table), \
             patch.object(executor, '_executions_table', exec_table), \
             patch.object(executor, 'events', ev), \
             patch.object(executor, '_get_sqs_client', return_value=sqs), \
             patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
            for _ in range(1 + dup_count):
                executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})

        assert sqs.send_message.call_count == 1
        assert ev.publish_node_started.call_count == 1


# ---------------------------------------------------------------------------
# Duplicate failure
# ---------------------------------------------------------------------------

class TestDuplicateFailure:
    def test_first_failure_fails_execution(self, mock_exec):
        """Regression guard: the FIRST terminal failure still fails the execution."""
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_EXEC)}

        executor.handle_node_failure('exec-single', 'n0', 'FatalError')

        mock_exec['events'].publish_workflow_failed.assert_called_once()

    def test_duplicate_failure_after_terminal_is_noop(self, mock_exec):
        """A duplicate node-failed delivery after terminal failure is a no-op."""
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_WORKFLOW)}
        mock_exec['executions_table'].get_item.side_effect = \
            _exec_get_item_first_running_then('failed', 'n0', SINGLE_EXEC)

        executor.handle_node_failure('exec-single', 'n0', 'FatalError')
        executor.handle_node_failure('exec-single', 'n0', 'FatalError')  # duplicate

        mock_exec['events'].publish_workflow_failed.assert_called_once()

    def test_retry_path_still_works_for_non_terminal_node(self, mock_exec):
        """Guard must not block the legitimate retry path (node not terminal)."""
        import executor

        wf = copy.deepcopy(SINGLE_WORKFLOW)
        defn = json.loads(wf['definition'])
        defn['nodes'][0]['data']['retryPolicy'] = {
            'maxRetries': 3,
            'backoffBase': 1.0,
            'backoffMax': 10.0,
            'retryableErrors': ['TimeoutError'],
        }
        wf['definition'] = json.dumps(defn)

        mock_exec['workflows_table'].get_item.return_value = {'Item': wf}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_EXEC)}

        executor.handle_node_failure('exec-single', 'n0', 'TimeoutError')

        mock_exec['events'].publish_node_retrying.assert_called_once()
        mock_exec['events'].publish_workflow_failed.assert_not_called()
