"""CIT-030: Approve / deny parked nodes + resume_execution routing.

Covers:
  * approve_execution: fenced conditional write, idempotent on second call,
    emits execution.resumed, calls schedule_frontier
  * deny_execution: fenced conditional write, idempotent, calls
    handle_node_failure with 'approval_denied:<reason>', emits
    execution.approval_denied
  * resume_execution routes to approve/deny when approval_decision is present
  * Property tests (Hypothesis): approve idempotent, no double dispatch
    across pause→approve→resume, deny never dispatches

All AWS is mocked; no real network or credentials are touched.
"""
import copy
import json
import os
import re
import sys
from collections import Counter
from contextlib import contextmanager

import pytest
from unittest.mock import patch, MagicMock, call
from hypothesis import given, settings as h_settings
from hypothesis import strategies as st
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from approval_requests import AWAITING_APPROVAL, build_approval_request

# ---------------------------------------------------------------------------
# FakeTable — mirrors test_resume_simulation.py's implementation extended
# with AND-compound ConditionExpression support for the fenced writes.
# ---------------------------------------------------------------------------


def _resolve_path(item, path_segs):
    """Walk nested dicts by resolved segments, return (parent, key, found)."""
    target = item
    for seg in path_segs[:-1]:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            return None, path_segs[-1], False
    return target, path_segs[-1], True


def _apply_set_expression(item, expr, names, values):
    body = expr.strip()
    if body.upper().startswith('SET '):
        body = body[4:]
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


def _eval_single_condition(item, expr, names, values):
    """Evaluate a single comparison (=, <>, attribute_not_exists)."""
    expr = expr.strip()
    # attribute_not_exists(path)
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
                return True  # attribute does not exist
        return False  # attribute exists
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
    """Split a condition expression on top-level AND, respecting parentheses."""
    parts = []
    depth = 0
    current = []
    tokens = expr.split()
    for token in tokens:
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
    """Evaluate a (possibly AND/OR-compound) ConditionExpression."""
    # Split on top-level AND first, then each clause may be an OR group.
    and_parts = _split_top_level_and(expr)
    for and_part in and_parts:
        and_part = and_part.strip()
        # Strip outer parens if it's a grouped OR expression
        inner = and_part
        if inner.startswith('(') and inner.endswith(')'):
            inner = inner[1:-1].strip()
        # Check for OR within this clause
        or_parts = re.split(r'\bOR\b', inner, flags=re.IGNORECASE)
        if len(or_parts) > 1:
            if not any(_eval_single_condition(item, p, names, values) for p in or_parts):
                return False
        else:
            if not _eval_single_condition(item, and_part, names, values):
                return False
    return True


class FakeTable:
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
        _apply_set_expression(item, UpdateExpression, names, values)

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
    """Build an approval-request dict via the real helper, then pin the token."""
    rec = build_approval_request(
        request_type='approval_required',
        reason='test',
        requested_by='system',
        org_id=org_id,
    )
    rec['resumeToken'] = token  # pin for deterministic assertions
    rec['requestedAt'] = '2026-01-01T00:00:00Z'
    return rec


