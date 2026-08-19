"""
Write-then-signal tests for the worker's workflow-node completion path
(decision O2).

The worker must persist a completed node's result to EXECUTIONS_TABLE.nodeResults
BEFORE emitting workflow.node.completed, so a lost event never leaves a
signaled-but-unpersisted black hole — only a benign, reconcilable
persisted-but-unsignaled state. The persist is a conditional first-write-wins
UpdateItem (status <> completed) so a duplicate / re-dispatched worker cannot
overwrite an existing completion.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
"""

import json
import sys
from unittest.mock import patch, MagicMock

import pytest
from botocore.exceptions import ClientError


NODE_MESSAGE = {
    'message_type': 'workflow_node',
    'execution_id': 'exec-1',
    'node_id': 'n0',
    'workflow_id': 'wf-1',
    'agent_id': 'agent-A',
    'input': {'taskDetails': 'do the thing'},
    'configuration': {},
}

_NODE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _run_node(index, table_mock, events_mock, *, response='done'):
    mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': response}), stderr='')
    resource_mock = MagicMock()
    resource_mock.Table.return_value = table_mock
    with patch('boto3.resource', return_value=resource_mock), \
         patch('boto3.client', return_value=events_mock):
        with patch.object(index, 'load_config_from_dynamodb',
                          return_value={'config': {'filename': 'agent.py'}}), \
             patch.object(index, 'get_scoped_credentials', return_value=None), \
             patch.object(index, 'load_file_from_s3_into_tmp'), \
             patch('subprocess.run', return_value=mock_result):
            index.process_event(dict(NODE_MESSAGE), {})


class TestWriteThenSignalOrdering:
    def test_persist_commits_before_signal_is_emitted(self):
        """The durable nodeResults write must happen BEFORE put_events."""
        order = []
        table = MagicMock()
        table.update_item.side_effect = lambda **kw: order.append('persist')
        events = MagicMock()
        events.put_events.side_effect = lambda **kw: (order.append('emit'),
                                                      {'FailedEntryCount': 0})[1]

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            _run_node(index, table, events)

        assert order == ['persist', 'emit']

    def test_persist_is_conditional_first_write_wins_on_node_status(self):
        """The persist uses a conditional first-write-wins guard scoped to this
        node's nodeResults status, writing status=completed + output."""
        table = MagicMock()
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            _run_node(index, table, events)

        table.update_item.assert_called_once()
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['Key'] == {'executionId': 'exec-1'}
        assert kwargs['ConditionExpression'] == 'nodeResults.#nid.#status <> :completed'
        assert kwargs['ExpressionAttributeNames']['#nid'] == 'n0'
        assert kwargs['ExpressionAttributeValues'][':status'] == 'completed'
        assert kwargs['ExpressionAttributeValues'][':completed'] == 'completed'
        # Writes only the five nodeResults attributes — never execution-level
        # status/orgId/output (those are the stepRunner/watchdog's to write).
        assert kwargs['ExpressionAttributeValues'][':output']['response'] == 'done'


class TestWriteThenSignalIdempotency:
    def test_already_completed_persist_is_benign_and_still_signals(self):
        """A ConditionalCheckFailed (node already completed — duplicate /
        re-dispatch) is a benign no-op: the worker still emits the signal
        (advancement downstream is idempotent)."""
        table = MagicMock()
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'x'}}, 'UpdateItem',
        )
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            _run_node(index, table, events)

        # Signal still emitted despite the persist no-op.
        events.put_events.assert_called_once()
        entry = events.put_events.call_args.kwargs['Entries'][0]
        assert json.loads(entry['Detail'])['status'] == 'completed'

    def test_real_persist_error_raises_and_does_not_signal(self):
        """A non-conditional DynamoDB error must NOT emit an unpersisted
        completion — it re-raises so SQS redelivers (signal-only-after-durable-
        write invariant)."""
        table = MagicMock()
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}},
            'UpdateItem',
        )
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with pytest.raises(ClientError):
                _run_node(index, table, events)

        events.put_events.assert_not_called()

    def test_no_executions_table_env_skips_persist_but_still_signals(self):
        """Without EXECUTIONS_TABLE configured the durable write is skipped
        (stepRunner backstop remains); emission is never blocked."""
        env = {k: v for k, v in _NODE_ENV.items() if k != 'EXECUTIONS_TABLE'}
        table = MagicMock()
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', env, clear=False):
            import os as _os
            _os.environ.pop('EXECUTIONS_TABLE', None)
            index = _fresh_index()
            _run_node(index, table, events)

        table.update_item.assert_not_called()
        events.put_events.assert_called_once()

    def test_failed_node_does_not_persist_completion(self):
        """A failed node emits node.failed and must NOT write a completed
        nodeResults entry (retry/terminal is a stepRunner control decision)."""
        table = MagicMock()
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}
        mock_result = MagicMock(returncode=1, stdout='', stderr='boom')
        resource_mock = MagicMock()
        resource_mock.Table.return_value = table

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with patch('boto3.resource', return_value=resource_mock), \
                 patch('boto3.client', return_value=events):
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        table.update_item.assert_not_called()
        entry = events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.failed'
