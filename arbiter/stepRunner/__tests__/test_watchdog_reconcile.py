"""
Watchdog reconcile tests (decision O4): a lost node-completed event is
reconciled within ONE sweep.

Under write-then-signal the worker persists a node 'completed' before emitting
the signal, so a dropped signal leaves a durable-but-un-advanced frontier: a
completed node whose successor is still 'pending'. The watchdog shares the
executor's schedule_frontier to re-derive and dispatch that frontier (or
finalize a run whose terminal signal was lost). A genuinely in-progress node
(running, within the stall threshold) is left untouched.

All AWS is mocked; deterministic, no threads.
"""

import copy
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import pytest
from unittest.mock import patch, MagicMock
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import timeout_watchdog as watchdog
import executor


def _apply_set_expression(item, expr, names, values):
    body = expr.strip()[4:]
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
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        names, values = ExpressionAttributeNames or {}, ExpressionAttributeValues or {}
        item = self._items.setdefault(Key[self._key], {self._key: Key[self._key]})
        if ConditionExpression is not None and not _eval_condition_expression(
                item, ConditionExpression, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'failed'}},
                'UpdateItem',
            )
        _apply_set_expression(item, UpdateExpression, names, values)

    def scan(self, **kwargs):  # noqa: N803 — running-only filter
        running = [copy.deepcopy(v) for v in self._items.values()
                   if v.get('status') == 'running']
        return {'Items': running}

    def current(self, val):
        return copy.deepcopy(self._items[val])


def _iso(delta_seconds):
    return (datetime.now(timezone.utc) - timedelta(seconds=delta_seconds)).isoformat()


def _node(nid):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}


def _chain_wf(n):
    nodes = [_node(f'n{i}') for i in range(n)]
    edges = [{'id': f'e{i}', 'source': f'n{i}', 'target': f'n{i+1}'} for i in range(n - 1)]
    return {'workflowId': 'wf', 'definition': json.dumps({'nodes': nodes, 'edges': edges}),
            'configuration': json.dumps({})}


def _exec(node_statuses, *, started_delta=30, node_started_delta=30, status='running'):
    nr = {}
    for nid, s in node_statuses.items():
        entry = {'nodeId': nid, 'agentId': f'a-{nid}', 'status': s, 'retryCount': 0}
        if s == 'running':
            entry['startedAt'] = _iso(node_started_delta)
        nr[nid] = entry
    return {'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'status': status, 'startedAt': _iso(started_delta), 'nodeResults': nr}


@pytest.fixture
def wd_env(monkeypatch):
    monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
    monkeypatch.setenv('NODE_STALL_TIMEOUT_SECONDS', '900')
    monkeypatch.setenv('NODE_STALL_FACTOR', '2')  # 1800s stall threshold
    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/q')


from contextlib import contextmanager


@contextmanager
def _wire(wf, ex):
    ex_table = FakeTable({'exec': ex}, 'executionId')
    wf_table = FakeTable({'wf': wf}, 'workflowId')
    sqs, ev, cw = MagicMock(), MagicMock(), MagicMock()
    with patch.object(watchdog, '_executions_table', ex_table), \
         patch.object(watchdog, '_workflows_table', wf_table), \
         patch.object(watchdog, 'events', ev), \
         patch.object(watchdog, '_get_cw_client', return_value=cw), \
         patch.object(executor, '_executions_table', ex_table), \
         patch.object(executor, '_workflows_table', wf_table), \
         patch.object(executor, 'events', ev), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=cw):
        yield ex_table, sqs, ev


def _dispatched(sqs):
    return [json.loads(c.kwargs['MessageBody'])['node_id'] for c in sqs.send_message.call_args_list]


class TestReconcileLostEvent:
    def test_lost_completion_signal_dispatches_successor_within_one_sweep(self, wd_env):
        """n0 completed (worker persisted it) but the signal was lost, so n1
        stayed pending. One sweep re-derives the frontier and dispatches n1."""
        wf = _chain_wf(2)
        ex = _exec({'n0': 'completed', 'n1': 'pending'})
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert _dispatched(sqs) == ['n1']
        assert result['reconciled'] == 1
        assert ex_table.current('exec')['nodeResults']['n1']['status'] == 'running'

    def test_lost_finalize_signal_completes_execution_within_one_sweep(self, wd_env):
        """All nodes completed but the terminal signal was lost, so status is
        still running. One sweep finalizes the execution."""
        wf = _chain_wf(2)
        ex = _exec({'n0': 'completed', 'n1': 'completed'})
        with _wire(wf, ex) as (ex_table, sqs, ev):
            watchdog.handler({}, None)

        assert ex_table.current('exec')['status'] == 'completed'
        ev.publish_workflow_completed.assert_called_once()

    def test_healthy_running_node_is_not_touched(self, wd_env):
        """A genuinely in-progress node (running, within the stall threshold,
        no reconcilable frontier) is neither re-dispatched nor failed."""
        wf = _chain_wf(2)
        # n0 running (recent), n1 pending but NOT ready (pred n0 not terminal).
        ex = _exec({'n0': 'running', 'n1': 'pending'}, node_started_delta=30)
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert _dispatched(sqs) == []
        ev.publish_workflow_failed.assert_not_called()
        ev.publish_workflow_completed.assert_not_called()
        assert result == {'scanned': 1, 'timedOut': 0, 'reconciled': 0,
                          'reDispatched': 0, 'nodeFailed': 0}
        assert ex_table.current('exec')['nodeResults']['n0']['status'] == 'running'
