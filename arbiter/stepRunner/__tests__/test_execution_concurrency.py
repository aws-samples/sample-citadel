"""
Concurrency + convergence tests for the step runner.

These are integration-style tests: they drive the *real* executor DAG logic
against a stateful in-memory stand-in for the executions table, so each
node-completion handler reads back exactly the state prior handlers persisted
(mirroring DynamoDB's read-after-write within a single execution row).

They prove three coordination properties:

(a) **Fan-out concurrency** — multiple root/ready nodes are all dispatched in a
    single handler pass (one SQS send each), not serialized one per event.
(b) **Convergence barrier** — a convergence node (in-degree > 1) is NOT
    dispatched until ALL of its predecessors are terminal (completed/skipped).
    A single completed predecessor while another is still running must not
    release the barrier.
(c) **Duplicate / out-of-order safety** — regardless of the order predecessor
    completions arrive, and no matter how many duplicates are delivered, the
    convergence node is dispatched exactly once.

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import json
import copy
from contextlib import contextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st

import dag


# ---------------------------------------------------------------------------
# Stateful in-memory DynamoDB Table stand-in.
# ---------------------------------------------------------------------------
# Interprets the SET-only UpdateExpressions executor.py uses (both top-level
# and nested `nodeResults.#nid.#attr` paths). get_item returns a deep copy so
# callers cannot mutate stored state, matching DynamoDB's value semantics.


def _apply_set_expression(item, expr, names, values):
    """Apply a `SET a = :x, b.#c = :y` update to *item* in place."""
    body = expr.strip()
    assert body.upper().startswith('SET '), f"unsupported expression: {expr!r}"
    body = body[4:]
    for assignment in body.split(','):
        lhs, rhs = assignment.split('=')
        segments = [seg.strip() for seg in lhs.strip().split('.')]
        resolved = [names[seg] if seg.startswith('#') else seg for seg in segments]
        value = values[rhs.strip()]
        target = item
        for seg in resolved[:-1]:
            target = target.setdefault(seg, {})
        target[resolved[-1]] = value


class FakeTable:
    """Minimal stateful stand-in for a boto3 DynamoDB Table."""

    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key_name = key_name

    def get_item(self, Key):  # noqa: N803 — boto3 kwarg name
        val = Key[self._key_name]
        item = self._items.get(val)
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression,  # noqa: N803 — boto3 kwarg names
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        val = Key[self._key_name]
        item = self._items.setdefault(val, {self._key_name: val})
        _apply_set_expression(
            item, UpdateExpression,
            ExpressionAttributeNames or {}, ExpressionAttributeValues or {},
        )

    def current(self, val):
        return copy.deepcopy(self._items[val])


# ---------------------------------------------------------------------------
# Workflow / execution builders.
# ---------------------------------------------------------------------------

def _node(nid):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}


def _wf(wid, nodes, edges, configuration=None):
    return {
        'workflowId': wid,
        'name': wid,
        'definition': json.dumps({'nodes': nodes, 'edges': edges}),
        'configuration': json.dumps(configuration or {}),
    }


def _exec(eid, wid, node_ids, status='pending'):
    return {
        'executionId': eid,
        'workflowId': wid,
        'appId': 'app-1',
        'status': status,
        'nodeResults': {
            nid: {'nodeId': nid, 'agentId': f'a-{nid}', 'status': 'pending', 'retryCount': 0}
            for nid in node_ids
        },
    }


@contextmanager
def _patched(wf_item, exec_item):
    """Patch executor to run against fresh fake tables + mocked side-effects."""
    import executor

    wf_table = FakeTable({wf_item['workflowId']: wf_item}, 'workflowId')
    ex_table = FakeTable({exec_item['executionId']: exec_item}, 'executionId')
    sqs = MagicMock()
    events = MagicMock()
    cw = MagicMock()
    with patch.object(executor, '_workflows_table', wf_table), \
         patch.object(executor, '_executions_table', ex_table), \
         patch.object(executor, 'events', events), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=cw), \
         patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
        yield executor, sqs, ex_table, events


def _dispatched(sqs):
    """Ordered list of node_ids dispatched to the worker queue so far."""
    return [
        json.loads(call.kwargs['MessageBody'])['node_id']
        for call in sqs.send_message.call_args_list
    ]


# Diamond: n0 fans out to n1 + n2, which converge on n3 (in-degree 2).
DIAMOND_NODES = [_node('n0'), _node('n1'), _node('n2'), _node('n3')]
DIAMOND_EDGES = [
    {'id': 'e0', 'source': 'n0', 'target': 'n1'},
    {'id': 'e1', 'source': 'n0', 'target': 'n2'},
    {'id': 'e2', 'source': 'n1', 'target': 'n3'},
    {'id': 'e3', 'source': 'n2', 'target': 'n3'},
]


def _diamond_env():
    wf = _wf('wf-d', DIAMOND_NODES, DIAMOND_EDGES)
    ex = _exec('exec-d', 'wf-d', ['n0', 'n1', 'n2', 'n3'])
    return _patched(wf, ex)


# ---------------------------------------------------------------------------
# (a) Fan-out concurrency
# ---------------------------------------------------------------------------

class TestFanOutConcurrency:
    def test_start_execution_dispatches_all_roots_in_one_pass(self):
        # Two independent roots converging on m — start must dispatch BOTH roots.
        nodes = [_node('r0'), _node('r1'), _node('m')]
        edges = [
            {'id': 'e0', 'source': 'r0', 'target': 'm'},
            {'id': 'e1', 'source': 'r1', 'target': 'm'},
        ]
        wf = _wf('wf-2r', nodes, edges)
        ex = _exec('exec-2r', 'wf-2r', ['r0', 'r1', 'm'])

        with _patched(wf, ex) as (executor, sqs, _table, _events):
            executor.start_execution('exec-2r', 'wf-2r')

        assert sorted(_dispatched(sqs)) == ['r0', 'r1']

    def test_completion_dispatches_all_ready_downstream_in_one_pass(self):
        # n0 fans out to three children — completing n0 dispatches all three.
        children = ['c0', 'c1', 'c2']
        nodes = [_node('n0')] + [_node(c) for c in children]
        edges = [{'id': f'e{i}', 'source': 'n0', 'target': c} for i, c in enumerate(children)]
        wf = _wf('wf-fan', nodes, edges)
        ex = _exec('exec-fan', 'wf-fan', ['n0'] + children)

        with _patched(wf, ex) as (executor, sqs, _table, _events):
            executor.start_execution('exec-fan', 'wf-fan')
            assert _dispatched(sqs) == ['n0']
            executor.handle_node_completion('exec-fan', 'n0', {'ok': True})

        dispatched = _dispatched(sqs)
        assert dispatched[0] == 'n0'
        assert sorted(dispatched[1:]) == sorted(children)

    @given(width=st.integers(min_value=2, max_value=6))
    @settings(max_examples=20, deadline=None)
    def test_fanout_width_dispatches_every_child_once(self, width):
        children = [f'c{i}' for i in range(width)]
        nodes = [_node('n0')] + [_node(c) for c in children]
        edges = [{'id': f'e{i}', 'source': 'n0', 'target': c} for i, c in enumerate(children)]
        wf = _wf('wf-fan', nodes, edges)
        ex = _exec('exec-fan', 'wf-fan', ['n0'] + children)

        with _patched(wf, ex) as (executor, sqs, _table, _events):
            executor.start_execution('exec-fan', 'wf-fan')
            executor.handle_node_completion('exec-fan', 'n0', {'ok': True})
            dispatched = _dispatched(sqs)

        assert dispatched[0] == 'n0'
        assert sorted(dispatched[1:]) == sorted(children)
        assert len(dispatched) == 1 + width


# ---------------------------------------------------------------------------
# (b) Convergence barrier
# ---------------------------------------------------------------------------

class TestConvergenceBarrier:
    def test_n3_is_a_convergence_node(self):
        assert 'n3' in dag.find_convergence_nodes(DIAMOND_NODES, DIAMOND_EDGES)

    def test_convergence_not_released_by_single_completed_predecessor(self):
        with _diamond_env() as (executor, sqs, _table, _events):
            executor.start_execution('exec-d', 'wf-d')
            executor.handle_node_completion('exec-d', 'n0', {'ok': True})
            assert sorted(_dispatched(sqs)) == ['n0', 'n1', 'n2']

            # Only n1 completes; n2 is still running → n3 must NOT dispatch.
            executor.handle_node_completion('exec-d', 'n1', {'ok': True})
            assert 'n3' not in _dispatched(sqs)

            # n2 completes → both predecessors terminal → n3 dispatched once.
            executor.handle_node_completion('exec-d', 'n2', {'ok': True})
            assert _dispatched(sqs).count('n3') == 1

    def test_convergence_released_with_skipped_predecessor(self):
        # n0->n1 edge is conditional-false → n1 skipped; n3 still converges
        # once n2 completes because 'skipped' is a terminal predecessor state.
        edges = copy.deepcopy(DIAMOND_EDGES)
        edges[0]['condition'] = {'field': 'route', 'operator': 'equals', 'value': 'left'}
        wf = _wf('wf-d', DIAMOND_NODES, edges)
        ex = _exec('exec-d', 'wf-d', ['n0', 'n1', 'n2', 'n3'])

        with _patched(wf, ex) as (executor, sqs, table, _events):
            executor.start_execution('exec-d', 'wf-d')
            # n0 emits route=right → the n0->n1 edge condition is false.
            executor.handle_node_completion('exec-d', 'n0', {'route': 'right'})
            assert table.current('exec-d')['nodeResults']['n1']['status'] == 'skipped'
            assert 'n3' not in _dispatched(sqs)  # n2 still running

            executor.handle_node_completion('exec-d', 'n2', {'ok': True})
            assert _dispatched(sqs).count('n3') == 1


# ---------------------------------------------------------------------------
# (c) Duplicate / out-of-order safety
# ---------------------------------------------------------------------------

class TestConvergenceDuplicateAndOrder:
    def test_out_of_order_completion_still_converges_once(self):
        with _diamond_env() as (executor, sqs, _table, _events):
            executor.start_execution('exec-d', 'wf-d')
            executor.handle_node_completion('exec-d', 'n0', {'ok': True})

            # n2 completes BEFORE n1 (reverse of dispatch order).
            executor.handle_node_completion('exec-d', 'n2', {'ok': True})
            assert 'n3' not in _dispatched(sqs)
            executor.handle_node_completion('exec-d', 'n1', {'ok': True})
            assert _dispatched(sqs).count('n3') == 1

    def test_duplicate_predecessor_completions_do_not_double_release(self):
        with _diamond_env() as (executor, sqs, _table, _events):
            executor.start_execution('exec-d', 'wf-d')
            executor.handle_node_completion('exec-d', 'n0', {'ok': True})

            # n1 delivered twice, then n2 delivered twice.
            executor.handle_node_completion('exec-d', 'n1', {'ok': True})
            executor.handle_node_completion('exec-d', 'n1', {'ok': True})
            assert 'n3' not in _dispatched(sqs)
            executor.handle_node_completion('exec-d', 'n2', {'ok': True})
            executor.handle_node_completion('exec-d', 'n2', {'ok': True})

            assert _dispatched(sqs).count('n3') == 1

    @given(order=st.permutations(['n1', 'n2']))
    @settings(max_examples=10, deadline=None)
    def test_convergence_exactly_once_any_predecessor_order(self, order):
        with _diamond_env() as (executor, sqs, _table, _events):
            executor.start_execution('exec-d', 'wf-d')
            executor.handle_node_completion('exec-d', 'n0', {'ok': True})

            first, second = order
            executor.handle_node_completion('exec-d', first, {'ok': True})
            # After only the first predecessor, the barrier holds.
            assert 'n3' not in _dispatched(sqs)
            executor.handle_node_completion('exec-d', second, {'ok': True})

            dispatched = _dispatched(sqs)
            assert dispatched.count('n3') == 1
            # Full set dispatched exactly once each.
            assert sorted(dispatched) == ['n0', 'n1', 'n2', 'n3']
