"""
Unit tests for the step runner Lambda handler's EventBridge routing.

Covers the usage-rollup hop's handler-side extraction: a
``workflow.node.completed`` detail carries an additive top-level ``usage``
key (promoted by the worker via ``workflow_contract.build_node_result_detail``).
The handler extracts it and forwards it to
``executor.handle_node_completion`` as a fourth positional/keyword argument,
falling back to ``output.get('usage', [])`` when the top-level key is absent
so an in-flight event emitted before this change still routes correctly.

Also covers the queue-wait metric's handler-side extraction: the detail's
additive ``dispatchedAt`` / ``workerStartedAt`` keys are forwarded to
``executor.handle_node_completion`` as ``dispatched_at`` / ``worker_started_at``
keyword arguments, defaulting to ``None`` when absent (pre-feature worker).

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import index


def _event(detail_type, detail):
    return {'detail-type': detail_type, 'detail': detail}


class TestNodeCompletedUsageExtraction:
    def test_top_level_usage_is_forwarded_to_handle_node_completion(self):
        usage = [{'inputTokens': 3, 'outputTokens': 4}]
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok', 'usage': usage},
            'usage': usage,
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with(
            'exec-1', 'n0', detail['output'], usage,
            dispatched_at=None, worker_started_at=None,
        )

    def test_missing_top_level_usage_falls_back_to_output_usage(self):
        """An in-flight event emitted before this change carries no top-level
        'usage' key — the handler falls back to output['usage']."""
        usage = [{'inputTokens': 1, 'outputTokens': 2}]
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok', 'usage': usage},
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with(
            'exec-1', 'n0', detail['output'], usage,
            dispatched_at=None, worker_started_at=None,
        )

    def test_missing_usage_everywhere_defaults_to_empty_list(self):
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok'},
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with(
            'exec-1', 'n0', detail['output'], [],
            dispatched_at=None, worker_started_at=None,
        )

    def test_missing_output_key_defaults_output_and_usage(self):
        detail = {'executionId': 'exec-1', 'nodeId': 'n0'}
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with(
            'exec-1', 'n0', {}, [],
            dispatched_at=None, worker_started_at=None,
        )

    def test_other_detail_types_are_unaffected(self):
        with patch.object(index, 'handle_node_failure') as mock_fail:
            index.handler(_event('workflow.node.failed', {
                'executionId': 'exec-1', 'nodeId': 'n0', 'error': 'boom',
            }), {})
        mock_fail.assert_called_once_with('exec-1', 'n0', 'boom')

    def test_handler_returns_status_code_200(self):
        with patch.object(index, 'handle_node_completion'):
            result = index.handler(_event('workflow.node.completed', {
                'executionId': 'exec-1', 'nodeId': 'n0', 'output': {},
            }), {})
        assert result == {'statusCode': 200}


class TestNodeCompletedQueueWaitExtraction:
    def test_dispatched_at_and_worker_started_at_are_forwarded(self):
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok'},
            'dispatchedAt': '2026-01-01T00:00:00+00:00',
            'workerStartedAt': '2026-01-01T00:00:01+00:00',
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with(
            'exec-1', 'n0', detail['output'], [],
            dispatched_at='2026-01-01T00:00:00+00:00',
            worker_started_at='2026-01-01T00:00:01+00:00',
        )

    def test_absent_timestamps_forward_as_none(self):
        """Pre-feature worker: neither key present on the detail. The handler
        must not fabricate a value — both forwarded kwargs are None."""
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok'},
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        _, kwargs = mock_handle.call_args
        assert kwargs['dispatched_at'] is None
        assert kwargs['worker_started_at'] is None
