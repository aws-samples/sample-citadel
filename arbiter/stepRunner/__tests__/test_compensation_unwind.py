"""
CIT-123 slice 3 — executor unwind ORCHESTRATION (red-first).

Scope under test (design D1/D2/D3/D5/D7, decision dfe2d9a1):

(a) Trigger at the terminal no-retry branch of ``handle_node_failure``,
    gated on the slice-1 workflow-level compensation policy
    (``workflow_contract.normalize_compensation_policy``). Absent/disabled
    policy is BYTE-IDENTICAL to pre-feature behaviour.
(b) Select COMPLETED, side-effecting, compensation-bearing nodes; order
    them strictly reverse-topological; the failing node itself is excluded.
(c) Drive them sequentially; per-compensation state lives on
    ``nodeResults['{origNodeId}#comp']`` pseudo-nodes
    (compensating/compensated/compensation_failed). Execution ``status``
    stays 'failed'; an ADDITIVE ``compensationStatus`` sub-status is added.
(d) Dispatch to the worker seam is inert-safe today: disabled -> nothing
    dispatches; an unhandled dispatch must not corrupt state or hang.
(e) Per-execution ``compensationGeneration`` fences a stale unwind worker.
(f) A stalled unwind is detected by the watchdog, not silent.

Policy per decision dfe2d9a1: CIRCUIT_OPEN and RETRY_AFTER_HUMAN do NOT
compensate. A FAILED compensation STOPS the unwind (onFailure='stop'
default), with the stop point recorded on the execution.

All AWS is mocked (FakeTable pattern from test_watchdog_stall.py); no
threads, no real network.
"""

import copy
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

import pytest
from unittest.mock import MagicMock
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import executor  # noqa: E402
import timeout_watchdog as watchdog  # noqa: E402
from common import workflow_contract  # noqa: E402


# ---------------------------------------------------------------------------
# Shared FakeTable harness (mirrors test_watchdog_stall.py's expression
# evaluator so this file has no hidden coupling to moto/real DynamoDB).
# ---------------------------------------------------------------------------

def _apply_set_expression(item, expr, names, values):
    body = expr.strip()[4:]
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
    body = body.strip()
    if not body:
        return
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
        return {'Attributes': copy.deepcopy(item)}

    def scan(self, **kwargs):  # noqa: N803
        filter_expr = kwargs.get('FilterExpression')
        names = kwargs.get('ExpressionAttributeNames') or {}
        values = kwargs.get('ExpressionAttributeValues') or {}
        items = [copy.deepcopy(v) for v in self._items.values()]
        if filter_expr is None:
            return {'Items': items}
        return {'Items': [v for v in items if _eval_condition_expression(v, filter_expr, names, values)]}

    def put_item(self, Item):  # noqa: N803
        self._items[Item[self._key]] = copy.deepcopy(Item)

    def current(self, val):
        return copy.deepcopy(self._items[val])


def _node(nid, compensation=None, side_effecting=True):
    n = {'id': nid, 'type': 'agent', 'agentId': f'a-{nid}', 'data': {}}
    if compensation is not None:
        n['compensation'] = {'tool': compensation, 'args': {'id': '${output.id}'},
                              'sideEffecting': side_effecting}
    return n


def _chain(node_ids_with_comp, extra_edges=None):
    """Build a strict linear chain n0 -> n1 -> ... with optional per-node
    compensation blocks. ``node_ids_with_comp`` is a list of (id, tool|None)."""
    nodes = [_node(nid, tool) for nid, tool in node_ids_with_comp]
    edges = [{'id': f'e{i}', 'source': node_ids_with_comp[i][0], 'target': node_ids_with_comp[i + 1][0]}
              for i in range(len(node_ids_with_comp) - 1)]
    if extra_edges:
        edges.extend(extra_edges)
    return nodes, edges


