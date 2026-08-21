"""
Kill-resume simulation + resume-contract tests for the step runner
(decisions O1 + O5, and the server-side-frontier-re-derivation security gate).

resume_execution is advance-only: it re-derives the ready frontier purely from
the persisted EXECUTIONS_TABLE row (never a caller node list), dispatches only
pending-ready nodes, NEVER re-dispatches a 'running' node, rejects terminal
states, and is idempotent on a running execution.

The kill-resume property models the lost-signal scenario: a topological prefix
completed (persisted by the worker's write-then-signal write) but the
node.completed signal was lost, so downstream stayed 'pending'. resume
re-derives the frontier and drives the run to completion, each node dispatched
and completed exactly once — no completed node re-dispatched.

All AWS is mocked; deterministic per seed (no threads, no cross-example state).
"""

import copy
import json
import os
import sys
from collections import Counter
from contextlib import contextmanager

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import dag


def _apply_set_expression(item, expr, names, values):
    body = expr.strip()[4:]
    # PR2 dispatch-generation fence: strip + apply an optional trailing ADD
    # clause (per-node counter) before parsing the SET assignments.
    _ai = body.upper().find(' ADD ')
    if _ai != -1:
        _add_body = body[_ai + 5:]
        body = body[:_ai]
        for _clause in _add_body.split(','):
            _parts = _clause.split()
            _segs = [s.strip() for s in _parts[0].split('.')]
            _res = [names[s] if s.startswith('#') else s for s in _segs]
            _delta = values[_parts[1]]
            _t = item
            for _s in _res[:-1]:
                _t = _t.setdefault(_s, {})
            _t[_res[-1]] = _t.get(_res[-1], 0) + _delta
    for assignment in body.split(','):
        lhs, rhs = assignment.split('=')
        resolved = [names[s.strip()] if s.strip().startswith('#') else s.strip()
                    for s in lhs.strip().split('.')]
        target = item
        for seg in resolved[:-1]:
            target = target.setdefault(seg, {})
        target[resolved[-1]] = values[rhs.strip()]


def _eval_condition_expression(item, expr, names, values):
    expr = expr.strip()
    op = '<>' if '<>' in expr else '='
    lhs, rhs = expr.split(op, 1)
    resolved = [names[s.strip()] if s.strip().startswith('#') else s.strip()
                for s in lhs.strip().split('.')]
    target, found = item, True
    for seg in resolved:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            found, target = False, None
            break
    expected = values[rhs.strip()]
    return (found and target == expected) if op == '=' else ((not found) or target != expected)


class FakeTable:
    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key = key_name

    def get_item(self, Key):  # noqa: N803
        item = self._items.get(Key[self._key])
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        item = self._items.setdefault(Key[self._key], {self._key: Key[self._key]})
        if ConditionExpression is not None and not _eval_condition_expression(
                item, ConditionExpression, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'failed'}},
                'UpdateItem',
            )
        _apply_set_expression(item, UpdateExpression, names, values)

    def current(self, val):
        return copy.deepcopy(self._items[val])


def _node(nid):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}


def _chain_wf(n):
    nodes = [_node(f'n{i}') for i in range(n)]
    edges = [{'id': f'e{i}', 'source': f'n{i}', 'target': f'n{i+1}'} for i in range(n - 1)]
    return {'workflowId': 'wf', 'name': 'wf',
            'definition': json.dumps({'nodes': nodes, 'edges': edges}),
            'configuration': json.dumps({})}


def _exec(statuses, status='running'):
    return {
        'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1', 'status': status,
        'nodeResults': {nid: {'nodeId': nid, 'agentId': f'a-{nid}', 'status': s, 'retryCount': 0}
                        for nid, s in statuses.items()},
    }


@contextmanager
def _patched(wf, ex):
    import executor
    wf_table = FakeTable({'wf': wf}, 'workflowId')
    ex_table = FakeTable({'exec': ex}, 'executionId')
    sqs, ev, cw = MagicMock(), MagicMock(), MagicMock()
    with patch.object(executor, '_workflows_table', wf_table), \
         patch.object(executor, '_executions_table', ex_table), \
         patch.object(executor, 'events', ev), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=cw), \
         patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
        yield executor, sqs, ex_table, ev


def _dispatched(sqs):
    return [json.loads(c.kwargs['MessageBody'])['node_id'] for c in sqs.send_message.call_args_list]


