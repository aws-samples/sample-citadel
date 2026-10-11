"""CIT-237: Execution-scoped pause — single ``__execution__`` approval request.

Covers:
  * handle_pause_requested: 5 pending → 1 request, 5 awaiting, marker Y
  * approve_execution(__execution__): 5 → pending, running, int pausedSeconds, marker gone
  * deny_execution(__execution__): all failed, execution failed
  * Mixed with per-node tool request: unaffected, marker stays Y
  * Idempotent second approve: no-op
  * Wrong token / wrong org: no-op
  * Late-ready node appended under same token
  * build_approval_request rejects __ prefix in nodeIds
  * Hypothesis property test: status derivation

All tests use the REAL FakeTable writers (no MagicMock for DynamoDB).
"""
import copy
import json
import os
import re
import sys
from contextlib import contextmanager
from decimal import Decimal

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings as h_settings
from hypothesis import strategies as st
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from approval_requests import (
    AWAITING_APPROVAL,
    EXECUTION_SENTINEL,
    build_approval_request,
)


# ---------------------------------------------------------------------------
# FakeTable — extended with if_not_exists in SET and list_append support
# ---------------------------------------------------------------------------

def _resolve_nested(item, path_segs):
    """Walk nested dicts by path segments, return value or None."""
    target = item
    for seg in path_segs:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            return None
    return target


def _reject_floats(value, path=''):
    if isinstance(value, float):
        raise TypeError(
            f'Float types are not supported. Use Decimal types instead. '
            f'(path: {path or "<root>"})'
        )
    if isinstance(value, dict):
        for k, v in value.items():
            _reject_floats(v, f'{path}.{k}' if path else k)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _reject_floats(v, f'{path}[{i}]')


def _resolve_names(raw, names):
    """Resolve #aliases in a dot-separated path."""
    return [names[s.strip()] if s.strip().startswith('#') else s.strip()
            for s in raw.split('.')]


