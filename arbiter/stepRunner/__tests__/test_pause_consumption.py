"""Tests for pause-consumption and paused-time accounting.

Bug 1: pauseRequested must be consumed (REMOVEd) when the park honours it
        and defensively on approve/deny, preventing the approve → re-park loop.
Bug 2: pausedAt / pausedSeconds track execution-level paused time for the
        watchdog.
"""
import copy
import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from approval_requests import AWAITING_APPROVAL, build_approval_request


# ---------------------------------------------------------------------------
# FakeTable — extended with REMOVE and if_not_exists support
# ---------------------------------------------------------------------------

def _resolve_if_not_exists(rhs, names, values, item):
    """Handle ``if_not_exists(path, fallback)`` in a SET assignment RHS."""
    m = re.match(r'^\s*if_not_exists\((.+?),\s*(.+?)\)\s*$', rhs)
    if not m:
        return values[rhs.strip()]
    path_raw, fallback_ref = m.group(1).strip(), m.group(2).strip()
    segs = [names[s.strip()] if s.strip().startswith('#') else s.strip()
            for s in path_raw.split('.')]
    target = item
    for seg in segs:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            return values[fallback_ref]
    return target


def _apply_update_expression(item, expr, names, values):
    """Parse a combined SET … ADD … REMOVE … expression."""
    # Split into clauses (SET, ADD, REMOVE)
    upper = expr.upper()
    clause_starts = []
    for keyword in ('SET ', 'ADD ', 'REMOVE '):
        idx = 0
        while True:
            pos = upper.find(keyword, idx)
            if pos == -1:
                break
            clause_starts.append((pos, keyword.strip()))
            idx = pos + len(keyword)
    clause_starts.sort()

    clauses = {}
    for i, (pos, kw) in enumerate(clause_starts):
        start = pos + len(kw) + 1
        end = clause_starts[i + 1][0] if i + 1 < len(clause_starts) else len(expr)
        clauses.setdefault(kw, []).append(expr[start:end].strip())

    # Process SET
    for body in clauses.get('SET', []):
        # Split on commas at depth 0 (not inside parentheses)
        assignments = []
        depth = 0
        current = []
        for ch in body:
            if ch == '(':
                depth += 1
                current.append(ch)
            elif ch == ')':
                depth -= 1
                current.append(ch)
            elif ch == ',' and depth == 0:
                assignments.append(''.join(current))
                current = []
            else:
                current.append(ch)
        if current:
            assignments.append(''.join(current))

        for assignment in assignments:
            assignment = assignment.strip()
            if not assignment:
                continue
            lhs, rhs = assignment.split('=', 1)
            resolved = [names[s.strip()] if s.strip().startswith('#') else s.strip()
                        for s in lhs.strip().split('.')]
            val = _resolve_if_not_exists(rhs, names, values, item)
            target = item
            for seg in resolved[:-1]:
                target = target.setdefault(seg, {})
            target[resolved[-1]] = val

    # Process ADD
    for body in clauses.get('ADD', []):
        for clause in body.split(','):
            parts = clause.split()
            segs = [s.strip() for s in parts[0].split('.')]
            res = [names[s] if s.startswith('#') else s for s in segs]
            delta = values[parts[1]]
            t = item
            for s in res[:-1]:
                t = t.setdefault(s, {})
            t[res[-1]] = t.get(res[-1], 0) + delta

    # Process REMOVE
    for body in clauses.get('REMOVE', []):
        for attr_path in body.split(','):
            attr_path = attr_path.strip()
            if not attr_path:
                continue
            segs = [names[s.strip()] if s.strip().startswith('#') else s.strip()
                    for s in attr_path.split('.')]
            target = item
            for seg in segs[:-1]:
                if isinstance(target, dict) and seg in target:
                    target = target[seg]
                else:
                    break
            else:
                target.pop(segs[-1], None)


def _eval_single_condition(item, expr, names, values):
    expr = expr.strip()
    m = re.match(r'^attribute_not_exists\((.+)\)$', expr)
    if m:
        path_raw = m.group(1).strip()
        resolved = [names[s.strip()] if s.strip().startswith('#') else s.strip()
                    for s in path_raw.split('.')]
        target = item
        for seg in resolved:
            if isinstance(target, dict) and seg in target:
                target = target[seg]
            else:
                return True
        return False
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


def _split_top_level_and(expr):
    parts, depth, current = [], 0, []
    for token in expr.split():
        depth += token.count('(') - token.count(')')
        if token.upper() == 'AND' and depth == 0:
            parts.append(' '.join(current))
            current = []
        else:
            current.append(token)
    if current:
        parts.append(' '.join(current))
    return parts


