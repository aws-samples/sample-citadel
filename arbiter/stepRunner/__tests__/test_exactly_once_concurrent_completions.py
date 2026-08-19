"""
Exactly-once dispatch/finalize under concurrent node completions.

The executor's exactly-once invariant rests on three conditional DynamoDB
writes (design decision O3):

  1. dispatch guard   — invoke_node flips a node pending -> running only while
                        it is still 'pending' (ConditionExpression status = pending)
  2. completion guard — the worker writes a node's completed output first-write-wins
                        (exercised in the write-then-signal slice; not here)
  3. finalize guard   — the execution flips running -> completed only while it is
                        still 'running' (ConditionExpression status = running)

This suite pins guards (1) and (3). Its load-bearing test is a MUST-BITE
*differential*: against the SAME stateful conditional-aware table, a faithful
reproduction of the pre-fix UNCONDITIONAL write lets two racing dispatchers
BOTH send (the latent double-dispatch bug, == 2), while the REAL conditional
``invoke_node`` yields exactly one send (== 1). If the differential ever stops
biting (both arms agree), the guard has been silently removed.

The concurrent race is modelled deterministically — no threads, no
scheduler reliance, no mutable state shared across hypothesis examples: each
example builds its own fresh table seeded in the exact convergence race window
(all predecessors of a convergence node persisted 'completed', the convergence
node still 'pending'), then drives N dispatchers against that one table. The
conditional write is the arbiter, so the outcome is a pure function of the
seed.

All AWS is mocked; no real network or credentials are touched.
"""

import copy
import json
import os
import sys
from contextlib import contextmanager

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import dag


# ---------------------------------------------------------------------------
# Stateful, conditional-aware in-memory DynamoDB Table stand-in.
# ---------------------------------------------------------------------------
# Interprets the SET-only UpdateExpressions the executor uses AND the
# ConditionExpression guards. A failed condition raises
# ConditionalCheckFailedException exactly as DynamoDB would, so the executor's
# exactly-once guards are genuinely arbitrated here.


def _apply_set_expression(item, expr, names, values):
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


def _eval_condition_expression(item, expr, names, values):
    expr = expr.strip()
    op = '<>' if '<>' in expr else '='
    lhs, rhs = expr.split(op, 1)
    segments = [seg.strip() for seg in lhs.strip().split('.')]
    resolved = [names[seg] if seg.startswith('#') else seg for seg in segments]
    target = item
    found = True
    for seg in resolved:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            found, target = False, None
            break
    expected = values[rhs.strip()]
    if op == '=':
        return found and target == expected
    return (not found) or target != expected


class ConditionalFakeTable:
    """Stateful boto3 Table stand-in that honors ConditionExpression."""

    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key_name = key_name

    def get_item(self, Key):  # noqa: N803
        val = Key[self._key_name]
        item = self._items.get(val)
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression,  # noqa: N803
                    ConditionExpression=None,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        val = Key[self._key_name]
        item = self._items.setdefault(val, {self._key_name: val})
        if ConditionExpression is not None and not _eval_condition_expression(
                item, ConditionExpression, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException',
                           'Message': 'The conditional request failed'}},
                'UpdateItem',
            )
        _apply_set_expression(item, UpdateExpression, names, values)

    def current(self, val):
        return copy.deepcopy(self._items[val])


# ---------------------------------------------------------------------------
# Builders.
# ---------------------------------------------------------------------------

def _node(nid):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}


def _wf(wid, nodes, edges):
    return {
        'workflowId': wid,
        'name': wid,
        'definition': json.dumps({'nodes': nodes, 'edges': edges}),
        'configuration': json.dumps({}),
    }


def _exec(eid, wid, statuses):
    """Build an execution row with per-node statuses from a {nid: status} map."""
    return {
        'executionId': eid,
        'workflowId': wid,
        'appId': 'app-1',
        'status': 'running',
        'nodeResults': {
            nid: {'nodeId': nid, 'agentId': f'a-{nid}', 'status': status, 'retryCount': 0}
            for nid, status in statuses.items()
        },
    }