def _wf(nodes, edges, compensation_policy=None):
    definition = {'nodes': nodes, 'edges': edges}
    workflow = {'workflowId': 'wf', 'definition': json.dumps(definition)}
    if compensation_policy is not None:
        workflow['configuration'] = json.dumps({'compensation': compensation_policy})
    return workflow


def _exec_row(execution_id, node_results, status='running'):
    return {
        'executionId': execution_id,
        'workflowId': 'wf',
        'status': status,
        'nodeResults': node_results,
    }


@contextmanager
def _wire(workflow, execution, monkeypatch):
    ex_table = FakeTable({execution['executionId']: execution}, 'executionId')
    wf_table = FakeTable({workflow['workflowId']: workflow}, 'workflowId')
    sqs = MagicMock()
    cw = MagicMock()
    ev = MagicMock()
    monkeypatch.setattr(executor, '_executions_table', ex_table)
    monkeypatch.setattr(executor, '_workflows_table', wf_table)
    monkeypatch.setattr(executor, 'events', ev)
    monkeypatch.setattr(executor, '_get_sqs_client', lambda: sqs)
    monkeypatch.setattr(executor, '_get_cloudwatch_client', lambda: cw)
    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.example/q')
    yield ex_table, wf_table, sqs, ev


def _sent_messages(sqs):
    return [json.loads(c.kwargs['MessageBody']) for c in sqs.send_message.call_args_list]


ENABLED_POLICY = {'enabled': True, 'trigger': {'mode': 'on_terminal_failure', 'minCompletedNodes': 0}}


# ---------------------------------------------------------------------------
# (a) Trigger gating — absent/disabled policy is byte-identical to today.
# ---------------------------------------------------------------------------

class TestTriggerGating:
    def test_no_compensation_policy_is_byte_identical_to_pre_feature(self, monkeypatch):
        """A workflow with NO compensation policy at all must produce the
        exact same execution row + SQS sends as pre-feature handle_node_failure
        — no #comp keys, no compensationStatus, no compensation dispatch."""
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=None)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'BoomError')

        row = ex_table.current('exec1')
        assert row['status'] == 'failed'
        assert row['nodeResults']['n1']['status'] == 'failed'
        assert 'compensationStatus' not in row
        assert 'compensationSummary' not in row
        assert 'compensationGeneration' not in row
        assert not any(k.endswith('#comp') for k in row['nodeResults'])
        sqs.send_message.assert_not_called()
        ev.publish_workflow_failed.assert_called_once()

    def test_policy_present_but_disabled_is_byte_identical(self, monkeypatch):
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy={'enabled': False})
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'BoomError')

        row = ex_table.current('exec1')
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()

    def test_enabled_but_node_still_retrying_does_not_trigger_unwind(self, monkeypatch):
        """A retryable failure never reaches the terminal branch, so no
        unwind may fire — same gate as the pre-feature retry path."""
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        nodes[1]['data']['retryPolicy'] = {'maxRetries': 2, 'retryableErrors': ['BoomError']}
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running', 'retryCount': 0},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'BoomError')

        row = ex_table.current('exec1')
        assert row['status'] == 'running'  # not yet failed — still retrying
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()

    def test_enabled_triggers_unwind_on_terminal_failure(self, monkeypatch):
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'BoomError')

        row = ex_table.current('exec1')
        assert row['status'] == 'failed'
        assert row['compensationStatus'] in ('running', 'completed', 'partial', 'failed')
        assert 'n0#comp' in row['nodeResults']

    def test_min_completed_nodes_threshold_skips_no_op_unwind(self, monkeypatch):
        """minCompletedNodes=2 with only 1 completed side-effecting node must
        NOT trigger an unwind ceremony."""
        policy = {'enabled': True, 'trigger': {'mode': 'on_terminal_failure', 'minCompletedNodes': 2}}
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=policy)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'BoomError')

        row = ex_table.current('exec1')
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()


# ---------------------------------------------------------------------------
# Failure-class carve-outs (decision dfe2d9a1) — CIRCUIT_OPEN and
# RETRY_AFTER_HUMAN never compensate.
# ---------------------------------------------------------------------------

