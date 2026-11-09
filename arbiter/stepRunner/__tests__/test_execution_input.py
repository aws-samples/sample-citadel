"""Tests for execution-level input delivery to root nodes.

The execution row's ``input`` field (an AWSJSON string written by the
startExecution resolver) must be parsed and forwarded to every root node
as its ``input_data``. Before this fix, root nodes always received ``{}``.

Cases:
  1. Valid JSON input → root nodes receive the parsed dict.
  2. Absent / empty input → root nodes receive ``{}``.
  3. Invalid JSON → execution transitions to ``failed`` with a clear error.
  4. Multiple root nodes → every root receives the same parsed input.
  5. Existing tests unchanged (no regression).
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock, call


# ---------------------------------------------------------------------------
# Fixtures — reuse the same mock-wiring pattern as test_executor_properties.
# ---------------------------------------------------------------------------

SAMPLE_WORKFLOW = {
    'workflowId': 'wf-001',
    'orgId': 'org-001',
    'name': 'Test Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Root'}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {'label': 'Child'}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'n0', 'target': 'n1'},
        ],
    }),
    'configuration': json.dumps({}),
}

PARALLEL_WORKFLOW = {
    'workflowId': 'wf-par',
    'orgId': 'org-001',
    'name': 'Parallel Roots',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'r1', 'type': 'agent', 'agentId': 'agent-A', 'data': {}},
            {'id': 'r2', 'type': 'agent', 'agentId': 'agent-B', 'data': {}},
            {'id': 'merge', 'type': 'agent', 'agentId': 'agent-C', 'data': {}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'r1', 'target': 'merge'},
            {'id': 'e1', 'source': 'r2', 'target': 'merge'},
        ],
    }),
    'configuration': json.dumps({}),
}


def _make_execution(execution_id='exec-001', workflow_id='wf-001',
                    node_ids=('n0', 'n1'), *, input_value=None):
    """Build a pending execution row with optional input field."""
    exec_row = {
        'executionId': execution_id,
        'workflowId': workflow_id,
        'appId': 'app-001',
        'orgId': 'org-001',
        'status': 'pending',
        'nodeResults': {
            nid: {'nodeId': nid, 'status': 'pending', 'retryCount': 0}
            for nid in node_ids
        },
        'startedAt': '2025-01-01T00:00:00Z',
    }
    if input_value is not None:
        exec_row['input'] = input_value
    return exec_row


@pytest.fixture
def mock_executor(monkeypatch):
    """Patch executor's DynamoDB tables, events module, and SQS client."""
    import executor

    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/queue')

    mock_wf_table = MagicMock()
    mock_exec_table = MagicMock()
    mock_events = MagicMock()
    mock_sqs = MagicMock()

    with patch.object(executor, '_workflows_table', mock_wf_table), \
         patch.object(executor, '_executions_table', mock_exec_table), \
         patch.object(executor, 'events', mock_events), \
         patch.object(executor, '_get_sqs_client', return_value=mock_sqs):
        yield {
            'workflows_table': mock_wf_table,
            'executions_table': mock_exec_table,
            'events': mock_events,
            'sqs': mock_sqs,
            'executor': executor,
        }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestExecutionInputDelivery:
    """Root nodes receive the parsed execution input."""

    def test_root_node_receives_parsed_execution_input(self, mock_executor):
        """A valid JSON input string is parsed and forwarded to the root node."""
        from executor import start_execution

        execution_input = {'route': 'branch-b', 'debug': True}
        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value=json.dumps(execution_input)),
        }

        start_execution('exec-001', 'wf-001')

        # The SQS dispatch should carry the parsed input, not {}.
        sqs = mock_executor['sqs']
        assert sqs.send_message.call_count == 1
        body = json.loads(sqs.send_message.call_args[1]['MessageBody'])
        assert body['input'] == execution_input

    def test_absent_input_defaults_to_empty_dict(self, mock_executor):
        """When the execution row has no ``input`` field, root nodes get {}."""
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        # No 'input' key at all
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value=None),
        }

        start_execution('exec-001', 'wf-001')

        sqs = mock_executor['sqs']
        assert sqs.send_message.call_count == 1
        body = json.loads(sqs.send_message.call_args[1]['MessageBody'])
        assert body['input'] == {}

    def test_empty_string_input_defaults_to_empty_dict(self, mock_executor):
        """An empty-string input is treated as absent → {}."""
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value=''),
        }

        start_execution('exec-001', 'wf-001')

        sqs = mock_executor['sqs']
        assert sqs.send_message.call_count == 1
        body = json.loads(sqs.send_message.call_args[1]['MessageBody'])
        assert body['input'] == {}

    def test_null_input_defaults_to_empty_dict(self, mock_executor):
        """A ``null`` JSON input is treated as absent → {}."""
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value='null'),
        }

        start_execution('exec-001', 'wf-001')

        # 'null' parses to None, which is not a dict → defaults to {}
        sqs = mock_executor['sqs']
        assert sqs.send_message.call_count == 1
        body = json.loads(sqs.send_message.call_args[1]['MessageBody'])
        assert body['input'] == {}

    def test_invalid_json_input_fails_execution(self, mock_executor):
        """Malformed JSON → execution fails with a clear error, no dispatch."""
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value='{not valid json'),
        }

        start_execution('exec-001', 'wf-001')

        # No SQS dispatch should have happened
        sqs = mock_executor['sqs']
        sqs.send_message.assert_not_called()

        # Execution should have been marked as failed
        exec_table = mock_executor['executions_table']
        # Find the update_item call that sets status to 'failed'
        failure_calls = [
            c for c in exec_table.update_item.call_args_list
            if ':status' in str(c) and "'failed'" in str(c)
        ]
        assert len(failure_calls) >= 1, "Expected execution to be marked as failed"
        fail_call = failure_calls[0]
        error_value = fail_call.kwargs.get('ExpressionAttributeValues', {}).get(':error', '')
        assert 'Invalid execution input JSON' in error_value

    def test_multiple_roots_all_receive_execution_input(self, mock_executor):
        """Every root node in a multi-root DAG receives the parsed input."""
        from executor import start_execution

        execution_input = {'route': 'branch-b'}
        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(PARALLEL_WORKFLOW),
        }
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(
                workflow_id='wf-par',
                node_ids=('r1', 'r2', 'merge'),
                input_value=json.dumps(execution_input),
            ),
        }

        start_execution('exec-001', 'wf-par')

        sqs = mock_executor['sqs']
        # Two root nodes (r1, r2) should have been dispatched
        assert sqs.send_message.call_count == 2
        for c in sqs.send_message.call_args_list:
            body = json.loads(c[1]['MessageBody'])
            assert body['input'] == execution_input, (
                f"Root node {body.get('node_id')} did not receive execution input"
            )

    def test_dict_input_value_passthrough(self, mock_executor):
        """If DynamoDB returns input already as a dict (not a string), pass it through."""
        from executor import start_execution

        execution_input = {'foo': 'bar'}
        mock_executor['workflows_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_WORKFLOW),
        }
        # DynamoDB might deserialise maps automatically in some test setups
        mock_executor['executions_table'].get_item.return_value = {
            'Item': _make_execution(input_value=execution_input),
        }

        start_execution('exec-001', 'wf-001')

        sqs = mock_executor['sqs']
        assert sqs.send_message.call_count == 1
        body = json.loads(sqs.send_message.call_args[1]['MessageBody'])
        assert body['input'] == execution_input