@contextmanager
def _patched(wf_item, exec_item):
    import executor

    wf_table = ConditionalFakeTable({wf_item['workflowId']: wf_item}, 'workflowId')
    ex_table = ConditionalFakeTable({exec_item['executionId']: exec_item}, 'executionId')
    sqs = MagicMock()
    ev = MagicMock()
    cw = MagicMock()
    with patch.object(executor, '_workflows_table', wf_table), \
         patch.object(executor, '_executions_table', ex_table), \
         patch.object(executor, 'events', ev), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=cw), \
         patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
        yield executor, sqs, ex_table, ev


def _dispatched(sqs):
    return [
        json.loads(call.kwargs['MessageBody'])['node_id']
        for call in sqs.send_message.call_args_list
    ]


# Diamond: n0 -> n1, n2 -> n3 (n3 is the convergence node, in-degree 2).
DIAMOND_NODES = [_node('n0'), _node('n1'), _node('n2'), _node('n3')]
DIAMOND_EDGES = [
    {'id': 'e0', 'source': 'n0', 'target': 'n1'},
    {'id': 'e1', 'source': 'n0', 'target': 'n2'},
    {'id': 'e2', 'source': 'n1', 'target': 'n3'},
    {'id': 'e3', 'source': 'n2', 'target': 'n3'},
]


def _reproduce_unconditional_dispatch(ex_table, sqs, execution_id, node):
    """Faithful reproduction of the PRE-FIX invoke_node dispatch write: an
    UNCONDITIONAL pending->running SET followed by an SQS send. This is the
    code shape this story replaced; it exists ONLY in this differential test
    so the MUST-BITE red arm proves the conditional guard is what bites.
    """
    node_id = node['id']
    ex_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET nodeResults.#nid.#status = :status',
        ExpressionAttributeNames={'#nid': node_id, '#status': 'status'},
        ExpressionAttributeValues={':status': 'running'},
    )
    sqs.send_message(
        QueueUrl='https://sqs.fake/q',
        MessageBody=json.dumps({'node_id': node_id}),
    )


# ---------------------------------------------------------------------------
# MUST-BITE differential — dispatch guard.
# ---------------------------------------------------------------------------

class TestDispatchGuardDifferential:
    def test_unconditional_write_lets_both_racing_dispatchers_send_twice(self):
        """RED arm: without the ConditionExpression, two racing dispatchers of
        the same 'ready' convergence node both send — the latent double-
        dispatch bug this story fixes (== 2)."""
        wf = _wf('wf-d', DIAMOND_NODES, DIAMOND_EDGES)
        # Convergence race window: both predecessors completed, n3 pending.
        ex = _exec('exec-d', 'wf-d',
                   {'n0': 'completed', 'n1': 'completed', 'n2': 'completed', 'n3': 'pending'})
        n3 = DIAMOND_NODES[3]

        with _patched(wf, ex) as (executor, sqs, ex_table, _ev):
            _reproduce_unconditional_dispatch(ex_table, sqs, 'exec-d', n3)
            _reproduce_unconditional_dispatch(ex_table, sqs, 'exec-d', n3)

        assert _dispatched(sqs).count('n3') == 2

    def test_conditional_invoke_node_dispatches_convergence_node_once(self):
        """GREEN arm: the REAL conditional invoke_node arbitrates — the first
        dispatcher wins pending->running and sends; the second's conditional
        write fails and is a no-op (== 1)."""
        wf = _wf('wf-d', DIAMOND_NODES, DIAMOND_EDGES)
        ex = _exec('exec-d', 'wf-d',
                   {'n0': 'completed', 'n1': 'completed', 'n2': 'completed', 'n3': 'pending'})
        n3 = DIAMOND_NODES[3]

        with _patched(wf, ex) as (executor, sqs, ex_table, _ev):
            executor.invoke_node('exec-d', 'wf-d', n3, {}, {})
            executor.invoke_node('exec-d', 'wf-d', n3, {}, {})

        assert _dispatched(sqs).count('n3') == 1
        assert ex_table.current('exec-d')['nodeResults']['n3']['status'] == 'running'


# ---------------------------------------------------------------------------
# Property: exactly-once dispatch of a convergence node under N dispatchers.
# ---------------------------------------------------------------------------

