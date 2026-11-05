"""Unit tests for condition_evaluated and skip_propagated structured log
events emitted by executor._evaluate_and_persist_skips (CIT-283).

Validates that:
  - condition_evaluated is emitted for every conditional edge with the
    correct fields: execution_id, edge, field, operator, expected, actual,
    matched.
  - skip_propagated is emitted when at least one branch is skipped, with
    sorted skipped[] and unreachable[] lists.
  - No skip_propagated event when all conditions match (no skips).
"""

import sys
import os
import json
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import executor


def _mock_executions_table():
    """Return a mock DynamoDB table for the executor."""
    return MagicMock()


def _capture_log_events(capsys):
    """Parse all JSON lines from captured stdout."""
    out = capsys.readouterr().out
    lines = [line.strip() for line in out.strip().split('\n') if line.strip()]
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


class TestConditionEvaluatedLogEvent:
    """Tests for the condition_evaluated structured log event."""

    def test_emits_condition_evaluated_for_matching_edge(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {
                    'id': 'edge-1',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {
                        'field': 'result.route',
                        'operator': 'equals',
                        'value': 'branch-a',
                    },
                },
            ]
            node_results = {'router': {'status': 'completed'}, 'branch-a': {'status': 'pending'}}
            output = {'result': {'route': 'branch-a'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results,
            )

        events = _capture_log_events(capsys)
        cond_events = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(cond_events) == 1
        ev = cond_events[0]
        assert ev['executionId'] == 'exec-1'
        assert ev['edge'] == 'edge-1'
        assert ev['field'] == 'result.route'
        assert ev['operator'] == 'equals'
        assert ev['expected'] == 'branch-a'
        assert ev['actual'] == 'branch-a'
        assert ev['matched'] is True

    def test_emits_condition_evaluated_for_non_matching_edge(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {
                    'id': 'edge-1',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {
                        'field': 'result.route',
                        'operator': 'equals',
                        'value': 'branch-a',
                    },
                },
            ]
            node_results = {'router': {'status': 'completed'}, 'branch-a': {'status': 'pending'}}
            output = {'result': {'route': 'branch-b'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results,
            )

        events = _capture_log_events(capsys)
        cond_events = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(cond_events) == 1
        ev = cond_events[0]
        assert ev['matched'] is False
        assert ev['actual'] == 'branch-b'
        assert ev['expected'] == 'branch-a'

    def test_emits_two_condition_evaluated_for_router_with_two_branches(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {
                    'id': 'edge-a',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
                },
                {
                    'id': 'edge-b',
                    'source': 'router',
                    'target': 'branch-b',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-b'},
                },
            ]
            node_results = {
                'router': {'status': 'completed'},
                'branch-a': {'status': 'pending'},
                'branch-b': {'status': 'pending'},
            }
            output = {'result': {'route': 'branch-b'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results,
            )

        events = _capture_log_events(capsys)
        cond_events = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(cond_events) == 2

        edge_a_ev = [e for e in cond_events if e['edge'] == 'edge-a'][0]
        assert edge_a_ev['matched'] is False
        assert edge_a_ev['actual'] == 'branch-b'

        edge_b_ev = [e for e in cond_events if e['edge'] == 'edge-b'][0]
        assert edge_b_ev['matched'] is True
        assert edge_b_ev['actual'] == 'branch-b'

    def test_no_condition_evaluated_for_unconditional_edge(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {'id': 'edge-1', 'source': 'n1', 'target': 'n2'},
            ]
            node_results = {'n1': {'status': 'completed'}, 'n2': {'status': 'pending'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'n1', {}, edges, node_results,
            )

        events = _capture_log_events(capsys)
        cond_events = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(cond_events) == 0


class TestSkipPropagatedLogEvent:
    """Tests for the skip_propagated structured log event."""

    def test_emits_skip_propagated_when_branch_skipped(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            nodes = [
                {'id': 'router'},
                {'id': 'branch-a'},
                {'id': 'branch-b'},
                {'id': 'merger'},
            ]
            edges = [
                {
                    'id': 'edge-a',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
                },
                {
                    'id': 'edge-b',
                    'source': 'router',
                    'target': 'branch-b',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-b'},
                },
                {'id': 'edge-a-merger', 'source': 'branch-a', 'target': 'merger'},
                {'id': 'edge-b-merger', 'source': 'branch-b', 'target': 'merger'},
            ]
            node_results = {
                'router': {'status': 'completed'},
                'branch-a': {'status': 'pending'},
                'branch-b': {'status': 'pending'},
                'merger': {'status': 'pending'},
            }
            output = {'result': {'route': 'branch-b'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results, nodes,
            )

        events = _capture_log_events(capsys)
        skip_events = [e for e in events if e.get('action') == 'skip_propagated']
        assert len(skip_events) == 1
        ev = skip_events[0]
        assert ev['executionId'] == 'exec-1'
        assert ev['skipped'] == ['branch-a']
        # merger is NOT unreachable because branch-b is still live
        assert ev['unreachable'] == []

    def test_emits_skip_propagated_with_unreachable_merger(self, capsys):
        """When both branches are skipped, merger becomes unreachable."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            nodes = [
                {'id': 'router'},
                {'id': 'branch-a'},
                {'id': 'branch-b'},
                {'id': 'merger'},
            ]
            edges = [
                {
                    'id': 'edge-a',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
                },
                {
                    'id': 'edge-b',
                    'source': 'router',
                    'target': 'branch-b',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-b'},
                },
                {'id': 'edge-a-merger', 'source': 'branch-a', 'target': 'merger'},
                {'id': 'edge-b-merger', 'source': 'branch-b', 'target': 'merger'},
            ]
            node_results = {
                'router': {'status': 'completed'},
                'branch-a': {'status': 'pending'},
                'branch-b': {'status': 'pending'},
                'merger': {'status': 'pending'},
            }
            # Neither branch matches
            output = {'result': {'route': 'branch-c'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results, nodes,
            )

        events = _capture_log_events(capsys)
        skip_events = [e for e in events if e.get('action') == 'skip_propagated']
        assert len(skip_events) == 1
        ev = skip_events[0]
        assert sorted(ev['skipped']) == ['branch-a', 'branch-b']
        assert ev['unreachable'] == ['merger']

    def test_no_skip_propagated_when_all_conditions_match(self, capsys):
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {
                    'id': 'edge-a',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
                },
            ]
            node_results = {
                'router': {'status': 'completed'},
                'branch-a': {'status': 'pending'},
            }
            output = {'result': {'route': 'branch-a'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results,
            )

        events = _capture_log_events(capsys)
        skip_events = [e for e in events if e.get('action') == 'skip_propagated']
        assert len(skip_events) == 0

    def test_skip_propagated_without_nodes_param(self, capsys):
        """When nodes is None (no propagation), skip_propagated still emits
        with empty unreachable list."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [
                {
                    'id': 'edge-a',
                    'source': 'router',
                    'target': 'branch-a',
                    'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
                },
            ]
            node_results = {
                'router': {'status': 'completed'},
                'branch-a': {'status': 'pending'},
            }
            output = {'result': {'route': 'branch-b'}}

            executor._evaluate_and_persist_skips(
                'exec-1', 'router', output, edges, node_results,
                # nodes=None (default) — no propagation
            )

        events = _capture_log_events(capsys)
        skip_events = [e for e in events if e.get('action') == 'skip_propagated']
        assert len(skip_events) == 1
        ev = skip_events[0]
        assert ev['skipped'] == ['branch-a']
        assert ev['unreachable'] == []
