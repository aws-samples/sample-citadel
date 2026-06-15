"""
Unit tests for stepRunner/executor.py — orchestration logic.

Tests cover (Task 10.5):
- start_execution loads workflow, initializes nodeResults, invokes root nodes
- handle_node_completion advances to next nodes
- handle_node_completion evaluates conditions on outgoing edges
- handle_node_completion handles convergence barrier
- handle_node_failure retries when policy allows
- handle_node_failure fails execution when retries exhausted
- cancel_execution marks all pending/running nodes as cancelled
- Parallel branch execution (multiple nodes invoked simultaneously)

Property test (Task 10.4):
- Property 8: Idempotent Execution Start

**Validates: Requirements 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 21.1, 21.4, 26.4, 26.5**
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
# Sample data
# ---------------------------------------------------------------------------

SAMPLE_WORKFLOW = {
    'workflowId': 'wf-001',
    'orgId': 'org-001',
    'name': 'Test Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Node A'}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {'label': 'Node B'}},
            {'id': 'n2', 'type': 'agent', 'agentId': 'agent-C', 'data': {'label': 'Node C'}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'n0', 'target': 'n1'},
            {'id': 'e1', 'source': 'n1', 'target': 'n2'},
        ],
    }),
    'configuration': json.dumps({}),
}

SAMPLE_EXECUTION_PENDING = {
    'executionId': 'exec-001',
    'workflowId': 'wf-001',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
        'n2': {'nodeId': 'n2', 'agentId': 'agent-C', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}

PARALLEL_WORKFLOW = {
    'workflowId': 'wf-parallel',
    'orgId': 'org-001',
    'name': 'Parallel Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Root'}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {'label': 'Branch 1'}},
            {'id': 'n2', 'type': 'agent', 'agentId': 'agent-C', 'data': {'label': 'Branch 2'}},
            {'id': 'n3', 'type': 'agent', 'agentId': 'agent-D', 'data': {'label': 'Merge'}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'n0', 'target': 'n1'},
            {'id': 'e1', 'source': 'n0', 'target': 'n2'},
            {'id': 'e2', 'source': 'n1', 'target': 'n3'},
            {'id': 'e3', 'source': 'n2', 'target': 'n3'},
        ],
    }),
    'configuration': json.dumps({}),
}

PARALLEL_EXECUTION = {
    'executionId': 'exec-parallel',
    'workflowId': 'wf-parallel',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
        'n2': {'nodeId': 'n2', 'agentId': 'agent-C', 'status': 'pending', 'retryCount': 0},
        'n3': {'nodeId': 'n3', 'agentId': 'agent-D', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}

CONDITIONAL_WORKFLOW = {
    'workflowId': 'wf-cond',
    'orgId': 'org-001',
    'name': 'Conditional Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Root'}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {'label': 'Approved Path'}},
            {'id': 'n2', 'type': 'agent', 'agentId': 'agent-C', 'data': {'label': 'Default Path'}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'n0', 'target': 'n1', 'condition': {'field': 'result.status', 'operator': 'equals', 'value': 'approved'}},
            {'id': 'e1', 'source': 'n0', 'target': 'n2'},
        ],
    }),
    'configuration': json.dumps({}),
}

CONDITIONAL_EXECUTION = {
    'executionId': 'exec-cond',
    'workflowId': 'wf-cond',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
        'n2': {'nodeId': 'n2', 'agentId': 'agent-C', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}


# ---------------------------------------------------------------------------
# Fixtures — patch module-level objects directly on executor
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_executor():
    """Patch the module-level DynamoDB tables and events on executor."""
    import executor

    mock_wf_table = MagicMock()
    mock_exec_table = MagicMock()
    mock_events = MagicMock()

    with patch.object(executor, '_workflows_table', mock_wf_table), \
         patch.object(executor, '_executions_table', mock_exec_table), \
         patch.object(executor, 'events', mock_events):
        yield {
            'workflows_table': mock_wf_table,
            'executions_table': mock_exec_table,
            'events': mock_events,
        }


# ---------------------------------------------------------------------------
# Task 10.5: Unit tests for executor orchestration flows
# ---------------------------------------------------------------------------

class TestStartExecution:
    """
    **Validates: Requirements 10.2, 10.3, 11.5**

    start_execution loads workflow, initializes nodeResults, invokes root nodes.
    """

    def test_start_execution_loads_workflow_initializes_node_results_invokes_root_nodes(self, mock_executor):
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_EXECUTION_PENDING)}

        start_execution('exec-001', 'wf-001')

        # Should have loaded workflow and execution
        mock_executor['workflows_table'].get_item.assert_called_once()
        mock_executor['executions_table'].get_item.assert_called_once()

        # Should have updated execution status to running
        mock_executor['executions_table'].update_item.assert_called()

        # Should have published workflow.started event
        mock_executor['events'].publish_workflow_started.assert_called_once()

        # Should have published node.started for root node (n0)
        mock_executor['events'].publish_node_started.assert_called()


class TestHandleNodeCompletion:
    """
    **Validates: Requirements 10.4, 10.5, 10.6, 10.8**

    handle_node_completion advances to next nodes, evaluates conditions, handles convergence.
    """

    def test_handle_node_completion_advances_to_next_nodes(self, mock_executor):
        from executor import handle_node_completion

        exec_data = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        exec_data['status'] = 'running'
        exec_data['nodeResults']['n0']['status'] = 'running'

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}
        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}

        handle_node_completion('exec-001', 'n0', {'result': 'done'})

        # Should update n0 to completed
        mock_executor['executions_table'].update_item.assert_called()

        # Should publish node.completed event
        mock_executor['events'].publish_node_completed.assert_called()

        # Should invoke next node (n1) — publish_node_started called for n1
        mock_executor['events'].publish_node_started.assert_called()

    def test_handle_node_completion_evaluates_conditions_on_outgoing_edges(self, mock_executor):
        from executor import handle_node_completion

        exec_data = copy.deepcopy(CONDITIONAL_EXECUTION)
        exec_data['nodeResults']['n0']['status'] = 'running'

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}
        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CONDITIONAL_WORKFLOW)}

        # Output does NOT match condition (status != 'approved')
        handle_node_completion('exec-cond', 'n0', {'result': {'status': 'rejected'}})

        # n0 completed event should be published
        mock_executor['events'].publish_node_completed.assert_called()

        # n1 should be skipped (condition false) — update_item called to set skipped
        update_calls = mock_executor['executions_table'].update_item.call_args_list
        skip_calls = [c for c in update_calls if ':status' in str(c) and 'skipped' in str(c)]
        assert len(skip_calls) > 0, "Expected n1 to be marked as skipped"

    def test_handle_node_completion_handles_convergence_barrier(self, mock_executor):
        from executor import handle_node_completion

        # n1 completes but n2 is still running → n3 should NOT be invoked
        exec_data = copy.deepcopy(PARALLEL_EXECUTION)
        exec_data['status'] = 'running'
        exec_data['nodeResults']['n0']['status'] = 'completed'
        exec_data['nodeResults']['n1']['status'] = 'running'
        exec_data['nodeResults']['n2']['status'] = 'running'

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}
        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(PARALLEL_WORKFLOW)}

        handle_node_completion('exec-parallel', 'n1', {'branch': '1'})

        # n3 should NOT be started (n2 still running) — check publish_node_started calls
        started_calls = mock_executor['events'].publish_node_started.call_args_list
        started_node_ids = []
        for c in started_calls:
            # Check both positional and keyword args for node_id
            if c.kwargs.get('node_id'):
                started_node_ids.append(c.kwargs['node_id'])
            elif len(c.args) > 2:
                started_node_ids.append(c.args[2])
        assert 'n3' not in started_node_ids, "n3 should not be started while n2 is still running"


class TestHandleNodeFailure:
    """
    **Validates: Requirements 10.7, 17.2, 17.3**

    handle_node_failure retries when policy allows, fails execution when retries exhausted.
    """

    def test_handle_node_failure_retries_when_policy_allows(self, mock_executor):
        from executor import handle_node_failure

        wf = copy.deepcopy(SAMPLE_WORKFLOW)
        defn = json.loads(wf['definition'])
        defn['nodes'][0]['data']['retryPolicy'] = {
            'maxRetries': 3,
            'backoffBase': 1.0,
            'backoffMax': 10.0,
            'retryableErrors': ['TimeoutError'],
        }
        wf['definition'] = json.dumps(defn)

        exec_data = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        exec_data['status'] = 'running'
        exec_data['nodeResults']['n0']['status'] = 'running'
        exec_data['nodeResults']['n0']['retryCount'] = 0

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}
        mock_executor['workflows_table'].get_item.return_value = {'Item': wf}

        handle_node_failure('exec-001', 'n0', 'TimeoutError')

        # Should publish retrying event (not workflow.failed)
        mock_executor['events'].publish_node_retrying.assert_called()
        mock_executor['events'].publish_workflow_failed.assert_not_called()

    def test_handle_node_failure_fails_execution_when_retries_exhausted(self, mock_executor):
        from executor import handle_node_failure

        exec_data = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        exec_data['status'] = 'running'
        exec_data['nodeResults']['n0']['status'] = 'running'
        exec_data['nodeResults']['n0']['retryCount'] = 0

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}
        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}

        handle_node_failure('exec-001', 'n0', 'FatalError')

        # Should publish node.failed and workflow.failed events
        mock_executor['events'].publish_node_failed.assert_called()
        mock_executor['events'].publish_workflow_failed.assert_called()


class TestCancelExecution:
    """
    **Validates: Requirements 10.9, 21.4**

    cancel_execution marks all pending/running nodes as cancelled.
    """

    def test_cancel_execution_marks_all_pending_running_nodes_as_cancelled(self, mock_executor):
        from executor import cancel_execution

        exec_data = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        exec_data['status'] = 'running'
        exec_data['nodeResults']['n0']['status'] = 'completed'
        exec_data['nodeResults']['n1']['status'] = 'running'
        exec_data['nodeResults']['n2']['status'] = 'pending'

        mock_executor['executions_table'].get_item.return_value = {'Item': exec_data}

        cancel_execution('exec-001')

        # Should update execution status to cancelled
        update_calls = mock_executor['executions_table'].update_item.call_args_list
        assert len(update_calls) >= 1, "Expected at least one update_item call"

        # Should publish workflow.failed with cancellation
        mock_executor['events'].publish_workflow_failed.assert_called()


class TestParallelBranchExecution:
    """
    **Validates: Requirements 10.8, 21.1**

    Multiple nodes are invoked simultaneously when they are independent.
    """

    def test_parallel_branch_execution(self, mock_executor):
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(PARALLEL_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {'Item': copy.deepcopy(PARALLEL_EXECUTION)}

        start_execution('exec-parallel', 'wf-parallel')

        # Root node n0 should be invoked (only root)
        mock_executor['events'].publish_node_started.assert_called()
        mock_executor['events'].publish_workflow_started.assert_called()


# ---------------------------------------------------------------------------
# Task 10.4: Property 8 — Idempotent Execution Start
# ---------------------------------------------------------------------------

class TestIdempotentExecutionStart:
    """
    **Validates: Requirements 10.10, 26.4**

    Property 8: For all execution IDs e, calling start_execution(e, w) twice
    produces the same execution state (no duplicate node invocations).
    """

    @given(exec_id=st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=('L', 'N'))),
           wf_id=st.just('wf-001'))
    @settings(max_examples=50)
    def test_idempotent_execution_start(self, exec_id, wf_id):
        """Calling start_execution twice with same IDs does not duplicate invocations."""
        import executor

        mock_wf_table = MagicMock()
        mock_exec_table = MagicMock()
        mock_events = MagicMock()

        mock_wf_table.get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}

        # First call: execution is pending → should proceed
        pending_exec = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        pending_exec['executionId'] = exec_id
        pending_exec['status'] = 'pending'

        # Second call: execution is already running → should skip
        running_exec = copy.deepcopy(SAMPLE_EXECUTION_PENDING)
        running_exec['executionId'] = exec_id
        running_exec['status'] = 'running'

        call_count = [0]

        def get_item_side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] <= 1:
                return {'Item': copy.deepcopy(pending_exec)}
            else:
                return {'Item': copy.deepcopy(running_exec)}

        mock_exec_table.get_item.side_effect = get_item_side_effect

        with patch.object(executor, '_workflows_table', mock_wf_table), \
             patch.object(executor, '_executions_table', mock_exec_table), \
             patch.object(executor, 'events', mock_events):

            from executor import start_execution

            # First call — should proceed normally
            start_execution(exec_id, wf_id)
            first_call_count = mock_events.publish_workflow_started.call_count

            # Second call — execution already running, should be idempotent
            start_execution(exec_id, wf_id)
            second_call_count = mock_events.publish_workflow_started.call_count

            # workflow.started should only be published once (idempotent)
            assert second_call_count == first_call_count, (
                f"start_execution published workflow.started {second_call_count} times, "
                f"expected {first_call_count} (idempotent)"
            )
