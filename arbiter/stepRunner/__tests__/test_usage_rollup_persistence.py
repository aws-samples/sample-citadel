"""
Unit + property tests for the usage rollup's persistence and idempotency.

``handle_node_completion`` now accepts an additive ``usage`` argument (a list
of worker usage records, defaulting to ``[]``). The SAME completed-node
``update_item`` call persists the sanitized usage array and its per-node
totals under ``nodeResults[nodeId].usage`` / ``.usageTotals`` via a per-node
SET — never an ADD, so reprocessing writes byte-identical values.

Covers (design test list #2/#3/#4/#7):
  * the update writes usage + usageTotals in the SAME update_item call
  * the UpdateExpression contains no ADD anywhere
  * a duplicate delivery (guard intact) leaves totals unchanged
  * a guard-bypass variant proves the SET itself is idempotent (last-write-wins)
  * fallback: usage supplied only via output['usage'] (no top-level arg) still
    persists totals
  * concurrent completions of different nodes never collide on usage keys

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock
from hypothesis import given, settings
from hypothesis import strategies as st


CHAIN_WORKFLOW = {
    'workflowId': 'wf-chain',
    'name': 'Chain',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {}},
        ],
        'edges': [{'id': 'e0', 'source': 'n0', 'target': 'n1'}],
    }),
    'configuration': json.dumps({}),
}

CHAIN_EXEC = {
    'executionId': 'exec-chain',
    'workflowId': 'wf-chain',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
    },
}

DIAMOND_WORKFLOW = {
    'workflowId': 'wf-diamond',
    'name': 'Diamond',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {}},
            {'id': 'n2', 'type': 'agent', 'agentId': 'agent-C', 'data': {}},
            {'id': 'n3', 'type': 'agent', 'agentId': 'agent-D', 'data': {}},
        ],
        'edges': [
            {'id': 'e0', 'source': 'n0', 'target': 'n1'},
            {'id': 'e1', 'source': 'n0', 'target': 'n2'},
            {'id': 'e2', 'source': 'n1', 'target': 'n3'},
            {'id': 'e3', 'source': 'n2', 'target': 'n3'},
        ],
    }),
    'configuration': json.dumps({}),
}

DIAMOND_EXEC = {
    'executionId': 'exec-diamond',
    'workflowId': 'wf-diamond',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'completed', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'running', 'retryCount': 0},
        'n2': {'nodeId': 'n2', 'agentId': 'agent-C', 'status': 'running', 'retryCount': 0},
        'n3': {'nodeId': 'n3', 'agentId': 'agent-D', 'status': 'pending', 'retryCount': 0},
    },
}


@pytest.fixture
def mock_exec():
    """Patch the module-level tables, events, and SQS client on executor."""
    import executor

    tables = {
        'workflows_table': MagicMock(),
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'sqs': MagicMock(),
    }
    with patch.object(executor, '_workflows_table', tables['workflows_table']), \
         patch.object(executor, '_executions_table', tables['executions_table']), \
         patch.object(executor, 'events', tables['events']), \
         patch.object(executor, '_get_sqs_client', return_value=tables['sqs']):
        yield tables


def _completed_update_calls(executions_table):
    """Return update_item calls whose UpdateExpression sets nodeResults status
    to completed (the single call the usage rollup augments)."""
    calls = []
    for call in executions_table.update_item.call_args_list:
        kwargs = call.kwargs
        expr = kwargs.get('UpdateExpression', '')
        values = kwargs.get('ExpressionAttributeValues', {})
        if 'nodeResults.#nid.#status' in expr and values.get(':status') == 'completed':
            calls.append(kwargs)
    return calls


class TestUsagePersistedInSameUpdateCall:
    def test_completed_update_call_sets_usage_and_usage_totals(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_EXEC)}

        usage = [{'inputTokens': 10, 'outputTokens': 5}]
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)

        calls = _completed_update_calls(mock_exec['executions_table'])
        assert len(calls) == 1
        kwargs = calls[0]
        assert 'nodeResults.#nid.#usage' in kwargs['UpdateExpression']
        assert 'nodeResults.#nid.#usageTotals' in kwargs['UpdateExpression']
        assert kwargs['ExpressionAttributeValues'][':usage'] == usage
        assert kwargs['ExpressionAttributeValues'][':usageTotals'] == {
            'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15, 'callCount': 1,
        }

    def test_update_expression_never_contains_add(self, mock_exec, monkeypatch):
        """Design constraint: the usage write is a per-node SET, never an ADD."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_EXEC)}

        executor.handle_node_completion(
            'exec-chain', 'n0', {'result': 'done'}, [{'inputTokens': 1, 'outputTokens': 1}],
        )

        for call in mock_exec['executions_table'].update_item.call_args_list:
            expr = call.kwargs.get('UpdateExpression', '')
            # 'ADD' as a distinct clause keyword, not a substring of e.g. an
            # attribute name — every clause in this codebase starts with SET.
            assert not expr.strip().upper().startswith('ADD ')
            assert ' ADD ' not in f' {expr.upper()} '

    def test_fallback_when_usage_only_in_output(self, mock_exec, monkeypatch):
        """Back-compat: no top-level usage arg (defaults to None) — the
        function falls back to output['usage'] itself so a direct caller
        (or an old in-flight event) still gets usage persisted."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_EXEC)}

        output = {'result': 'done', 'usage': [{'inputTokens': 2, 'outputTokens': 3}]}
        # usage arg omitted entirely -> falls back to output['usage'].
        executor.handle_node_completion('exec-chain', 'n0', output)

        calls = _completed_update_calls(mock_exec['executions_table'])
        assert calls[0]['ExpressionAttributeValues'][':usage'] == [{'inputTokens': 2, 'outputTokens': 3}]
        assert calls[0]['ExpressionAttributeValues'][':usageTotals'] == {
            'inputTokens': 2, 'outputTokens': 3, 'totalTokens': 5, 'callCount': 1,
        }


class TestDuplicateDeliveryUsageIdempotency:
    def _exec_get_item_first_running_then(self, status_after, node_id, base_exec):
        call_count = [0]

        def side_effect(**kwargs):
            call_count[0] += 1
            e = copy.deepcopy(base_exec)
            if call_count[0] == 1:
                e['nodeResults'][node_id]['status'] = 'running'
            else:
                e['nodeResults'][node_id]['status'] = status_after
            return {'Item': e}

        return side_effect

    def test_duplicate_completion_leaves_persisted_usage_totals_unchanged(self, mock_exec, monkeypatch):
        """With the status guard intact, a redelivered node-completed event
        (with usage) is a full no-op on the second call — the completed
        update_item (and thus its usage write) fires exactly once."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        mock_exec['executions_table'].get_item.side_effect = \
            self._exec_get_item_first_running_then('completed', 'n0', CHAIN_EXEC)

        usage = [{'inputTokens': 10, 'outputTokens': 5}]
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)  # duplicate

        calls = _completed_update_calls(mock_exec['executions_table'])
        assert len(calls) == 1  # guard short-circuits the second delivery entirely

    def test_guard_bypass_write_is_still_idempotent_last_write_wins(self, mock_exec, monkeypatch):
        """Even if the guard were bypassed (never returns early), calling the
        completed-update path twice with identical usage writes byte-identical
        SET values both times — last-write-wins, no drift."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        # Always return a FRESH deep copy of the node as 'running' so the
        # guard never short-circuits on either call — this exercises the
        # write's own idempotency, not the guard's, and avoids the executor's
        # in-place node_results mutation leaking between calls (which would
        # otherwise make the second call see 'completed' via the SAME dict
        # object returned by a plain .return_value).
        mock_exec['executions_table'].get_item.side_effect = \
            lambda **kwargs: {'Item': copy.deepcopy(CHAIN_EXEC)}

        usage = [{'inputTokens': 10, 'outputTokens': 5}]
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)
        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)

        calls = _completed_update_calls(mock_exec['executions_table'])
        assert len(calls) == 2
        assert calls[0]['ExpressionAttributeValues'][':usage'] == calls[1]['ExpressionAttributeValues'][':usage']
        assert calls[0]['ExpressionAttributeValues'][':usageTotals'] == calls[1]['ExpressionAttributeValues'][':usageTotals']

    @given(dup_count=st.integers(min_value=0, max_value=5))
    @settings(max_examples=20, deadline=None)
    def test_any_number_of_duplicates_leave_usage_totals_stable(self, dup_count):
        """Property: 1 real completion + N duplicates ⇒ the persisted usage
        totals are identical to the single-delivery case (guard intact)."""
        import executor

        wf_table = MagicMock()
        exec_table = MagicMock()
        ev = MagicMock()
        wf_table.get_item.return_value = {'Item': copy.deepcopy(CHAIN_WORKFLOW)}
        exec_table.get_item.side_effect = \
            self._exec_get_item_first_running_then('completed', 'n0', CHAIN_EXEC)

        usage = [{'inputTokens': 7, 'outputTokens': 2}]
        with patch.object(executor, '_workflows_table', wf_table), \
             patch.object(executor, '_executions_table', exec_table), \
             patch.object(executor, 'events', ev), \
             patch.object(executor, '_get_sqs_client', return_value=MagicMock()), \
             patch.dict(os.environ, {}, clear=False):
            os.environ.pop('WORKER_QUEUE_URL', None)
            for _ in range(1 + dup_count):
                executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'}, usage)

        calls = _completed_update_calls(exec_table)
        assert len(calls) == 1
        assert calls[0]['ExpressionAttributeValues'][':usageTotals'] == {
            'inputTokens': 7, 'outputTokens': 2, 'totalTokens': 9, 'callCount': 1,
        }


class TestConcurrentNodesNoKeyCollision:
    def test_diamond_two_predecessors_each_write_own_usage_keys(self, mock_exec, monkeypatch):
        """Two different nodes (n1, n2) completing concurrently each write
        their own nodeResults[nid].usage / .usageTotals — no key collision,
        no clobbering of the other node's usage."""
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(DIAMOND_WORKFLOW)}

        # n1 completes first (n2 still running in the persisted view).
        exec_after_n1 = copy.deepcopy(DIAMOND_EXEC)
        exec_after_n1['nodeResults']['n1']['status'] = 'completed'
        mock_exec['executions_table'].get_item.side_effect = [
            {'Item': copy.deepcopy(DIAMOND_EXEC)},
            {'Item': exec_after_n1},
        ]

        usage_n1 = [{'inputTokens': 4, 'outputTokens': 1}]
        usage_n2 = [{'inputTokens': 9, 'outputTokens': 6}]
        executor.handle_node_completion('exec-diamond', 'n1', {'r': 1}, usage_n1)
        executor.handle_node_completion('exec-diamond', 'n2', {'r': 2}, usage_n2)

        calls = _completed_update_calls(mock_exec['executions_table'])
        assert len(calls) == 2
        by_node = {c['ExpressionAttributeNames']['#nid']: c for c in calls}
        assert by_node['n1']['ExpressionAttributeValues'][':usage'] == usage_n1
        assert by_node['n2']['ExpressionAttributeValues'][':usage'] == usage_n2
        assert by_node['n1']['ExpressionAttributeValues'][':usageTotals']['totalTokens'] == 5
        assert by_node['n2']['ExpressionAttributeValues'][':usageTotals']['totalTokens'] == 15
