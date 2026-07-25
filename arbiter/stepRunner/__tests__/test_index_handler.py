"""
Unit tests for the step runner Lambda handler's EventBridge routing.

Covers the usage-rollup hop's handler-side extraction: a
``workflow.node.completed`` detail carries an additive top-level ``usage``
key (promoted by the worker via ``workflow_contract.build_node_result_detail``).
The handler extracts it and forwards it to
``executor.handle_node_completion`` as a fourth positional/keyword argument,
falling back to ``output.get('usage', [])`` when the top-level key is absent
so an in-flight event emitted before this change still routes correctly.

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

        mock_handle.assert_called_once_with('exec-1', 'n0', detail['output'], usage)

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

        mock_handle.assert_called_once_with('exec-1', 'n0', detail['output'], usage)

    def test_missing_usage_everywhere_defaults_to_empty_list(self):
        detail = {
            'executionId': 'exec-1',
            'nodeId': 'n0',
            'output': {'response': 'ok'},
        }
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with('exec-1', 'n0', detail['output'], [])

    def test_missing_output_key_defaults_output_and_usage(self):
        detail = {'executionId': 'exec-1', 'nodeId': 'n0'}
        with patch.object(index, 'handle_node_completion') as mock_handle:
            index.handler(_event('workflow.node.completed', detail), {})

        mock_handle.assert_called_once_with('exec-1', 'n0', {}, [])

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