def _eval_condition_expression(item, expr, names, values):
    for and_part in _split_top_level_and(expr):
        and_part = and_part.strip()
        inner = and_part
        if inner.startswith('(') and inner.endswith(')'):
            inner = inner[1:-1].strip()
        or_parts = re.split(r'\bOR\b', inner, flags=re.IGNORECASE)
        if len(or_parts) > 1:
            if not any(_eval_single_condition(item, p, names, values) for p in or_parts):
                return False
        else:
            if not _eval_single_condition(item, and_part, names, values):
                return False
    return True


class FakeTable:
    """In-memory DynamoDB table double supporting SET/ADD/REMOVE +
    if_not_exists + compound ConditionExpressions."""

    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key = key_name

    def get_item(self, Key):  # noqa: N803
        item = self._items.get(Key[self._key])
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        item = self._items.setdefault(Key[self._key], {self._key: Key[self._key]})
        if ConditionExpression is not None and not _eval_condition_expression(
                item, ConditionExpression, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'failed'}},
                'UpdateItem',
            )
        _apply_update_expression(item, UpdateExpression, names, values)

    def current(self, val):
        return copy.deepcopy(self._items[val])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _node(nid, requires_approval=False):
    return {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}',
            'data': {'requiresApproval': requires_approval}}


def _chain_wf(n):
    nodes = [_node(f'n{i}') for i in range(n)]
    edges = [{'id': f'e{i}', 'source': f'n{i}', 'target': f'n{i+1}'} for i in range(n - 1)]
    return {'workflowId': 'wf', 'name': 'wf',
            'definition': json.dumps({'nodes': nodes, 'edges': edges}),
            'configuration': json.dumps({})}


def _make_approval_record(*, token='tok-1', org_id='org-1'):
    rec = build_approval_request(
        request_type='manual_pause',
        reason='test',
        requested_by='system',
        org_id=org_id,
    )
    rec['resumeToken'] = token
    rec['requestedAt'] = '2026-01-01T00:00:00Z'
    return rec


def _exec_with_parked(node_ids_parked, *, other_results=None, token='tok-1',
                      org_id='org-1', pause_requested=True, paused_at=None):
    nr = {}
    for nid in node_ids_parked:
        nr[nid] = {'nodeId': nid, 'status': AWAITING_APPROVAL, 'parkedAt': '2026-01-01T00:00:00Z'}
    if other_results:
        nr.update(other_results)
    ar = {nid: _make_approval_record(token=token, org_id=org_id) for nid in node_ids_parked}
    ex = {
        'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
        'orgId': org_id,
        'status': AWAITING_APPROVAL,
        'nodeResults': nr,
        'approvalRequests': ar,
    }
    if pause_requested:
        ex['pauseRequested'] = True
    if paused_at is not None:
        ex['pausedAt'] = paused_at
    return ex


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
         patch.object(executor, '_check_release_gate', return_value=(False, None)), \
         patch.object(executor, '_check_approval_gate', return_value=(False, None)), \
         patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
        yield executor, sqs, ex_table, ev


def _dispatched(sqs):
    return [json.loads(c.kwargs['MessageBody'])['node_id']
            for c in sqs.send_message.call_args_list]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {}
    for key in (
        'APPROVAL_GATE_ENABLED',
        'WORKER_QUEUE_URL',
        'AGENT_CONFIG_TABLE',
        'RELEASE_DISPATCH_ENVIRONMENT',
    ):
        saved[key] = os.environ.pop(key, None)
    os.environ['WORKER_QUEUE_URL'] = 'https://sqs.fake/worker-queue'
    os.environ['AGENT_CONFIG_TABLE'] = 'fake-agent-table'
    yield
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def _enable_gate():
    os.environ['APPROVAL_GATE_ENABLED'] = 'true'
    import executor
    executor.APPROVAL_GATE_ENABLED = True


# ---------------------------------------------------------------------------
# Bug 1: pauseRequested consumed on park, approve, deny
# ---------------------------------------------------------------------------

class TestPauseRequestedConsumedOnPark:
    """_park_node_awaiting_approval REMOVEs pauseRequested so
    schedule_frontier won't re-park the node after approve."""

    def test_park_removes_pause_requested(self):
        _enable_gate()
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'pauseRequested': True,
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.schedule_frontier(
                ex_table.current('exec'),
                wf,
            )

        row = ex_table.current('exec')
        assert 'pauseRequested' not in row, \
            'pauseRequested must be consumed when the park honours it'
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL

    def test_park_approve_schedule_does_not_repark(self):
        """Full cycle: park → approve → schedule_frontier dispatches the
        node without re-parking."""
        _enable_gate()
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'pauseRequested': True,
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            # Step 1: park via schedule_frontier
            executor.schedule_frontier(ex_table.current('exec'), wf)
            parked_row = ex_table.current('exec')
            assert parked_row['nodeResults']['n1']['status'] == AWAITING_APPROVAL
            token = parked_row['approvalRequests']['n1']['resumeToken']

            # Step 2: approve
            result = executor.approve_execution('exec', 'n1', token, 'user-A', 'org-1')
            assert result is True

        final = ex_table.current('exec')
        # Node should be dispatched (running), NOT re-parked
        assert final['nodeResults']['n1']['status'] == 'running'
        assert 'pauseRequested' not in final
        assert 'n1' in _dispatched(sqs)


