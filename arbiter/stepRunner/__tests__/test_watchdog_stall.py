"""
Watchdog stalled-node detection + reconcile-or-fail tests (decisions O4/O6).

A node stuck 'running' past NODE_STALL_TIMEOUT_SECONDS * NODE_STALL_FACTOR with
no persisted completion is a stalled node (crashed worker / lost dispatch). The
watchdog reconciles-or-fails it: re-dispatch if retries remain, else drive it
(and the execution) to terminal failure via the executor's failure path. The
execution-level timeout remains the backstop for a run with no reconcilable or
stalled per-node state.

All AWS is mocked; deterministic, no threads.
"""

import copy
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import timeout_watchdog as watchdog
import executor


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

    def scan(self, **kwargs):  # noqa: N803
        return {'Items': [copy.deepcopy(v) for v in self._items.values()
                          if v.get('status') == 'running']}

    def current(self, val):
        return copy.deepcopy(self._items[val])


def _iso(delta_seconds):
    return (datetime.now(timezone.utc) - timedelta(seconds=delta_seconds)).isoformat()


def _node(nid):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}


def _chain_wf(n, retry_policy=None):
    nodes = [_node(f'n{i}') for i in range(n)]
    if retry_policy is not None:
        for node in nodes:
            node['data']['retryPolicy'] = retry_policy
    edges = [{'id': f'e{i}', 'source': f'n{i}', 'target': f'n{i+1}'} for i in range(n - 1)]
    return {'workflowId': 'wf', 'definition': json.dumps({'nodes': nodes, 'edges': edges}),
            'configuration': json.dumps({})}


def _exec(node_statuses, *, started_delta=30, node_started_delta=30,
          status='running', retry_counts=None):
    retry_counts = retry_counts or {}
    nr = {}
    for nid, s in node_statuses.items():
        entry = {'nodeId': nid, 'agentId': f'a-{nid}', 'status': s,
                 'retryCount': retry_counts.get(nid, 0)}
        if s == 'running':
            entry['startedAt'] = _iso(node_started_delta)
        nr[nid] = entry
    return {'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'status': status, 'startedAt': _iso(started_delta), 'nodeResults': nr}


@pytest.fixture(autouse=True)
def wd_env(monkeypatch):
    monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
    monkeypatch.setenv('NODE_STALL_TIMEOUT_SECONDS', '10')
    monkeypatch.setenv('NODE_STALL_FACTOR', '1')  # 10s stall threshold
    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/q')


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


class TestStalledNodeReconcileOrFail:
    def test_stalled_node_with_retries_is_redispatched(self):
        """n1 running past the stall threshold with retries remaining is
        re-dispatched (retryCount incremented), not failed."""
        wf = _chain_wf(2, retry_policy={'maxRetries': 2})
        ex = _exec({'n0': 'completed', 'n1': 'running'}, node_started_delta=60)
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert result['reDispatched'] == 1
        assert _dispatched(sqs) == ['n1']
        n1 = ex_table.current('exec')['nodeResults']['n1']
        assert n1['status'] == 'running'
        assert n1['retryCount'] == 1
        ev.publish_workflow_failed.assert_not_called()

    def test_stalled_node_without_retries_fails_node_and_execution(self):
        """n1 stalled with no retries left is driven to terminal failure and the
        execution fails."""
        wf = _chain_wf(2, retry_policy={'maxRetries': 0})
        ex = _exec({'n0': 'completed', 'n1': 'running'}, node_started_delta=60)
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert result['nodeFailed'] == 1
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == 'failed'
        assert row['status'] == 'failed'
        ev.publish_workflow_failed.assert_called_once()
        assert _dispatched(sqs) == []

    def test_recent_running_node_is_not_stalled(self):
        """A node running WITHIN the stall threshold is left untouched."""
        wf = _chain_wf(2, retry_policy={'maxRetries': 2})
        ex = _exec({'n0': 'completed', 'n1': 'running'}, node_started_delta=2)
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert result == {'scanned': 1, 'timedOut': 0, 'reconciled': 0,
                          'reDispatched': 0, 'nodeFailed': 0}
        assert _dispatched(sqs) == []

    def test_execution_backstop_fails_old_run_with_no_stalled_node(self, monkeypatch):
        """A run whose node is running-but-recent (not stalled) and has no
        reconcilable frontier, but whose EXECUTION is older than the exec
        timeout, is failed by the execution-level backstop."""
        monkeypatch.setenv('WORKFLOW_TIMEOUT_SECONDS', '3600')
        wf = _chain_wf(2, retry_policy={'maxRetries': 2})
        ex = _exec({'n0': 'completed', 'n1': 'running'},
                   started_delta=7200, node_started_delta=2)
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        assert result['timedOut'] == 1
        assert ex_table.current('exec')['status'] == 'failed'
        ev.publish_workflow_failed.assert_called_once()

    @given(
        retry_count=st.integers(min_value=0, max_value=5),
        max_retries=st.integers(min_value=0, max_value=5),
    )
    @settings(max_examples=40, deadline=None)
    def test_stall_disposition_is_redispatch_iff_retries_remain(self, retry_count, max_retries):
        """Property: a stalled node is re-dispatched exactly when retries remain
        (retryCount < maxRetries), otherwise it is failed — a definite
        disposition either way (never silenced)."""
        wf = _chain_wf(2, retry_policy={'maxRetries': max_retries})
        ex = _exec({'n0': 'completed', 'n1': 'running'},
                   node_started_delta=60, retry_counts={'n1': retry_count})
        with _wire(wf, ex) as (ex_table, sqs, ev):
            result = watchdog.handler({}, None)

        if retry_count < max_retries:
            assert result['reDispatched'] == 1
            assert result['nodeFailed'] == 0
        else:
            assert result['nodeFailed'] == 1
            assert result['reDispatched'] == 0
