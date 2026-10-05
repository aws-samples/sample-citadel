"""CIT-030/CIT-031 tests — step runner parks a node on workflow.node.awaiting_approval.

Covers:
  - handle_node_awaiting_approval parks a running node → awaiting_approval
  - Conditional write skips non-running nodes (idempotency)
  - Approval-request record persisted with tool metadata
  - Step runner index.py routes the new detail type
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch, call

import pytest

_STEP_RUNNER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _STEP_RUNNER_DIR not in sys.path:
    sys.path.insert(0, _STEP_RUNNER_DIR)

from botocore.exceptions import ClientError

import executor
import index as step_runner_index


@pytest.fixture
def mock_executions_table():
    mock_table = MagicMock()
    with patch.object(executor, '_executions_table', mock_table):
        yield mock_table


@pytest.fixture
def mock_load_execution():
    with patch.object(executor, '_load_execution') as mock_load:
        yield mock_load


class TestHandleNodeAwaitingApproval:
    """handle_node_awaiting_approval parks a running node."""

    def test_parks_running_node(self, mock_load_execution, mock_executions_table):
        """A running node is transitioned to awaiting_approval with the
        approval-request record containing tool metadata."""
        mock_load_execution.return_value = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeResults': {
                'n0': {'status': 'running', 'agentId': 'agent-1'},
            },
        }
        executor.handle_node_awaiting_approval(
            execution_id='exec-1',
            node_id='n0',
            request_type='tool_approval',
            tool_name='write_db',
            reason='require_approval:write_db',
            idempotency_key='exec-1#n0#write_db#tu-1',
        )

        mock_executions_table.update_item.assert_called_once()
        call_kwargs = mock_executions_table.update_item.call_args[1]
        assert call_kwargs['Key'] == {'executionId': 'exec-1'}
        assert ':awaiting' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':awaiting'] == 'awaiting_approval'
        assert call_kwargs['ExpressionAttributeValues'][':running'] == 'running'
        # Approval record includes tool metadata
        record = call_kwargs['ExpressionAttributeValues'][':record']
        assert record['requestType'] == 'tool_approval'
        assert record['metadata']['toolName'] == 'write_db'
        assert record['metadata']['idempotencyKey'] == 'exec-1#n0#write_db#tu-1'

    def test_skips_non_running_node(self, mock_load_execution, mock_executions_table):
        """A node not in 'running' status is skipped (no DDB write)."""
        mock_load_execution.return_value = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeResults': {
                'n0': {'status': 'pending'},
            },
        }
        executor.handle_node_awaiting_approval(
            execution_id='exec-1',
            node_id='n0',
        )

        mock_executions_table.update_item.assert_not_called()

    def test_conditional_check_failure_is_noop(self, mock_load_execution, mock_executions_table):
        """ConditionalCheckFailedException is handled as a no-op (race/duplicate)."""
        mock_load_execution.return_value = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeResults': {
                'n0': {'status': 'running'},
            },
        }
        mock_executions_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException'}},
            'UpdateItem',
        )
        # Should not raise
        executor.handle_node_awaiting_approval(
            execution_id='exec-1',
            node_id='n0',
        )

    def test_missing_execution_is_noop(self, mock_load_execution, mock_executions_table):
        """A missing execution (None) is a no-op."""
        mock_load_execution.return_value = None
        executor.handle_node_awaiting_approval(
            execution_id='exec-missing',
            node_id='n0',
        )
        mock_executions_table.update_item.assert_not_called()

    def test_other_client_error_reraises(self, mock_load_execution, mock_executions_table):
        """A non-conditional DDB error propagates."""
        mock_load_execution.return_value = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeResults': {
                'n0': {'status': 'running'},
            },
        }
        mock_executions_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError'}},
            'UpdateItem',
        )
        with pytest.raises(ClientError):
            executor.handle_node_awaiting_approval(
                execution_id='exec-1',
                node_id='n0',
            )


class TestStepRunnerRouting:
    """Step runner index.py routes workflow.node.awaiting_approval events."""

    def test_routes_awaiting_approval_event(self):
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'requestType': 'tool_approval',
            'toolName': 'write_db',
            'reason': 'require_approval:write_db',
            'idempotencyKey': 'exec-1#n0#write_db#tu-1',
        }
        event = {
            'detail-type': 'workflow.node.awaiting_approval',
            'detail': detail,
        }
        with patch.object(step_runner_index, 'handle_node_awaiting_approval') as mock_handle:
            result = step_runner_index.handler(event, {})

        mock_handle.assert_called_once_with(
            execution_id='exec-1',
            node_id='n0',
            request_type='tool_approval',
            tool_name='write_db',
            reason='require_approval:write_db',
            idempotency_key='exec-1#n0#write_db#tu-1',
        )
        assert result == {'statusCode': 200}