def _exec_with_parked(node_ids_parked, *, other_results=None, token='tok-1', org_id='org-1'):
    """Build an execution row with parked nodes and a top-level orgId."""
    nr = {}
    for nid in node_ids_parked:
        nr[nid] = {'nodeId': nid, 'status': AWAITING_APPROVAL, 'parkedAt': '2026-01-01T00:00:00Z'}
    if other_results:
        nr.update(other_results)
    ar = {nid: _make_approval_record(token=token, org_id=org_id) for nid in node_ids_parked}
    return {
        'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
        'orgId': org_id,
        'status': AWAITING_APPROVAL,
        'nodeResults': nr,
        'approvalRequests': ar,
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


# ---------------------------------------------------------------------------
# 1. approve_execution
# ---------------------------------------------------------------------------

class TestApproveExecution:
    def test_approve_flips_node_to_pending_then_dispatches(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        # After approve + schedule_frontier, node is dispatched (running)
        assert row['nodeResults']['n1']['status'] == 'running'
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert row['approvalRequests']['n1']['decidedBy'] == 'user-A'
        assert row['approvalRequests']['n1']['decidedAt'] is not None

    def test_approve_sets_execution_status_running(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        row = ex_table.current('exec')
        assert row['status'] == 'running'

    def test_approve_emits_execution_resumed_event(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        resumed_events = [
            c for c in ev.publish_event.call_args_list
            if c.args[0] == 'execution.resumed'
        ]
        assert len(resumed_events) == 1
        detail = resumed_events[0].args[1]
        assert detail['executionId'] == 'exec'
        assert detail['nodeId'] == 'n1'
        assert detail['decidedBy'] == 'user-A'

    def test_approve_calls_schedule_frontier(self):
        """After approval, the approved node should be dispatched."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        # schedule_frontier dispatches n1 (now pending, predecessor completed)
        assert 'n1' in _dispatched(sqs)

    def test_approve_idempotent_second_call_noop(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            r1 = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')
            r2 = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert r1 is True
        assert r2 is False  # no-op

    def test_approve_wrong_token_rejected(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'wrong-token', 'user-A', 'org-1')

        assert result is False
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL

    def test_approve_wrong_org_rejected(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'wrong-org')

        assert result is False
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL


# ---------------------------------------------------------------------------
# 2. deny_execution
# ---------------------------------------------------------------------------

class TestDenyExecution:
    def test_deny_stamps_decision(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='bad')

        assert result is True
        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'denied'
        assert row['approvalRequests']['n1']['decidedBy'] == 'user-A'

    def test_deny_calls_handle_node_failure(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='policy')

        # handle_node_failure should mark the node failed
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == 'failed'
        assert 'approval_denied:policy' in row['nodeResults']['n1'].get('error', '')

    def test_deny_emits_approval_denied_event(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='nope')

        denied_events = [
            c for c in ev.publish_event.call_args_list
            if c.args[0] == 'execution.approval_denied'
        ]
        assert len(denied_events) == 1
        detail = denied_events[0].args[1]
        assert detail['executionId'] == 'exec'
        assert detail['nodeId'] == 'n1'
        assert detail['reason'] == 'approval_denied:nope'

    def test_deny_never_dispatches_node(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='nope')

        assert 'n1' not in _dispatched(sqs)

    def test_deny_idempotent_second_call_noop(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            r1 = executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='x')
            r2 = executor.deny_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1', reason='x')

        assert r1 is True
        assert r2 is False

    def test_deny_wrong_token_rejected(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.deny_execution('exec', 'n1', 'bad-tok', 'user-A', 'org-1')

        assert result is False


# ---------------------------------------------------------------------------
# 3. resume_execution routes to approve/deny
# ---------------------------------------------------------------------------

class TestResumeExecutionRouting:
    def test_resume_with_approve_decision(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec', approval_decision={
                'node_id': 'n1',
                'resume_token': 'tok-1',
                'decided_by': 'user-A',
                'org_id': 'org-1',
                'decision': 'approved',
            })

        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] != AWAITING_APPROVAL
        assert row['approvalRequests']['n1']['decision'] == 'approved'

    def test_resume_with_deny_decision(self):
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec', approval_decision={
                'node_id': 'n1',
                'resume_token': 'tok-1',
                'decided_by': 'user-A',
                'org_id': 'org-1',
                'decision': 'denied',
                'reason': 'rejected',
            })

        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'denied'
        assert row['nodeResults']['n1']['status'] == 'failed'

    def test_resume_without_decision_uses_generic_path(self):
        """Without approval_decision, resume_execution behaves normally."""
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending'},
            },
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.resume_execution('exec')

        assert 'n1' in _dispatched(sqs)

    def test_resume_signature_accepts_approval_decision(self):
        """resume_execution accepts an optional approval_decision kwarg."""
        import inspect
        import executor
        sig = inspect.signature(executor.resume_execution)
        assert 'approval_decision' in sig.parameters
        assert 'execution_id' in sig.parameters


# ---------------------------------------------------------------------------
# 4. Property tests (Hypothesis)
# ---------------------------------------------------------------------------

class TestApprovalProperties:
    @given(st.integers(min_value=0, max_value=20))
    @h_settings(max_examples=30, deadline=None)
    def test_approve_is_idempotent(self, repeat_count):
        """Approving N times with the same token: first succeeds, rest no-op."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            results = []
            for _ in range(repeat_count + 1):
                results.append(
                    executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')
                )

        if repeat_count >= 0:
            assert results[0] is True
            assert all(r is False for r in results[1:])

        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert row['nodeResults']['n1']['status'] != AWAITING_APPROVAL

    @given(
        n=st.integers(min_value=2, max_value=6),
        park_idx=st.integers(min_value=1, max_value=5),
    )
    @h_settings(max_examples=30, deadline=None)
    def test_no_double_dispatch_across_pause_approve_resume(self, n, park_idx):
        """Across a full pause→approve→resume cycle, every node is dispatched
        at most once. The parked node is dispatched exactly once after approval."""
        park_idx = park_idx % n
        if park_idx == 0:
            park_idx = 1  # at least n0 completed as predecessor

        wf = _chain_wf(n)
        # Build: nodes 0..park_idx-1 completed, park_idx parked, rest pending
        nr = {}
        for i in range(n):
            if i < park_idx:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': 'completed'}
            elif i == park_idx:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': AWAITING_APPROVAL,
                               'parkedAt': '2026-01-01T00:00:00Z'}
            else:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': 'pending'}

        ar = {f'n{park_idx}': _make_approval_record()}
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': AWAITING_APPROVAL,
            'nodeResults': nr,
            'approvalRequests': ar,
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.approve_execution('exec', f'n{park_idx}', 'tok-1', 'user-A', 'org-1')

            # Drive to completion
            processed = set()
            for _ in range(1000):
                todo = [nid for nid in _dispatched(sqs) if nid not in processed]
                if not todo:
                    break
                for nid in todo:
                    processed.add(nid)
                    executor.handle_node_completion('exec', nid, {'ok': True})

        # No already-completed node re-dispatched
        for i in range(park_idx):
            assert f'n{i}' not in _dispatched(sqs)

        # Every dispatched node dispatched exactly once
        counts = Counter(_dispatched(sqs))
        assert all(v == 1 for v in counts.values()), counts

        row = ex_table.current('exec')
        assert row['status'] == 'completed'
        assert all(
            row['nodeResults'][f'n{i}']['status'] == 'completed'
            for i in range(n)
        )

    @given(
        n=st.integers(min_value=2, max_value=6),
        park_idx=st.integers(min_value=1, max_value=5),
    )
    @h_settings(max_examples=30, deadline=None)
    def test_deny_never_dispatches(self, n, park_idx):
        """After denial, the denied node is never dispatched."""
        park_idx = park_idx % n
        if park_idx == 0:
            park_idx = 1

        wf = _chain_wf(n)
        nr = {}
        for i in range(n):
            if i < park_idx:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': 'completed'}
            elif i == park_idx:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': AWAITING_APPROVAL,
                               'parkedAt': '2026-01-01T00:00:00Z'}
            else:
                nr[f'n{i}'] = {'nodeId': f'n{i}', 'status': 'pending'}

        ar = {f'n{park_idx}': _make_approval_record()}
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': AWAITING_APPROVAL,
            'nodeResults': nr,
            'approvalRequests': ar,
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.deny_execution('exec', f'n{park_idx}', 'tok-1', 'user-A', 'org-1', reason='no')

        # Denied node never dispatched
        assert f'n{park_idx}' not in _dispatched(sqs)
        # No downstream node dispatched (chain is broken by the denial)
        for i in range(park_idx, n):
            assert f'n{i}' not in _dispatched(sqs)


# ---------------------------------------------------------------------------
# 5. Pre-stamped decision handling (single-writer fix)
# ---------------------------------------------------------------------------

class TestPreStampedDecision:
    """When the API stamps approvalRequests.<node>.decision before the engine
    runs approve/deny, the engine must still resume the node (same decision)
    or gracefully no-op (opposite decision)."""

    def test_prestamped_approved_then_approve_resumes(self):
        """Record pre-stamped 'approved' + engine approve -> node resumes once."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})
        # Pre-stamp the decision as the API would
        ex['approvalRequests']['n1']['decision'] = 'approved'

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == 'running'  # dispatched
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert row['approvalRequests']['n1']['decidedBy'] == 'user-A'
        assert row['status'] == 'running'
        # execution.resumed event emitted
        resumed = [c for c in ev.publish_event.call_args_list if c.args[0] == 'execution.resumed']
        assert len(resumed) == 1

    def test_prestamped_denied_then_approve_is_noop(self):
        """Record pre-stamped 'denied' + engine approve -> conflict no-op."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})
        ex['approvalRequests']['n1']['decision'] = 'denied'

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert result is False
        row = ex_table.current('exec')
        # Node stays parked — engine did not override the prior denial
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL
        assert row['approvalRequests']['n1']['decision'] == 'denied'
        # No dispatch, no resumed event
        assert 'n1' not in _dispatched(sqs)
        resumed = [c for c in ev.publish_event.call_args_list if c.args[0] == 'execution.resumed']
        assert len(resumed) == 0

    def test_clean_record_approve_resumes(self):
        """Clean record (decision=None) + approve -> resumes normally."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})
        assert ex['approvalRequests']['n1']['decision'] is None  # clean

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            result = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == 'running'
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert 'n1' in _dispatched(sqs)

    def test_idempotent_second_approve_after_resume_is_noop(self):
        """After a successful approve + resume, a second approve is a no-op
        because the node status is no longer awaiting_approval."""
        wf = _chain_wf(2)
        ex = _exec_with_parked(['n1'], other_results={'n0': {'nodeId': 'n0', 'status': 'completed'}})

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            r1 = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')
            # After r1, node is running (dispatched). Second approve:
            r2 = executor.approve_execution('exec', 'n1', 'tok-1', 'user-A', 'org-1')

        assert r1 is True
        assert r2 is False  # node no longer awaiting_approval


# ---------------------------------------------------------------------------
# 6. Round-trip: build_approval_request → park on FakeTable → approve/deny
#    Records are constructed via the real helpers, never hand-made dicts.
# ---------------------------------------------------------------------------

def _park_on_fake_table(ex_table, execution_id, node_id, *, org_id='org-1'):
    """Simulate _park_node_awaiting_approval on a FakeTable using the real
    build_approval_request helper (the same code the production park calls).

    The caller must ensure ``nodeResults.<node_id>`` exists with status
    ``pending`` and ``approvalRequests`` exists as a map on the item — the
    real park function does this via an ``if_not_exists`` step that the
    FakeTable does not support."""
    record = build_approval_request(
        request_type='approval_required',
        reason='test park',
        requested_by='system',
        org_id=org_id,
    )
    token = record['resumeToken']
    # Conditional park (step 2 of the real _park_node_awaiting_approval)
    ex_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression=(
            'SET nodeResults.#nid.#status = :awaiting, '
            'nodeResults.#nid.#parkedAt = :parkedAt, '
            'approvalRequests.#nid = :record'
        ),
        ConditionExpression='nodeResults.#nid.#status = :pending',
        ExpressionAttributeNames={
            '#nid': node_id,
            '#status': 'status',
            '#parkedAt': 'parkedAt',
        },
        ExpressionAttributeValues={
            ':awaiting': AWAITING_APPROVAL,
            ':parkedAt': '2026-01-01T00:00:00Z',
            ':pending': 'pending',
            ':record': record,
        },
    )
    return token


class TestRoundTripParkApproveDeny:
    """End-to-end: build_approval_request → park → approve/deny.

    Records are built with the real ``build_approval_request`` helper and
    parked on the ``FakeTable`` via the same two-step UpdateItem sequence
    the production ``_park_node_awaiting_approval`` uses — never hand-made
    dicts."""

    def test_park_then_approve_resumes(self):
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            token = _park_on_fake_table(ex_table, 'exec', 'n1')
            # Flip execution status to awaiting_approval (normally done by park)
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET #status = :awaiting',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':awaiting': AWAITING_APPROVAL},
            )

            result = executor.approve_execution('exec', 'n1', token, 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert row['nodeResults']['n1']['status'] != AWAITING_APPROVAL

    def test_park_then_deny_fails_node(self):
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            token = _park_on_fake_table(ex_table, 'exec', 'n1')
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET #status = :awaiting',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':awaiting': AWAITING_APPROVAL},
            )

            result = executor.deny_execution('exec', 'n1', token, 'user-A', 'org-1', reason='nope')

        assert result is True
        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'denied'
        assert row['nodeResults']['n1']['status'] == 'failed'

    def test_park_then_wrong_org_is_noop(self):
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            token = _park_on_fake_table(ex_table, 'exec', 'n1')
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET #status = :awaiting',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':awaiting': AWAITING_APPROVAL},
            )

            result = executor.approve_execution('exec', 'n1', token, 'user-A', 'wrong-org')

        assert result is False
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL

    def test_park_then_wrong_token_is_noop(self):
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            _park_on_fake_table(ex_table, 'exec', 'n1')
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET #status = :awaiting',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':awaiting': AWAITING_APPROVAL},
            )

            result = executor.approve_execution('exec', 'n1', 'wrong-token', 'user-A', 'org-1')

        assert result is False
        row = ex_table.current('exec')
        assert row['nodeResults']['n1']['status'] == AWAITING_APPROVAL

    def test_park_prestamped_same_decision_resumes(self):
        wf = _chain_wf(2)
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'completed'},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            token = _park_on_fake_table(ex_table, 'exec', 'n1')
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET #status = :awaiting',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':awaiting': AWAITING_APPROVAL},
            )
            # Pre-stamp same decision the engine will attempt
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET approvalRequests.#nid.#decision = :d',
                ExpressionAttributeNames={'#nid': 'n1', '#decision': 'decision'},
                ExpressionAttributeValues={':d': 'approved'},
            )

            result = executor.approve_execution('exec', 'n1', token, 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        assert row['approvalRequests']['n1']['decision'] == 'approved'
        assert row['nodeResults']['n1']['status'] != AWAITING_APPROVAL
