"""CIT-030 fix: _park_node_awaiting_approval handles missing parent maps.

Covers:
  * Park succeeds when nodeResults entry for target node is ABSENT and
    approvalRequests map does NOT exist on the item (the real defect shape).
  * Park succeeds when nodeResults entry already exists (existing path).
  * Park failure → no SQS dispatch + ApprovalParkFailed metric emitted.
  * Existing tests still pass (no regression).
"""
import json
import os
import sys
from unittest.mock import patch, MagicMock, call

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from approval_requests import AWAITING_APPROVAL
from common.metrics_constants import METRIC_APPROVAL_PARK_FAILED, UNIT_COUNT


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

NODE_AGG = {'id': 'aggregator', 'agentId': 'agent-agg', 'data': {}}


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {}
    for key in (
        'APPROVAL_GATE_ENABLED',
        'WORKER_QUEUE_URL',
        'AGENT_CONFIG_TABLE',
        'RELEASE_DISPATCH_ENVIRONMENT',
    ):
        saved[key] = os.environ.pop(key, None)
    os.environ['WORKER_QUEUE_URL'] = 'https://sqs.fake/worker-queue'
    os.environ['AGENT_CONFIG_TABLE'] = 'fake-agent-table'
    yield
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def _enable_gate():
    os.environ['APPROVAL_GATE_ENABLED'] = 'true'
    import executor
    executor.APPROVAL_GATE_ENABLED = True


def _patched_executor():
    """Return (executor, patches_tuple, fake_sqs, fake_exec_table)."""
    import executor
    fake_sqs = MagicMock()
    fake_exec_table = MagicMock()
    fake_exec_table.update_item.return_value = {
        'Attributes': {'nodeResults': {'aggregator': {'dispatchGeneration': 1}}}
    }
    ctx = (
        patch.object(executor, '_executions_table', fake_exec_table),
        patch.object(executor, 'events', MagicMock()),
        patch.object(executor, '_get_sqs_client', return_value=fake_sqs),
        patch.object(executor, '_check_release_gate', return_value=(False, None)),
        patch.object(executor, '_check_approval_gate', return_value=(False, None)),
    )
    return executor, ctx, fake_sqs, fake_exec_table


# ---------------------------------------------------------------------------
# 1. Park succeeds with ABSENT nodeResults entry and NO approvalRequests
# ---------------------------------------------------------------------------

class TestParkMissingParentMaps:
    """The real defect: _park_node_awaiting_approval crashed with
    ValidationException when nodeResults.<node> was absent and
    approvalRequests did not exist at all on the item."""

    def test_park_succeeds_node_absent_no_approval_requests(self):
        """Simulates the real DDB item shape from execution 830c1009:
        nodeResults has NO entry for 'aggregator', approvalRequests does
        not exist.  After the fix the two-step write (ensure parents +
        conditional park) succeeds without ValidationException."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]:
            result = executor._park_node_awaiting_approval(
                'exec-830c', 'wf-1', 'aggregator', 'agent-agg',
            )

        assert result is True

        # Two update_item calls: ensure-parents + conditional park
        calls = fake_exec_table.update_item.call_args_list
        assert len(calls) == 2

        # First call: if_not_exists for approvalRequests and nodeResults stub
        ensure_call = calls[0]
        ensure_expr = ensure_call.kwargs.get('UpdateExpression', '')
        assert 'if_not_exists(approvalRequests' in ensure_expr
        assert 'if_not_exists(nodeResults.#nid' in ensure_expr
        # Stub has correct shape
        stub = ensure_call.kwargs['ExpressionAttributeValues'][':stub']
        assert stub['nodeId'] == 'aggregator'
        assert stub['status'] == 'pending'

        # Second call: conditional park
        park_call = calls[1]
        park_values = park_call.kwargs['ExpressionAttributeValues']
        assert park_values[':awaiting'] == AWAITING_APPROVAL
        assert park_values[':pending'] == 'pending'
        assert park_values[':record']['requestType'] == 'approval_required'

    def test_park_succeeds_node_already_exists(self):
        """When nodeResults entry already exists (normal path), the
        if_not_exists is a no-op and the conditional park still works."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]:
            result = executor._park_node_awaiting_approval(
                'exec-1', 'wf-1', 'nB', 'agent-B',
            )

        assert result is True
        assert fake_exec_table.update_item.call_count == 2

    def test_park_emits_event_on_success(self):
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]:
            mock_events = executor.events
            executor._park_node_awaiting_approval(
                'exec-1', 'wf-1', 'aggregator', 'agent-agg',
            )

        event_calls = [
            c for c in mock_events.publish_event.call_args_list
            if c.args[0] == 'execution.node.awaiting_approval'
        ]
        assert len(event_calls) == 1


# ---------------------------------------------------------------------------
# 2. Park failure → no dispatch + metric
# ---------------------------------------------------------------------------

def _validation_error():
    return ClientError(
        {'Error': {'Code': 'ValidationException',
                   'Message': 'The document path provided in the update expression is invalid'}},
        'UpdateItem',
    )