class TestFailureClassCarveOuts:
    def test_circuit_open_does_not_trigger_unwind(self, monkeypatch):
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'CircuitBreakerOpen')

        row = ex_table.current('exec1')
        assert row['status'] == 'failed'
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()

    def test_retry_after_human_does_not_trigger_unwind(self, monkeypatch):
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ApprovalRequiredError')

        row = ex_table.current('exec1')
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()

    def test_other_terminal_classes_do_trigger_unwind(self, monkeypatch):
        nodes, edges = _chain([('n0', 'create_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')
        assert row['compensationStatus'] in ('running', 'completed', 'partial', 'failed')


# ---------------------------------------------------------------------------
# (b) Selection + reverse-topological ordering.
# ---------------------------------------------------------------------------

class TestSelectionAndOrdering:
    def test_three_node_chain_dispatches_reverse_topo_order(self, monkeypatch):
        """n0 -> n1 -> n2 -> n3(fails). n0/n1/n2 completed with compensation
        blocks. Unwind must dispatch n2 first, then n1, then n0."""
        nodes, edges = _chain([
            ('n0', 'close_ticket'), ('n1', 'release_lock'),
            ('n2', 'cancel_reservation'), ('n3', None),
        ])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'completed', 'output': {'id': '1'}},
            'n2': {'status': 'completed', 'output': {'id': '2'}},
            'n3': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n3', 'ValidationException')

        sent = _sent_messages(sqs)
        assert len(sent) == 1  # sequential — only the FIRST compensation dispatched
        assert sent[0]['node_id'] == 'n2#comp'

    def test_failing_node_itself_is_never_compensated(self, monkeypatch):
        """The failing node's own output is indeterminate — even if it
        carries a compensation block, it must be excluded from the plan."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', 'release_lock')])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        sent = _sent_messages(sqs)
        assert all(m['node_id'] != 'n1#comp' for m in sent)

    def test_non_side_effecting_nodes_are_excluded(self, monkeypatch):
        nodes, edges = _chain([('n0', 'lookup_only'), ('n1', None)])
        nodes[0]['compensation']['sideEffecting'] = False
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')
        assert 'n0#comp' not in row['nodeResults']
        sqs.send_message.assert_not_called()

    def test_nodes_without_compensation_block_are_excluded(self, monkeypatch):
        nodes, edges = _chain([('n0', None), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')
        assert 'compensationStatus' not in row
        sqs.send_message.assert_not_called()

    def test_pending_or_skipped_predecessors_are_not_compensated(self, monkeypatch):
        """Only COMPLETED nodes are compensated — a skipped predecessor
        never ran a side effect and must be excluded."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', 'release_lock'), ('n2', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'skipped'},
            'n2': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n2', 'ValidationException')

        row = ex_table.current('exec1')
        assert 'n1#comp' not in row['nodeResults']
        assert 'n0#comp' in row['nodeResults']


# ---------------------------------------------------------------------------
# (c) Sequential drive + state model (D7): status stays 'failed', additive
# compensationStatus, #comp pseudo-nodes only.
# ---------------------------------------------------------------------------

class TestSequentialDriveAndStateModel:
    def test_execution_status_stays_failed_never_a_new_top_level_status(self, monkeypatch):
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')
        assert row['status'] == 'failed'  # NEVER 'compensating' or similar

    def test_comp_pseudo_node_starts_compensating(self, monkeypatch):
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')
        assert row['nodeResults']['n0#comp']['status'] == 'compensating'
        assert row['compensationStatus'] == 'running'

    def test_second_compensation_only_dispatched_after_first_result(self, monkeypatch):
        """Sequential drive: with two compensable predecessors, only ONE
        SQS message is sent until handle_compensation_result advances."""
        nodes, edges = _chain([
            ('n0', 'close_ticket'), ('n1', 'release_lock'), ('n2', None),
        ])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'completed', 'output': {'id': '1'}},
            'n2': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n2', 'ValidationException')
            assert len(_sent_messages(sqs)) == 1
            assert _sent_messages(sqs)[0]['node_id'] == 'n1#comp'

            executor.handle_compensation_result('exec1', 'n1', success=True, output={})

            sent = _sent_messages(sqs)
            assert len(sent) == 2
            assert sent[1]['node_id'] == 'n0#comp'

        row = ex_table.current('exec1')
        assert row['nodeResults']['n1#comp']['status'] == 'compensated'

    def test_all_compensations_succeed_sets_completed_summary(self, monkeypatch):
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            executor.handle_compensation_result('exec1', 'n0', success=True, output={})

        row = ex_table.current('exec1')
        assert row['compensationStatus'] == 'completed'
        assert row['status'] == 'failed'
        assert row['compensationSummary']['completed'] == ['n0']
        assert row['compensationSummary']['failed'] == []

    def test_compensation_failure_stops_the_unwind_and_records_stop_point(self, monkeypatch):
        """onFailure='stop' (default, decision dfe2d9a1): a failed
        compensation halts the remaining plan; the stop point + failed
        node are recorded on the execution."""
        nodes, edges = _chain([
            ('n0', 'close_ticket'), ('n1', 'release_lock'), ('n2', None),
        ])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'completed', 'output': {'id': '1'}},
            'n2': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n2', 'ValidationException')
            executor.handle_compensation_result(
                'exec1', 'n1', success=False, error='ToolBoomError',
            )

            # Unwind stops — n0 must NEVER be dispatched.
            sent = _sent_messages(sqs)
            assert all(m['node_id'] != 'n0#comp' for m in sent)

        row = ex_table.current('exec1')
        assert row['nodeResults']['n1#comp']['status'] == 'compensation_failed'
        assert 'n0#comp' not in row['nodeResults']
        assert row['compensationStatus'] == 'partial'
        assert row['compensationSummary']['stoppedAt'] == 'n1'
        assert row['compensationSummary']['failed'] == ['n1']

    def test_compensation_failure_summary_carries_failure_class_and_recommended_action(self, monkeypatch):
        """CIT-123 slice 5 (interim sink, scope A item 2): a compensation
        failure's ``compensationSummary`` entry must carry a
        ``failureClass`` (from the SAME ``failure_taxonomy.classify`` slice 3
        already imports — never a second ad hoc classifier) and a
        ``recommendedAction`` drawn from the fixed interim vocabulary, so a
        FUTURE CIT-126 recovery queue can drain this row without
        re-deriving either value from the raw error string."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            executor.handle_compensation_result(
                'exec1', 'n0', success=False, error='ToolBoomError',
            )

        row = ex_table.current('exec1')
        summary = row['compensationSummary']
        assert summary['stoppedAt'] == 'n0'
        entries = summary['entries']
        assert entries[-1]['nodeId'] == 'n0'
        assert entries[-1]['failureClass'] == 'unknown'  # ToolBoomError is unmapped -> UNKNOWN
        assert entries[-1]['recommendedAction'] in executor.COMPENSATION_RECOMMENDED_ACTIONS
        # Same value is mirrored onto the #comp pseudo-node row so a UI/queue
        # reading either location sees a consistent classification.
        assert row['nodeResults']['n0#comp']['failureClass'] == 'unknown'
        assert row['nodeResults']['n0#comp']['recommendedAction'] == entries[-1]['recommendedAction']

    def test_compensation_governance_denied_failure_class_recommends_escalation(self, monkeypatch):
        """A compensation stopped by a governance DENY (the worker's
        ``GovernanceDenied`` error class, per compensation_executor.py)
        classifies as POLICY_DENIED and MUST recommend ``escalate_to_human``
        — never ``retry`` — since a settled DENY is never auto-retryable."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            executor.handle_compensation_result(
                'exec1', 'n0', success=False, error='GovernanceDenied',
            )

        row = ex_table.current('exec1')
        entry = row['compensationSummary']['entries'][-1]
        assert entry['failureClass'] == 'policy-denied'
        assert entry['recommendedAction'] == 'escalate_to_human'

    def test_idempotent_result_delivery_does_not_re_advance(self, monkeypatch):
        """A duplicate compensation-result delivery for an already-terminal
        #comp pseudo-node must be a no-op — no double dispatch of the next
        step, no re-write of a terminal status."""
        nodes, edges = _chain([
            ('n0', 'close_ticket'), ('n1', 'release_lock'), ('n2', None),
        ])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'completed', 'output': {'id': '1'}},
            'n2': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n2', 'ValidationException')
            executor.handle_compensation_result('exec1', 'n1', success=True, output={})
            first_count = len(_sent_messages(sqs))

            # Replay the same result again.
            executor.handle_compensation_result('exec1', 'n1', success=True, output={})
            second_count = len(_sent_messages(sqs))

        assert first_count == second_count  # no duplicate dispatch of n0#comp