class TestPauseRequestedConsumedOnApprove:
    """approve_execution defensively REMOVEs pauseRequested for records
    parked before this fix (where pauseRequested was left set)."""

    def test_approve_removes_pause_requested(self):
        _enable_gate()
        wf = _chain_wf(2)
        # Pre-fix record: pauseRequested still set, no pausedAt
        ex = _exec_with_parked(
            ['n1'],
            other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}},
            pause_requested=True,
            paused_at=None,
        )

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        row = ex_table.current('exec')
        assert 'pauseRequested' not in row
        assert row['nodeResults']['n1']['status'] != AWAITING_APPROVAL


class TestPauseRequestedConsumedOnDeny:
    """deny_execution defensively REMOVEs pauseRequested."""

    def test_deny_removes_pause_requested(self):
        _enable_gate()
        wf = _chain_wf(2)
        ex = _exec_with_parked(
            ['n1'],
            other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}},
            pause_requested=True,
            paused_at=None,
        )

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='no')

        row = ex_table.current('exec')
        assert 'pauseRequested' not in row


# ---------------------------------------------------------------------------
# Bug 2: pausedAt / pausedSeconds tracking
# ---------------------------------------------------------------------------

class TestPausedTimeTracking:
    """Execution-level paused-time accounting for the watchdog."""

    def test_park_sets_paused_at(self):
        _enable_gate()
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'pauseRequested': True,
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.schedule_frontier(ex_table.current('exec'), wf)

        row = ex_table.current('exec')
        assert 'pausedAt' in row, 'pausedAt must be set when parking'
        # Should be a valid ISO timestamp
        datetime.fromisoformat(row['pausedAt'])

    def test_approve_accumulates_paused_seconds_and_removes_paused_at(self):
        _enable_gate()
        wf = _chain_wf(2)
        paused_at = '2026-01-01T00:00:00+00:00'
        ex = _exec_with_parked(
            ['n1'],
            other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}},
            pause_requested=True,
            paused_at=paused_at,
        )

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        row = ex_table.current('exec')
        assert 'pausedAt' not in row, 'pausedAt must be REMOVEd on approve'
        assert 'pausedSeconds' in row, 'pausedSeconds must be set on approve'
        assert isinstance(row['pausedSeconds'], (int, float))
        # pausedAt was 2026-01-01, now is later, so delta > 0
        assert row['pausedSeconds'] > 0

    def test_deny_accumulates_paused_seconds_and_removes_paused_at(self):
        _enable_gate()
        wf = _chain_wf(2)
        paused_at = '2026-01-01T00:00:00+00:00'
        ex = _exec_with_parked(
            ['n1'],
            other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}},
            pause_requested=True,
            paused_at=paused_at,
        )

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='bad')

        row = ex_table.current('exec')
        assert 'pausedAt' not in row, 'pausedAt must be REMOVEd on deny'
        assert 'pausedSeconds' in row
        assert row['pausedSeconds'] >= 0

    def test_approve_without_paused_at_sets_paused_seconds_zero(self):
        """Pre-fix record without pausedAt: approve still writes
        pausedSeconds (defaults to 0 via if_not_exists)."""
        _enable_gate()
        wf = _chain_wf(2)
        ex = _exec_with_parked(
            ['n1'],
            other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}},
            pause_requested=True,
            paused_at=None,  # pre-fix: no pausedAt
        )

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        row = ex_table.current('exec')
        assert row.get('pausedSeconds', 0) == 0
        assert 'pauseRequested' not in row

    def test_park_preserves_existing_paused_at(self):
        """if_not_exists semantics: a second park does not overwrite
        an existing pausedAt timestamp."""
        _enable_gate()
        original_paused_at = '2025-06-01T00:00:00+00:00'
        wf = _chain_wf(3)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'pauseRequested': True,
            'pausedAt': original_paused_at,
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
                'n2': {'nodeId': 'n2', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            # n1 is ready (n0 completed), n2 is not (n1 not completed)
            executor.schedule_frontier(ex_table.current('exec'), wf)

        row = ex_table.current('exec')
        assert row['pausedAt'] == original_paused_at, \
            'if_not_exists must preserve existing pausedAt'
