"""Unit tests for the step runner Lambda handler's execution_trace_scope
usage at entry (finding 40061019, superseding 3d92ef6b / CIT-181): every
EventBridge-routed detail type must open a trace scope stamped with
run_id/execution_id/correlation_id/node_id/workflow_id from the detail
payload around the routed work, so subsegment annotations export even in
Lambda (where the previous current-segment-first design silently dropped
them). annotate_from_carried remains unchanged/additive.
"""
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import index


def _event(detail_type, detail):
    return {'detail-type': detail_type, 'detail': detail}


def _patched_scope():
    """A MagicMock standing in for execution_trace_scope: supports the
    context-manager protocol and records the kwargs it was constructed
    with, via the mock's own call_args."""
    scope_instance = MagicMock()
    scope_instance.__enter__ = MagicMock(return_value=scope_instance)
    scope_instance.__exit__ = MagicMock(return_value=None)
    factory = MagicMock(return_value=scope_instance)
    return factory, scope_instance


class TestHandlerUsesExecutionTraceScope:
    def test_execution_start_requested_opens_scope_with_execution_and_workflow_id(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        factory, scope_instance = _patched_scope()
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'execution_trace_scope', factory):
            index.handler(_event('execution.start.requested', detail), {})

        factory.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id=None,
            workflow_id='wf-1',
        )
        scope_instance.__enter__.assert_called_once()
        scope_instance.__exit__.assert_called_once()

    def test_node_completed_opens_scope_with_node_and_run_id_when_present(self):
        detail = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeId': 'node-1',
            'runId': 'run-1',
            'correlationId': 'exec-1',
            'output': {},
        }
        factory, scope_instance = _patched_scope()
        with patch.object(index, 'handle_node_completion'), \
             patch.object(index, 'execution_trace_scope', factory):
            index.handler(_event('workflow.node.completed', detail), {})

        factory.assert_called_once_with(
            run_id='run-1',
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id='node-1',
            workflow_id='wf-1',
        )

    def test_node_failed_opens_scope_from_detail(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1', 'nodeId': 'node-1', 'error': 'boom'}
        factory, scope_instance = _patched_scope()
        with patch.object(index, 'handle_node_failure'), \
             patch.object(index, 'execution_trace_scope', factory):
            index.handler(_event('workflow.node.failed', detail), {})

        factory.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id='node-1',
            workflow_id='wf-1',
        )

    def test_correlation_id_falls_back_to_execution_id_when_absent(self):
        detail = {'executionId': 'exec-9', 'workflowId': 'wf-9'}
        factory, scope_instance = _patched_scope()
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'execution_trace_scope', factory):
            index.handler(_event('execution.start.requested', detail), {})

        assert factory.call_args.kwargs['correlation_id'] == 'exec-9'

    def test_dispatch_work_runs_inside_the_scope(self):
        """The routed work (start_execution here) must execute WITHIN the
        `with execution_trace_scope(...):` block, not before/after it."""
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        factory, scope_instance = _patched_scope()
        call_order = []
        scope_instance.__enter__.side_effect = lambda: call_order.append('enter') or scope_instance
        scope_instance.__exit__.side_effect = lambda *a: call_order.append('exit')

        def _start_execution(*_a, **_kw):
            call_order.append('work')

        with patch.object(index, 'start_execution', side_effect=_start_execution), \
             patch.object(index, 'execution_trace_scope', factory):
            index.handler(_event('execution.start.requested', detail), {})

        assert call_order == ['enter', 'work', 'exit']

    def test_no_throw_when_detail_has_none_of_the_ids(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        with patch.object(index, 'start_execution'):
            result = index.handler(_event('execution.start.requested', detail), {})
        assert result == {'statusCode': 200}

    def test_does_not_remove_annotate_from_carried_call(self):
        """annotate_from_carried must still fire on every event, unchanged
        and independent of the trace scope."""
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1', 'traceContext': carried}
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'annotate_from_carried') as mock_annotate_carried:
            index.handler(_event('execution.start.requested', detail), {})

        mock_annotate_carried.assert_called_once_with(carried)