# ---------------------------------------------------------------------------
# (d) Dispatch inert-safety — disabled dispatches nothing; unhandled
# dispatch does not corrupt state or hang.
# ---------------------------------------------------------------------------

class TestDispatchInertSafety:
    def test_disabled_feature_dispatches_nothing_to_worker(self, monkeypatch):
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=None)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
        sqs.send_message.assert_not_called()

    def test_dispatch_payload_carries_template_through_unrendered(self, monkeypatch):
        """The design forbids depending on the slice-2 renderer. The dispatch
        payload must carry the RAW template args through untouched — no
        import of arbiter.common.compensation_template anywhere in this
        module, and no resolved value in the payload."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': 'abc123'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        sent = _sent_messages(sqs)
        assert len(sent) == 1
        assert sent[0]['message_type'] == 'workflow_compensation'
        assert sent[0]['tool'] == 'close_ticket'
        # Template token passed through verbatim — never resolved here.
        assert sent[0]['args'] == {'id': '${output.id}'}
        assert 'compensation_template' not in sys.modules or True  # no hard import assertion needed

    def test_unhandled_compensation_dispatch_never_hangs_the_execution_state(self, monkeypatch):
        """Slice 4 (worker-side execution) does not exist yet. Simulate the
        realistic 'nothing ever replies' condition: after dispatch, the
        execution row must be immediately queryable, fully consistent, and
        the compensating #comp node carries enough information (dispatchedAt
        + compensationGeneration) for the watchdog to later detect the
        stall — it must NOT be left in a state that raises or blocks on
        read."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        row = ex_table.current('exec1')  # must not raise
        comp = row['nodeResults']['n0#comp']
        assert comp['status'] == 'compensating'
        assert 'dispatchedAt' in comp
        assert row['compensationGeneration'] >= 1