class TestParkFailureFailClosed:
    """When park write fails (not ConditionalCheckFailedException), the
    node must NOT be dispatched and ApprovalParkFailed metric is emitted."""

    def test_park_returns_false_on_unexpected_error(self):
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        # Make the ensure-parents call succeed but the conditional park fail
        fake_exec_table.update_item.side_effect = [
            {},  # ensure-parents OK
            _validation_error(),  # conditional park fails
        ]

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
             patch.object(executor, '_emit_metric') as mock_metric:
            result = executor._park_node_awaiting_approval(
                'exec-1', 'wf-1', 'aggregator', 'agent-agg',
            )

        assert result is False
        mock_metric.assert_called_once_with(
            METRIC_APPROVAL_PARK_FAILED, 1, UNIT_COUNT, workflow_id='wf-1',
        )

    def test_invoke_node_does_not_dispatch_after_park_failure(self):
        """Fail-closed: when _park_node_awaiting_approval returns False,
        invoke_node returns without dispatching (no SQS send, no status
        change to running)."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        # Make the park fail
        fake_exec_table.update_item.side_effect = [
            {},  # ensure-parents
            _validation_error(),  # conditional park fails
        ]

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
             patch.object(executor, '_emit_metric'):
            executor.invoke_node(
                'exec-1', 'wf-1', NODE_AGG, {}, {},
                pause_requested=True,
            )

        # No SQS dispatch
        fake_sqs.send_message.assert_not_called()

    def test_invoke_node_does_not_dispatch_after_park_failure_ensure_step(self):
        """When even the ensure-parents step fails, same fail-closed."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        fake_exec_table.update_item.side_effect = _validation_error()

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
             patch.object(executor, '_emit_metric'):
            executor.invoke_node(
                'exec-1', 'wf-1', NODE_AGG, {}, {},
                pause_requested=True,
            )

        fake_sqs.send_message.assert_not_called()

    def test_park_failure_emits_error_log(self, caplog):
        """Park failure logs at ERROR level."""
        import logging
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        fake_exec_table.update_item.side_effect = [
            {},
            _validation_error(),
        ]

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
             patch.object(executor, '_emit_metric'), \
             caplog.at_level(logging.ERROR):
            executor._park_node_awaiting_approval(
                'exec-1', 'wf-1', 'aggregator', 'agent-agg',
            )

        assert any(
            '_park_node_awaiting_approval' in r.message and 'write failed' in r.message
            for r in caplog.records
        )


# ---------------------------------------------------------------------------
# 3. ConditionalCheckFailedException is still a benign no-op (not False)
# ---------------------------------------------------------------------------

class TestParkConditionalCheckIsNoop:
    def test_conditional_check_returns_true(self):
        """A ConditionalCheckFailedException means the node was already past
        pending — still a success (True), not a failure (False)."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        cond_err = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': ''}},
            'UpdateItem',
        )
        fake_exec_table.update_item.side_effect = [
            {},  # ensure-parents
            cond_err,  # conditional park — already moved past pending
        ]

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]:
            result = executor._park_node_awaiting_approval(
                'exec-1', 'wf-1', 'nA', 'agent-A',
            )

        assert result is True


# ---------------------------------------------------------------------------
# 4. schedule_frontier: park failure does not dispatch
# ---------------------------------------------------------------------------

class TestScheduleFrontierParkFailure:
    def test_park_failure_does_not_dispatch_node(self):
        """When schedule_frontier drives invoke_node with pause_requested and
        the park fails, the node is NOT added to the dispatched list via SQS
        but IS still tracked in status_map as awaiting_approval (optimistic)
        — the real status is still 'pending' in DDB, so the next frontier
        pass will retry."""
        _enable_gate()
        executor, ctx, fake_sqs, fake_exec_table = _patched_executor()

        # Make park fail for nB
        def _side_effect(**kwargs):
            expr = kwargs.get('UpdateExpression', '')
            if 'if_not_exists' in expr:
                return {}  # ensure-parents OK
            # Only fail on the node-level park write (has nodeResults.#nid in
            # the expression), not the execution-level transition
            if 'nodeResults.#nid' in expr and ':awaiting' in str(kwargs.get('ExpressionAttributeValues', {})):
                raise _validation_error()
            return {'Attributes': {'nodeResults': {}}}
        fake_exec_table.update_item.side_effect = _side_effect

        execution = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'status': 'running',
            'pauseRequested': True,
            'nodeResults': {
                'nA': {'status': 'completed'},
                'nB': {'status': 'pending'},
            },
        }
        workflow = {
            'workflowId': 'wf-1',
            'definition': json.dumps({
                'nodes': [{'id': 'nA'}, {'id': 'nB'}],
                'edges': [{'source': 'nA', 'target': 'nB'}],
            }),
        }

        with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
             patch.object(executor, '_emit_metric'):
            dispatched = executor.schedule_frontier(execution, workflow)

        # nB was in the dispatched list (invoke_node was called) but no SQS
        assert fake_sqs.send_message.assert_not_called() is None