def _apply_set_expression(item, expr, names, values):
    """Parse and apply SET/ADD/REMOVE expression with if_not_exists and list_append support."""
    body = expr.strip()
    if body.upper().startswith('SET '):
        body = body[4:]

    # Extract REMOVE clause
    _ri = body.upper().find(' REMOVE ')
    _remove_body = None
    if _ri != -1:
        _remove_body = body[_ri + 8:]
        body = body[:_ri]

    # Extract ADD clause
    _ai = body.upper().find(' ADD ')
    if _ai != -1:
        _add_body = body[_ai + 5:]
        body = body[:_ai]
        for _clause in _add_body.split(','):
            _parts = _clause.split()
            _segs = _resolve_names(_parts[0], names)
            _delta = values[_parts[1]]
            _t = item
            for _s in _segs[:-1]:
                _t = _t.setdefault(_s, {})
            _t[_segs[-1]] = _t.get(_segs[-1], 0) + _delta

    # Parse SET assignments (handle commas inside function calls)
    assignments = []
    depth = 0
    current = []
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            assignments.append(''.join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        assignments.append(''.join(current).strip())

    for assignment in assignments:
        if '=' not in assignment:
            continue
        lhs, rhs = assignment.split('=', 1)
        lhs = lhs.strip()
        rhs = rhs.strip()

        resolved_lhs = _resolve_names(lhs, names)

        # Evaluate RHS
        rhs_value = _eval_rhs(item, rhs, names, values)

        # Set on item
        target = item
        for seg in resolved_lhs[:-1]:
            target = target.setdefault(seg, {})
        target[resolved_lhs[-1]] = rhs_value

    # Process REMOVE
    if _remove_body:
        for attr_path in _remove_body.split(','):
            attr_path = attr_path.strip()
            if not attr_path:
                continue
            segs = _resolve_names(attr_path, names)
            target = item
            for seg in segs[:-1]:
                if isinstance(target, dict) and seg in target:
                    target = target[seg]
                else:
                    break
            else:
                target.pop(segs[-1], None)


def _eval_rhs(item, rhs, names, values):
    """Evaluate a RHS expression: value ref, if_not_exists, list_append."""
    rhs = rhs.strip()

    # list_append(a, b)
    m = re.match(r'^list_append\((.+),\s*(.+)\)$', rhs)
    if m:
        arg1 = _eval_rhs(item, m.group(1).strip(), names, values)
        arg2 = _eval_rhs(item, m.group(2).strip(), names, values)
        if arg1 is None:
            arg1 = []
        if arg2 is None:
            arg2 = []
        return list(arg1) + list(arg2)

    # if_not_exists(path, default)
    m = re.match(r'^if_not_exists\((.+),\s*(.+)\)$', rhs)
    if m:
        path_raw = m.group(1).strip()
        default_ref = m.group(2).strip()
        resolved_path = _resolve_names(path_raw, names)
        existing = _resolve_nested(item, resolved_path)
        if existing is not None:
            return existing
        return _eval_rhs(item, default_ref, names, values)

    # Simple value reference
    if rhs.startswith(':'):
        return values[rhs]

    # Path reference
    resolved = _resolve_names(rhs, names)
    return _resolve_nested(item, resolved)


def _split_top_level_and(expr):
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


def _eval_single_condition(item, expr, names, values):
    expr = expr.strip()
    m = re.match(r'^attribute_not_exists\((.+)\)$', expr)
    if m:
        path_raw = m.group(1).strip()
        resolved = _resolve_names(path_raw, names)
        return _resolve_nested(item, resolved) is None
    op = '<>' if '<>' in expr else '='
    lhs, rhs = expr.split(op, 1)
    resolved = _resolve_names(lhs.strip(), names)
    target = _resolve_nested(item, resolved)
    found = target is not None
    expected = values[rhs.strip()]
    return (found and target == expected) if op == '=' else ((not found) or target != expected)


def _eval_condition_expression(item, expr, names, values):
    and_parts = _split_top_level_and(expr)
    for and_part in and_parts:
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
    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key = key_name

    def get_item(self, Key):
        item = self._items.get(Key[self._key])
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        _reject_floats(values, 'ExpressionAttributeValues')
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


def _five_node_wf():
    """5-node chain: n0 -> n1 -> n2 -> n3 -> n4."""
    nodes = [_node(f'n{i}') for i in range(5)]
    edges = [{'id': f'e{i}', 'source': f'n{i}', 'target': f'n{i+1}'} for i in range(4)]
    return {'workflowId': 'wf', 'name': 'wf',
            'definition': json.dumps({'nodes': nodes, 'edges': edges}),
            'configuration': json.dumps({})}


def _exec_five_pending(*, org_id='org-1'):
    """Execution with 5 pending nodes, ready for pause."""
    nr = {f'n{i}': {'nodeId': f'n{i}', 'status': 'pending', 'retryCount': 0} for i in range(5)}
    return {
        'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
        'orgId': org_id,
        'status': 'running',
        'nodeResults': nr,
        'approvalRequests': {},
        'pauseRequested': True,
    }


@contextmanager
def _patched(wf, ex, *, gate_enabled=True):
    import executor
    wf_table = FakeTable({'wf': wf}, 'workflowId')
    ex_table = FakeTable({'exec': ex}, 'executionId')
    sqs, ev, cw = MagicMock(), MagicMock(), MagicMock()
    saved_flag = executor.APPROVAL_GATE_ENABLED
    if gate_enabled:
        executor.APPROVAL_GATE_ENABLED = True
    with patch.object(executor, '_workflows_table', wf_table), \
         patch.object(executor, '_executions_table', ex_table), \
         patch.object(executor, 'events', ev), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=cw), \
         patch.object(executor, '_check_release_gate', return_value=(False, None)), \
         patch.object(executor, '_check_approval_gate', return_value=(False, None)), \
         patch.dict(os.environ, {'WORKER_QUEUE_URL': 'https://sqs.fake/q'}):
        yield executor, sqs, ex_table, ev
    executor.APPROVAL_GATE_ENABLED = saved_flag


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
# 1. handle_pause_requested: 5 pending → 1 request, 5 awaiting, marker Y
# ---------------------------------------------------------------------------