def _drive_to_completion(executor, sqs, exec_id='exec'):
    """Simulate workers completing every newly dispatched node (write-then-
    signal + delivered signal => handle_node_completion), until the frontier
    drains. Returns the ordered dispatch log."""
    processed = set()
    for _ in range(1000):  # bounded; real DAGs converge well within this
        todo = [n for n in _dispatched(sqs) if n not in processed]
        if not todo:
            break
        for nid in todo:
            processed.add(nid)
            executor.handle_node_completion(exec_id, nid, {'ok': True})
    return _dispatched(sqs)


class TestKillResumeSimulation:
    @given(n=st.integers(min_value=2, max_value=8), cut=st.integers(min_value=0, max_value=7))
    @settings(max_examples=50, deadline=None)
    def test_lost_signal_resume_drives_to_completion_exactly_once(self, n, cut):
        """A topological prefix completed (worker persisted it) but the signal
        was lost so downstream stayed 'pending'. resume re-derives the frontier
        and drives to completion; every post-resume dispatch happens once, no
        completed node is re-dispatched, and the execution finalizes."""
        cut = cut % n  # number of leading nodes already completed (0..n-1)
        wf = _chain_wf(n)
        statuses = {}
        for i in range(n):
            statuses[f'n{i}'] = 'completed' if i < cut else 'pending'
        ex = _exec(statuses)

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            dispatched = _drive_to_completion(executor, sqs)

            # No already-completed prefix node is re-dispatched.
            for i in range(cut):
                assert f'n{i}' not in dispatched
            # Every node dispatched post-resume is dispatched exactly once.
            counts = Counter(dispatched)
            assert all(v == 1 for v in counts.values()), counts
            # Execution reached terminal completed, all nodes completed.
            row = ex_table.current('exec')
            assert row['status'] == 'completed'
            assert all(nr['status'] == 'completed' for nr in row['nodeResults'].values())
            ev.publish_workflow_completed.assert_called_once()


class TestResumeContract:
    def test_resume_never_redispatches_running_node(self):
        """O1: resume advances from completed + dispatches pending, but NEVER
        re-dispatches a 'running' node (a possibly-live worker) — that is the
        watchdog stall-detector's job."""
        wf = _chain_wf(3)  # n0 -> n1 -> n2
        ex = _exec({'n0': 'completed', 'n1': 'running', 'n2': 'pending'})
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            # n1 is running (not pending) -> not dispatched; n2 gated behind n1.
            assert _dispatched(sqs) == []
            assert ex_table.current('exec')['nodeResults']['n1']['status'] == 'running'

    def test_resume_dispatches_only_pending_ready_frontier(self):
        """resume re-derives the frontier from persisted state: a completed
        node whose successor is still pending gets that successor dispatched."""
        wf = _chain_wf(3)
        ex = _exec({'n0': 'completed', 'n1': 'pending', 'n2': 'pending'})
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            assert _dispatched(sqs) == ['n1']  # only the ready frontier, not n2

    def test_resume_is_idempotent_on_running(self):
        """Two resumes of a running execution dispatch the pending frontier
        exactly once total (conditional dispatch guard absorbs the second)."""
        wf = _chain_wf(2)
        ex = _exec({'n0': 'completed', 'n1': 'pending'})
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            executor.resume_execution('exec')
            assert _dispatched(sqs).count('n1') == 1

    def test_resume_of_pending_execution_dispatches_roots(self):
        """A pending execution resume == (re)start: flip to running and
        dispatch roots."""
        wf = _chain_wf(2)
        ex = _exec({'n0': 'pending', 'n1': 'pending'}, status='pending')
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            assert _dispatched(sqs) == ['n0']
            assert ex_table.current('exec')['status'] == 'running'

    @pytest.mark.parametrize('terminal', ['completed', 'cancelled', 'failed'])
    def test_resume_rejects_terminal_states(self, terminal):
        """O5: completed/cancelled/failed are not resumable — no dispatch, no
        event, row unchanged."""
        wf = _chain_wf(2)
        ex = _exec({'n0': 'completed', 'n1': 'pending'}, status=terminal)
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')
            assert _dispatched(sqs) == []
            ev.publish_workflow_completed.assert_not_called()
            assert ex_table.current('exec')['status'] == terminal

    def test_resume_missing_execution_is_noop(self):
        wf = _chain_wf(2)
        ex = _exec({'n0': 'pending', 'n1': 'pending'})
        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('does-not-exist')
            assert _dispatched(sqs) == []

    def test_resume_signature_accepts_only_execution_id(self):
        """SECURITY: the server re-derives the frontier from persisted state.
        resume_execution's only parameter is executionId — there is no code
        path for a caller-supplied node list / status override."""
        import inspect
        import executor
        params = list(inspect.signature(executor.resume_execution).parameters)
        assert params == ['execution_id']
