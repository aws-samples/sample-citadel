"""Unit tests for the step runner Lambda handler's annotate_execution call
at entry (finding 3d92ef6b / CIT-181): every EventBridge-routed detail
type must stamp run_id/execution_id/correlation_id/node_id/workflow_id
from the detail payload directly, independent of whether a carried
traceContext was present (that's annotate_from_carried's job, unchanged).
"""
import sys
import os
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import index


def _event(detail_type, detail):
    return {'detail-type': detail_type, 'detail': detail}


class TestHandlerAnnotatesExecutionIds:
    def test_execution_start_requested_annotates_execution_and_workflow_id(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'annotate_execution') as mock_annotate:
            index.handler(_event('execution.start.requested', detail), {})

        mock_annotate.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id=None,
            workflow_id='wf-1',
        )

    def test_node_completed_annotates_node_and_run_id_when_present(self):
        detail = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'nodeId': 'node-1',
            'runId': 'run-1',
            'correlationId': 'exec-1',
            'output': {},
        }
        with patch.object(index, 'handle_node_completion'), \
             patch.object(index, 'annotate_execution') as mock_annotate:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_annotate.assert_called_once_with(
            run_id='run-1',
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id='node-1',
            workflow_id='wf-1',
        )

    def test_node_failed_annotates_from_detail(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1', 'nodeId': 'node-1', 'error': 'boom'}
        with patch.object(index, 'handle_node_failure'), \
             patch.object(index, 'annotate_execution') as mock_annotate:
            index.handler(_event('workflow.node.failed', detail), {})

        mock_annotate.assert_called_once_with(
            run_id=None,
            execution_id='exec-1',
            correlation_id='exec-1',
            node_id='node-1',
            workflow_id='wf-1',
        )

    def test_correlation_id_falls_back_to_execution_id_when_absent(self):
        detail = {'executionId': 'exec-9', 'workflowId': 'wf-9'}
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'annotate_execution') as mock_annotate:
            index.handler(_event('execution.start.requested', detail), {})

        assert mock_annotate.call_args.kwargs['correlation_id'] == 'exec-9'

    def test_no_throw_when_detail_has_none_of_the_ids(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        with patch.object(index, 'start_execution'):
            result = index.handler(_event('execution.start.requested', detail), {})
        assert result == {'statusCode': 200}

    def test_does_not_remove_annotate_from_carried_call(self):
        """annotate_execution is additive — the existing carried-context
        annotation call must still fire on every event."""
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1', 'traceContext': carried}
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'annotate_from_carried') as mock_annotate_carried:
            index.handler(_event('execution.start.requested', detail), {})

        mock_annotate_carried.assert_called_once_with(carried)