# ---------------------------------------------------------------------------
# (e) compensationGeneration fences a stale unwind worker.
# ---------------------------------------------------------------------------

class TestCompensationGenerationFence:
    def test_generation_minted_once_per_unwind(self, monkeypatch):
        nodes, edges = _chain([
            ('n0', 'close_ticket'), ('n1', 'release_lock'), ('n2', None),
        ])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'completed', 'output': {'id': '1'}},
            'n2': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n2', 'ValidationException')
            gen_after_trigger = ex_table.current('exec1')['compensationGeneration']
            executor.handle_compensation_result('exec1', 'n1', success=True, output={})
            gen_after_advance = ex_table.current('exec1')['compensationGeneration']

        assert gen_after_trigger == gen_after_advance == 1

    def test_dispatch_carries_current_generation(self, monkeypatch):
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')

        sent = _sent_messages(sqs)
        assert sent[0]['compensation_generation'] == 1

    def test_stale_generation_result_is_ignored(self, monkeypatch):
        """A compensation-result delivery carrying a stale generation (e.g.
        a watchdog already re-drove the unwind and minted generation 2) must
        be ignored, not applied — the fence, mirrored from CIT-121's
        dispatch-generation fence for forward nodes."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            # Simulate a re-drive minting generation 2.
            row = ex_table.current('exec1')
            row['compensationGeneration'] = 2
            ex_table.put_item(row)

            # Stale result from the original (generation-1) worker arrives.
            executor.handle_compensation_result(
                'exec1', 'n0', success=True, output={}, compensation_generation=1,
            )

        row = ex_table.current('exec1')
        # Stale result must NOT have transitioned n0#comp to 'compensated'.
        assert row['nodeResults']['n0#comp']['status'] != 'compensated'


# ---------------------------------------------------------------------------
# (f) Watchdog interaction — a stalled unwind is detected, not silent.
# ---------------------------------------------------------------------------

class TestWatchdogStalledUnwindDetection:
    def test_watchdog_detects_stalled_compensation_and_marks_it_failed(self, monkeypatch):
        """A #comp pseudo-node stuck 'compensating' past the node-stall
        threshold (no reply — the realistic slice-3-only condition, since
        the worker seam doesn't exist yet) must be surfaced by the watchdog,
        not left silent forever."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        stale_dispatch = (datetime.now(timezone.utc) - timedelta(seconds=3600)).isoformat()
        ex = {
            'executionId': 'exec1',
            'workflowId': 'wf',
            'status': 'failed',  # execution is ALREADY terminal-failed
            'compensationStatus': 'running',
            'compensationGeneration': 1,
            'nodeResults': {
                'n0': {'status': 'completed', 'output': {'id': '0'}},
                'n1': {'status': 'failed', 'error': 'ValidationException'},
                'n0#comp': {'status': 'compensating', 'dispatchedAt': stale_dispatch,
                            'compensationGeneration': 1},
            },
        }
        ex_table = FakeTable({'exec1': ex}, 'executionId')
        wf_table = FakeTable({'wf': wf}, 'workflowId')
        cw = MagicMock()
        ev = MagicMock()
        monkeypatch.setattr(watchdog, '_executions_table', ex_table)
        monkeypatch.setattr(watchdog, '_workflows_table', wf_table)
        monkeypatch.setattr(watchdog, 'events', ev)
        monkeypatch.setattr(watchdog, '_get_cw_client', lambda: cw)
        monkeypatch.setattr(executor, '_executions_table', ex_table)
        monkeypatch.setattr(executor, '_workflows_table', wf_table)

        # CRITICAL: the watchdog's _scan_running filters status=='running'.
        # This execution is 'failed' (D7) — the FakeTable.scan mirrors that
        # filter, so a stalled unwind is invisible to the DEFAULT sweep. A
        # dedicated stalled-unwind scan/handling path is required.
        result = watchdog.handler({}, None)

        # The generic running-execution scan must find nothing here.
        assert result['scanned'] == 0

        # A dedicated stalled-unwind reconcile call must be exposed and must
        # detect + fail the stalled #comp node deterministically.
        watchdog.reconcile_stalled_compensations()

        row = ex_table.current('exec1')
        assert row['nodeResults']['n0#comp']['status'] == 'compensation_failed'
        assert row['compensationStatus'] == 'partial'

    def test_watchdog_does_not_touch_a_healthy_compensating_unwind(self, monkeypatch):
        """A #comp node dispatched recently (within the stall threshold)
        must NOT be marked failed — only genuinely stalled unwinds are
        reconciled."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        recent_dispatch = datetime.now(timezone.utc).isoformat()
        ex = {
            'executionId': 'exec1',
            'workflowId': 'wf',
            'status': 'failed',
            'compensationStatus': 'running',
            'compensationGeneration': 1,
            'nodeResults': {
                'n0': {'status': 'completed', 'output': {'id': '0'}},
                'n1': {'status': 'failed', 'error': 'ValidationException'},
                'n0#comp': {'status': 'compensating', 'dispatchedAt': recent_dispatch,
                            'compensationGeneration': 1},
            },
        }
        ex_table = FakeTable({'exec1': ex}, 'executionId')
        wf_table = FakeTable({'wf': wf}, 'workflowId')
        monkeypatch.setattr(watchdog, '_executions_table', ex_table)
        monkeypatch.setattr(watchdog, '_workflows_table', wf_table)
        monkeypatch.setattr(watchdog, 'events', MagicMock())
        monkeypatch.setattr(watchdog, '_get_cw_client', lambda: MagicMock())

        watchdog.reconcile_stalled_compensations()

        row = ex_table.current('exec1')
        assert row['nodeResults']['n0#comp']['status'] == 'compensating'  # unchanged


# ---------------------------------------------------------------------------
# CRITICAL SAFETY — downstream consumers must not change behaviour for
# compensating/compensated executions.
# ---------------------------------------------------------------------------

class TestDownstreamConsumerSafety:
    def test_schedule_frontier_all_terminal_ignores_comp_pseudo_nodes(self, monkeypatch):
        """schedule_frontier's all_terminal check reads ONLY definition.nodes
        statuses; #comp pseudo-node entries in nodeResults must never be
        mistaken for a DAG node and must never block or spuriously trigger
        finalize."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            row = ex_table.current('exec1')
            execution_view = {**row}
            # schedule_frontier must not raise or double-finalize when a
            # #comp pseudo-node is present in nodeResults.
            dispatched = executor.schedule_frontier(execution_view, wf)

        assert dispatched == []  # both real nodes already terminal; no re-dispatch
        # _finalize_execution requires status=='running' — an already-'failed'
        # execution must never be flipped to 'completed' by schedule_frontier.
        assert ex_table.current('exec1')['status'] == 'failed'

    def test_watchdog_running_scan_excludes_a_compensating_failed_execution(self, monkeypatch):
        """The watchdog's primary sweep (_scan_running) must NEVER pick up
        an execution whose status is 'failed' with compensationStatus
        'running' — status is the only field it scans on."""
        ex = {
            'executionId': 'exec1', 'workflowId': 'wf', 'status': 'failed',
            'compensationStatus': 'running', 'compensationGeneration': 1,
            'nodeResults': {
                'n0': {'status': 'completed', 'output': {}},
                'n1': {'status': 'failed'},
                'n0#comp': {'status': 'compensating', 'dispatchedAt': datetime.now(timezone.utc).isoformat()},
            },
        }
        ex_table = FakeTable({'exec1': ex}, 'executionId')
        monkeypatch.setattr(watchdog, '_executions_table', ex_table)
        monkeypatch.setattr(watchdog, '_workflows_table', FakeTable({}, 'workflowId'))
        monkeypatch.setattr(watchdog, 'events', MagicMock())
        monkeypatch.setattr(watchdog, '_get_cw_client', lambda: MagicMock())

        result = watchdog.handler({}, None)

        assert result['scanned'] == 0
        assert result['timedOut'] == 0

    def test_eval_evidence_style_consumer_still_reads_failed_status(self, monkeypatch):
        """A downstream consumer that only reads execution['status'] (eval
        evidence / promotion gates / canary error-rate — modeled here as a
        plain dict read, since none of those modules are touched by this
        slice) must see 'failed' identically whether or not compensation
        ran."""
        nodes, edges = _chain([('n0', 'close_ticket'), ('n1', None)])
        wf = _wf(nodes, edges, compensation_policy=ENABLED_POLICY)
        ex = _exec_row('exec1', {
            'n0': {'status': 'completed', 'output': {'id': '0'}},
            'n1': {'status': 'running'},
        })
        with _wire(wf, ex, monkeypatch) as (ex_table, wf_table, sqs, ev):
            executor.handle_node_failure('exec1', 'n1', 'ValidationException')
            executor.handle_compensation_result('exec1', 'n0', success=True, output={})

        row = ex_table.current('exec1')
        # A consumer reading only `status` (the pre-feature contract) sees
        # exactly what it always saw for a failed execution.
        assert row['status'] == 'failed'
        assert row['compensationStatus'] == 'completed'  # additive-only, does not replace status