class TestExactlyOnceProperties:
    @given(
        fanout=st.integers(min_value=2, max_value=6),
        dispatchers=st.integers(min_value=2, max_value=8),
    )
    @settings(max_examples=40, deadline=None)
    def test_convergence_node_dispatched_exactly_once(self, fanout, dispatchers):
        """A convergence node with `fanout` completed predecessors, dispatched
        by `dispatchers` racing callers, is sent exactly once — the conditional
        write is the single serialization point regardless of caller count."""
        preds = [f'p{i}' for i in range(fanout)]
        conv = 'conv'
        nodes = [_node(p) for p in preds] + [_node(conv)]
        edges = [{'id': f'e{i}', 'source': p, 'target': conv} for i, p in enumerate(preds)]
        wf = _wf('wf-c', nodes, edges)
        statuses = {p: 'completed' for p in preds}
        statuses[conv] = 'pending'
        ex = _exec('exec-c', 'wf-c', statuses)
        conv_node = nodes[-1]

        with _patched(wf, ex) as (executor, sqs, ex_table, _ev):
            for _ in range(dispatchers):
                executor.invoke_node('exec-c', 'wf-c', conv_node, {}, {})

        assert _dispatched(sqs).count(conv) == 1
        assert ex_table.current('exec-c')['nodeResults'][conv]['status'] == 'running'

    @given(seed=st.integers(min_value=0, max_value=64))
    @settings(max_examples=30, deadline=None)
    def test_finalize_emits_workflow_completed_exactly_once(self, seed):
        """Two tail nodes complete concurrently: each advancement reads a race
        snapshot in which the OTHER node is already 'completed' (so both
        observe all-nodes-terminal and both attempt the finalize), but the
        running->completed conditional write arbitrates so the terminal
        workflow.completed event fires exactly once.

        Deterministic per seed: `seed` only picks which of the two symmetric
        race orderings runs; there is no thread scheduling and no state shared
        across examples (a fresh table + fresh snapshots per example).
        """
        import executor

        # Two independent tail nodes (no edges) — both must be terminal to
        # finalize. The shared authoritative row starts 'running'.
        wf = _wf('wf-2', [_node('a'), _node('b')], [])
        shared = ConditionalFakeTable(
            {'exec-2': _exec('exec-2', 'wf-2', {'a': 'running', 'b': 'running'})},
            'executionId',
        )

        # Race snapshots: handler for 'a' sees b completed (a itself running);
        # handler for 'b' sees a completed (b itself running). Both therefore
        # compute all-terminal once they mark their own node completed.
        snap_a = _exec('exec-2', 'wf-2', {'a': 'running', 'b': 'completed'})
        snap_b = _exec('exec-2', 'wf-2', {'a': 'completed', 'b': 'running'})
        order = [('a', snap_a), ('b', snap_b)] if seed % 2 == 0 else [('b', snap_b), ('a', snap_a)]
        reads = [copy.deepcopy(s) for _, s in order]

        wf_table = ConditionalFakeTable({'wf-2': wf}, 'workflowId')
        sqs = MagicMock()
        ev = MagicMock()
        cw = MagicMock()

        class _RaceReadTable:
            """get_item returns the queued per-handler race snapshot; every
            mutating write (node-completed SET, conditional finalize) goes to
            the single shared authoritative table so the finalize guard is
            arbitrated against real committed state."""

            def get_item(self, Key):  # noqa: N803
                return {'Item': reads.pop(0)} if reads else shared.get_item(Key)

            def update_item(self, **kwargs):
                return shared.update_item(**kwargs)

        with patch.object(executor, '_workflows_table', wf_table), \
             patch.object(executor, '_executions_table', _RaceReadTable()), \
             patch.object(executor, 'events', ev), \
             patch.object(executor, '_get_sqs_client', return_value=sqs), \
             patch.object(executor, '_get_cloudwatch_client', return_value=cw), \
             patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
            for node_id, _snap in order:
                executor.handle_node_completion('exec-2', node_id, {'ok': True})

        assert ev.publish_workflow_completed.call_count == 1
        assert shared.current('exec-2')['status'] == 'completed'