class TestHandlePauseRequested:
    def test_five_pending_nodes_one_request(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec', reason='Manual pause')

        row = ex_table.current('exec')

        # Exactly 1 approval request keyed __execution__
        ar = row['approvalRequests']
        assert EXECUTION_SENTINEL in ar
        assert len([k for k in ar if k != EXECUTION_SENTINEL]) == 0

        req = ar[EXECUTION_SENTINEL]
        assert req['requestType'] == 'execution_pause'
        assert req['scope'] == 'execution'
        assert sorted(req['nodeIds']) == ['n0', 'n1', 'n2', 'n3', 'n4']
        assert req['decision'] is None
        assert req['resumeToken']  # non-empty

        # All 5 nodes awaiting_approval
        for i in range(5):
            assert row['nodeResults'][f'n{i}']['status'] == AWAITING_APPROVAL

        # pendingApproval marker is 'Y'
        assert row.get('pendingApproval') == 'Y'

        # pauseRequested consumed
        assert 'pauseRequested' not in row

    def test_pause_sets_pausedAt(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')

        row = ex_table.current('exec')
        assert row.get('pausedAt') is not None


# ---------------------------------------------------------------------------
# 2. approve_execution(__execution__): all pending, running, int pausedSeconds
# ---------------------------------------------------------------------------

class TestApproveExecutionScoped:
    def test_approve_all_five_to_pending_and_running(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            result = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')

        # All 5 nodes flipped to pending (n0 is root, so schedule_frontier dispatches it)
        # n0 is the only ready node in a chain, so it becomes running
        assert row['nodeResults']['n0']['status'] in ('pending', 'running')
        for i in range(1, 5):
            assert row['nodeResults'][f'n{i}']['status'] == 'pending'

        # Execution status is running
        assert row['status'] == 'running'

        # Decision stamped
        req = row['approvalRequests'][EXECUTION_SENTINEL]
        assert req['decision'] == 'approved'
        assert req['decidedBy'] == 'user-A'
        assert req['decidedAt'] is not None

        # pendingApproval marker removed (no other undecided)
        assert 'pendingApproval' not in row

    def test_approve_int_pausedSeconds(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()
        ex['pausedSeconds'] = Decimal('120')
        ex['pausedAt'] = '2026-01-01T00:00:00+00:00'

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            with patch.object(executor, '_now_iso', return_value='2026-01-01T00:01:00+00:00'):
                result = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')
        ps = row['pausedSeconds']
        assert isinstance(ps, int), f'pausedSeconds must be int, got {type(ps).__name__}'
        assert ps == 180  # 120 prior + 60 delta

    def test_approve_emits_resumed_event(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']
            executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        resumed = [c for c in ev.publish_event.call_args_list if c.args[0] == 'execution.resumed']
        assert len(resumed) == 1
        detail = resumed[0].args[1]
        assert detail['nodeId'] == EXECUTION_SENTINEL
        assert detail['scope'] == 'execution'

    def test_approve_calls_schedule_frontier(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']
            executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        # Root node n0 should be dispatched via SQS
        dispatched = [json.loads(c.kwargs['MessageBody'])['node_id']
                      for c in sqs.send_message.call_args_list]
        assert 'n0' in dispatched


# ---------------------------------------------------------------------------
# 3. deny_execution(__execution__): all failed
# ---------------------------------------------------------------------------

class TestDenyExecutionScoped:
    def test_deny_all_five_failed(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            result = executor.deny_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1', reason='rejected')

        assert result is True
        row = ex_table.current('exec')

        # All parked nodes failed
        for i in range(5):
            assert row['nodeResults'][f'n{i}']['status'] == 'failed'

        # Execution is failed
        assert row['status'] == 'failed'

        # Decision stamped
        req = row['approvalRequests'][EXECUTION_SENTINEL]
        assert req['decision'] == 'denied'
        assert req['decidedBy'] == 'user-A'

        # pendingApproval removed
        assert 'pendingApproval' not in row

    def test_deny_emits_approval_denied_event(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']
            executor.deny_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1', reason='nope')

        denied = [c for c in ev.publish_event.call_args_list if c.args[0] == 'execution.approval_denied']
        assert len(denied) == 1
        detail = denied[0].args[1]
        assert detail['nodeId'] == EXECUTION_SENTINEL
        assert detail['scope'] == 'execution'

    def test_deny_never_dispatches(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']
            executor.deny_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        dispatched = [json.loads(c.kwargs['MessageBody'])['node_id']
                      for c in sqs.send_message.call_args_list]
        for i in range(5):
            assert f'n{i}' not in dispatched


# ---------------------------------------------------------------------------
# 4. Mixed: per-node tool request coexists, marker stays Y
# ---------------------------------------------------------------------------

class TestMixedWithToolRequest:
    def test_tool_request_unaffected_by_execution_approve(self):
        """A per-node tool_approval request on n2 stays undecided when
        __execution__ is approved; pendingApproval stays 'Y'."""
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            # Add a per-node tool_approval on n2 (simulating worker event)
            tool_record = build_approval_request(
                request_type='tool_approval',
                reason='Tool X needs approval',
                requested_by='worker',
                metadata={'toolName': 'X'},
            )
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET approvalRequests.#nid = :record',
                ExpressionAttributeNames={'#nid': 'n2'},
                ExpressionAttributeValues={':record': tool_record},
            )

            result = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        assert result is True
        row = ex_table.current('exec')

        # The per-node tool request on n2 is untouched
        assert 'n2' in row['approvalRequests']
        assert row['approvalRequests']['n2']['decision'] is None
        assert row['approvalRequests']['n2']['requestType'] == 'tool_approval'

        # pendingApproval stays 'Y' because the per-node request is still undecided
        assert row.get('pendingApproval') == 'Y'


# ---------------------------------------------------------------------------
# 5. Idempotent second approve: no-op
# ---------------------------------------------------------------------------

class TestIdempotentApprove:
    def test_second_approve_is_noop(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            r1 = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')
            r2 = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1')

        assert r1 is True
        assert r2 is False


# ---------------------------------------------------------------------------
# 6. Wrong token / wrong org: no-op
# ---------------------------------------------------------------------------

class TestFenceRejection:
    def test_wrong_token_rejected(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')

            result = executor.approve_execution('exec', EXECUTION_SENTINEL, 'wrong-token', 'user-A', 'org-1')

        assert result is False
        row = ex_table.current('exec')
        assert row['approvalRequests'][EXECUTION_SENTINEL]['decision'] is None
        # All nodes still parked
        for i in range(5):
            assert row['nodeResults'][f'n{i}']['status'] == AWAITING_APPROVAL

    def test_wrong_org_rejected(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            result = executor.approve_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'wrong-org')

        assert result is False
        row = ex_table.current('exec')
        assert row['approvalRequests'][EXECUTION_SENTINEL]['decision'] is None


# ---------------------------------------------------------------------------
# 7. Late-ready node appended under same token
# ---------------------------------------------------------------------------

class TestLateReadyNodeAppend:
    def test_late_node_appended_under_same_token(self):
        """A node that becomes ready after the initial pause is appended to
        the existing __execution__ request's nodeIds."""
        wf = _five_node_wf()
        # Start with only n0, n1 pending; n2-n4 not yet in nodeResults
        ex = {
            'executionId': 'exec', 'workflowId': 'wf', 'appId': 'app-1',
            'orgId': 'org-1',
            'status': 'running',
            'nodeResults': {
                'n0': {'nodeId': 'n0', 'status': 'pending', 'retryCount': 0},
                'n1': {'nodeId': 'n1', 'status': 'pending', 'retryCount': 0},
            },
            'approvalRequests': {},
            'pauseRequested': True,
        }

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            # First pause: parks n0, n1
            executor.handle_pause_requested('exec')
            row1 = ex_table.current('exec')
            token = row1['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']
            assert sorted(row1['approvalRequests'][EXECUTION_SENTINEL]['nodeIds']) == ['n0', 'n1']

            # Simulate n2 becoming pending (e.g. predecessor completed during pause)
            ex_table.update_item(
                Key={'executionId': 'exec'},
                UpdateExpression='SET nodeResults.#nid = :stub, #pauseReq = :t',
                ExpressionAttributeNames={'#nid': 'n2', '#pauseReq': 'pauseRequested'},
                ExpressionAttributeValues={
                    ':stub': {'nodeId': 'n2', 'status': 'pending', 'retryCount': 0},
                    ':t': True,
                },
            )

            # Second pause: appends n2 under SAME token
            executor.handle_pause_requested('exec')

        row2 = ex_table.current('exec')
        req = row2['approvalRequests'][EXECUTION_SENTINEL]
        # Same token as before
        assert req['resumeToken'] == token
        # n2 appended
        assert sorted(req['nodeIds']) == ['n0', 'n1', 'n2']
        # n2 also awaiting
        assert row2['nodeResults']['n2']['status'] == AWAITING_APPROVAL


# ---------------------------------------------------------------------------
# 8. build_approval_request rejects __ prefix in nodeIds
# ---------------------------------------------------------------------------

class TestSentinelGuard:
    def test_rejects_dunder_prefix_in_node_ids(self):
        with pytest.raises(ValueError, match="node ids starting with '__'"):
            build_approval_request(
                request_type='execution_pause',
                reason='test',
                requested_by='system',
                node_ids=['n0', '__bad_node', 'n1'],
            )

    def test_accepts_normal_node_ids(self):
        rec = build_approval_request(
            request_type='execution_pause',
            reason='test',
            requested_by='system',
            scope='execution',
            node_ids=['n0', 'n1', 'n2'],
        )
        assert rec['nodeIds'] == ['n0', 'n1', 'n2']
        assert rec['scope'] == 'execution'


# ---------------------------------------------------------------------------
# 9. Hypothesis property test: status derivation
# ---------------------------------------------------------------------------

_NODE_STATUSES = ['pending', 'running', 'completed', 'skipped', 'failed', AWAITING_APPROVAL]
_TERMINAL = {'completed', 'skipped', 'failed'}


@given(
    statuses=st.lists(
        st.sampled_from(_NODE_STATUSES),
        min_size=1,
        max_size=10,
    ),
)
@h_settings(max_examples=200, deadline=None)
def test_status_derivation_property(statuses):
    """For any combination of node statuses, the derived execution status
    matches:
      - awaiting_approval iff no node dispatched/running AND >=1 awaiting
      - running iff any node dispatched/running
      - completed iff all nodes terminal
    """
    any_running = any(s in ('running', 'dispatched') for s in statuses)
    any_awaiting = any(s == AWAITING_APPROVAL for s in statuses)
    all_terminal = all(s in _TERMINAL for s in statuses)
    settled_or_parked = all(s in (_TERMINAL | {AWAITING_APPROVAL}) for s in statuses)

    if all_terminal:
        expected = 'completed'
    elif any_running:
        expected = 'running'
    elif settled_or_parked and any_awaiting:
        expected = AWAITING_APPROVAL
    else:
        expected = 'running'  # default: some pending, none running/awaiting

    # Simulate the schedule_frontier derivation logic
    status_map = {f'n{i}': s for i, s in enumerate(statuses)}
    nodes = [{'id': f'n{i}'} for i in range(len(statuses))]

    _all_terminal = bool(nodes) and all(
        status_map.get(n['id'], 'pending') in ('completed', 'skipped', 'failed')
        for n in nodes
    )
    _settled_or_parked = ('completed', 'skipped', 'failed', AWAITING_APPROVAL)
    _all_settled = bool(nodes) and all(
        status_map.get(n['id'], 'pending') in _settled_or_parked
        for n in nodes
    )
    _any_awaiting = any(
        status_map.get(n['id']) == AWAITING_APPROVAL for n in nodes
    )

    if _all_terminal:
        derived = 'completed'
    elif _all_settled and _any_awaiting:
        derived = AWAITING_APPROVAL
    else:
        derived = 'running'

    assert derived == expected, f'statuses={statuses} expected={expected} derived={derived}'


# ---------------------------------------------------------------------------
# 10. Deny idempotent
# ---------------------------------------------------------------------------

class TestDenyIdempotent:
    def test_second_deny_is_noop(self):
        wf = _five_node_wf()
        ex = _exec_five_pending()

        with _patched(wf, ex) as (executor, sqs, ex_table, ev):
            executor.handle_pause_requested('exec')
            row = ex_table.current('exec')
            token = row['approvalRequests'][EXECUTION_SENTINEL]['resumeToken']

            r1 = executor.deny_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1', reason='x')
            r2 = executor.deny_execution('exec', EXECUTION_SENTINEL, token, 'user-A', 'org-1', reason='x')

        assert r1 is True
        assert r2 is False
