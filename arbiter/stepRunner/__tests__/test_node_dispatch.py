"""
Unit tests for the step runner ↔ worker execution bridge.

Covers two coordination decisions:

* Node dispatch — invoke_node sends exactly one discriminated SQS message,
  shaped by the shared contract, to WORKER_QUEUE_URL (D1: reuse the shared
  worker queue with a payload discriminator).
* Self-loop fix — handle_node_completion / handle_node_failure no longer
  re-emit workflow.node.completed / workflow.node.failed (D2: the worker is
  their sole producer and the step runner's own rules consume them), yet still
  advance the DAG, dispatch the next node, and emit the terminal event.

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock

from common import workflow_contract


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

TWO_NODE_WORKFLOW = {
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

TWO_NODE_EXEC = {
    'executionId': 'exec-chain',
    'workflowId': 'wf-chain',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
    },
}

SINGLE_NODE_WORKFLOW = {
    'workflowId': 'wf-single',
    'name': 'Single',
    'definition': json.dumps({
        'nodes': [{'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

SINGLE_NODE_EXEC = {
    'executionId': 'exec-single',
    'workflowId': 'wf-single',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
    },
}

FAIL_WORKFLOW = {
    'workflowId': 'wf-fail',
    'name': 'Fail',
    'definition': json.dumps({
        'nodes': [{'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

FAIL_EXEC = {
    'executionId': 'exec-fail',
    'workflowId': 'wf-fail',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
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


# ---------------------------------------------------------------------------
# Node dispatch (D1)
# ---------------------------------------------------------------------------

class TestInvokeNodeDispatch:
    def test_invoke_node_sends_one_contract_message_to_worker_queue(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        node = {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}

        executor.invoke_node('exec-1', 'wf-1', node, {'k': 'v'}, {'cfg': 1})

        sqs = mock_exec['sqs']
        sqs.send_message.assert_called_once()
        kwargs = sqs.send_message.call_args.kwargs
        assert kwargs['QueueUrl'] == 'https://sqs.fake/worker-queue'

        body = json.loads(kwargs['MessageBody'])
        # Discriminator + contract shape (snake_case, matching the queue's
        # supervisor-task neighbour).
        assert body['message_type'] == workflow_contract.MESSAGE_TYPE_WORKFLOW_NODE
        assert body['execution_id'] == 'exec-1'
        assert body['node_id'] == 'n0'
        assert body['workflow_id'] == 'wf-1'
        assert body['agent_id'] == 'agent-A'
        assert body['input'] == {'k': 'v'}
        assert body['configuration'] == {'cfg': 1}

        # Round-trips through the contract's own parser.
        parsed = workflow_contract.parse_node_dispatch_message(body)
        assert parsed.node_id == 'n0'
        assert parsed.agent_id == 'agent-A'

        # node.started is still emitted before dispatch.
        mock_exec['events'].publish_node_started.assert_called_once()

    def test_invoke_node_without_queue_url_does_not_dispatch(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        node = {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}}

        executor.invoke_node('exec-1', 'wf-1', node, {}, {})

        # Defensive: no queue configured → no send, but node.started still fired.
        mock_exec['sqs'].send_message.assert_not_called()
        mock_exec['events'].publish_node_started.assert_called_once()


# ---------------------------------------------------------------------------
# Self-loop fix (D2)
# ---------------------------------------------------------------------------

class TestNoSelfReemit:
    def test_completion_does_not_reemit_but_advances_and_dispatches_next(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(TWO_NODE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(TWO_NODE_EXEC)}

        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})

        # D2: never re-emits workflow.node.completed.
        mock_exec['events'].publish_node_completed.assert_not_called()
        # Not terminal yet (n1 still pending) → no workflow.completed.
        mock_exec['events'].publish_workflow_completed.assert_not_called()
        # Advances: next node n1 started + dispatched to the worker queue.
        mock_exec['events'].publish_node_started.assert_called_once()
        mock_exec['sqs'].send_message.assert_called_once()
        body = json.loads(mock_exec['sqs'].send_message.call_args.kwargs['MessageBody'])
        assert body['node_id'] == 'n1'
        assert body['agent_id'] == 'agent-B'

    def test_completion_of_last_node_emits_terminal_completion(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.delenv('WORKER_QUEUE_URL', raising=False)
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_NODE_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(SINGLE_NODE_EXEC)}

        executor.handle_node_completion('exec-single', 'n0', {'ok': True})

        # D2: no re-emit, but terminal workflow.completed still fires.
        mock_exec['events'].publish_node_completed.assert_not_called()
        mock_exec['events'].publish_workflow_completed.assert_called_once()
        # No further node to dispatch.
        mock_exec['sqs'].send_message.assert_not_called()

    def test_failure_does_not_reemit_but_emits_terminal_workflow_failed(self, mock_exec):
        import executor

        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(FAIL_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(FAIL_EXEC)}

        # No retry policy → not retryable → fail the execution.
        executor.handle_node_failure('exec-fail', 'n0', 'FatalError')

        # D2: never re-emits workflow.node.failed.
        mock_exec['events'].publish_node_failed.assert_not_called()
        # Terminal workflow.failed is still emitted.
        mock_exec['events'].publish_workflow_failed.assert_called_once()

    def test_failure_retries_without_node_failed_reemit(self, mock_exec):
        import executor

        wf = copy.deepcopy(FAIL_WORKFLOW)
        defn = json.loads(wf['definition'])
        defn['nodes'][0]['data']['retryPolicy'] = {
            'maxRetries': 3,
            'backoffBase': 1.0,
            'backoffMax': 10.0,
            'retryableErrors': ['TimeoutError'],
        }
        wf['definition'] = json.dumps(defn)

        mock_exec['workflows_table'].get_item.return_value = {'Item': wf}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(FAIL_EXEC)}

        executor.handle_node_failure('exec-fail', 'n0', 'TimeoutError')

        # Retry path: retrying event fires; neither node.failed nor
        # workflow.failed is emitted.
        mock_exec['events'].publish_node_retrying.assert_called_once()
        mock_exec['events'].publish_node_failed.assert_not_called()
        mock_exec['events'].publish_workflow_failed.assert_not_called()


# ---------------------------------------------------------------------------
# Per-node configuration merge at dispatch (decision 59376546)
# ---------------------------------------------------------------------------
# Merge precedence: node configuration overrides workflow-level configuration
# per-key; workflow-only keys are preserved; unknown keys are carried through.
# A node without configuration dispatches the workflow config only —
# byte-identical to the pre-feature behaviour (regression pins).

WF_CONFIG = {'modelOverride': 'us.wf-model', 'shared': 'wf-value'}
NODE_CONFIG = {'modelOverride': 'us.node-model', 'systemPromptAddition': 'Be terse.'}
MERGED_CONFIG = {
    'modelOverride': 'us.node-model',
    'systemPromptAddition': 'Be terse.',
    'shared': 'wf-value',
}

ROOT_CFG_WORKFLOW = {
    'workflowId': 'wf-cfg-root',
    'name': 'CfgRoot',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {},
             'configuration': NODE_CONFIG},
        ],
        'edges': [],
    }),
    'configuration': json.dumps(WF_CONFIG),
}

ROOT_CFG_EXEC = {
    'executionId': 'exec-cfg-root',
    'workflowId': 'wf-cfg-root',
    'appId': 'app-1',
    'status': 'pending',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
    },
}

CHAIN_CFG_WORKFLOW = {
    'workflowId': 'wf-cfg-chain',
    'name': 'CfgChain',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {}},
            {'id': 'n1', 'type': 'agent', 'agentId': 'agent-B', 'data': {},
             'configuration': NODE_CONFIG},
        ],
        'edges': [{'id': 'e0', 'source': 'n0', 'target': 'n1'}],
    }),
    'configuration': json.dumps(WF_CONFIG),
}

CHAIN_CFG_EXEC = {
    'executionId': 'exec-cfg-chain',
    'workflowId': 'wf-cfg-chain',
    'appId': 'app-1',
    'status': 'running',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'running', 'retryCount': 0},
        'n1': {'nodeId': 'n1', 'agentId': 'agent-B', 'status': 'pending', 'retryCount': 0},
    },
}


def _dispatched_bodies(sqs):
    return [json.loads(c.kwargs['MessageBody']) for c in sqs.send_message.call_args_list]


class TestRootDispatchCarriesMergedConfiguration:
    """Dispatch site 1: start_execution → invoke_node for root nodes."""

    def test_root_node_with_configuration_dispatches_merged_dict(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(ROOT_CFG_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(ROOT_CFG_EXEC)}

        executor.start_execution('exec-cfg-root', 'wf-cfg-root')

        bodies = _dispatched_bodies(mock_exec['sqs'])
        assert len(bodies) == 1
        # Node keys win; workflow-only keys preserved; unknown keys carried.
        assert bodies[0]['configuration'] == MERGED_CONFIG

    def test_root_node_without_configuration_dispatches_workflow_config_only(self, mock_exec, monkeypatch):
        """Regression: absent node configuration → byte-identical to today."""
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        wf = copy.deepcopy(ROOT_CFG_WORKFLOW)
        defn = json.loads(wf['definition'])
        del defn['nodes'][0]['configuration']
        wf['definition'] = json.dumps(defn)

        mock_exec['workflows_table'].get_item.return_value = {'Item': wf}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(ROOT_CFG_EXEC)}

        executor.start_execution('exec-cfg-root', 'wf-cfg-root')

        bodies = _dispatched_bodies(mock_exec['sqs'])
        assert len(bodies) == 1
        assert bodies[0]['configuration'] == WF_CONFIG


class TestDagAdvanceCarriesMergedConfiguration:
    """Dispatch site 2: handle_node_completion → invoke_node for ready nodes."""

    def test_ready_node_with_configuration_dispatches_merged_dict(self, mock_exec, monkeypatch):
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        mock_exec['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_CFG_WORKFLOW)}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(CHAIN_CFG_EXEC)}

        executor.handle_node_completion('exec-cfg-chain', 'n0', {'result': 'done'})

        bodies = _dispatched_bodies(mock_exec['sqs'])
        assert len(bodies) == 1
        assert bodies[0]['node_id'] == 'n1'
        assert bodies[0]['configuration'] == MERGED_CONFIG

    def test_ready_node_without_configuration_dispatches_workflow_config_only(self, mock_exec, monkeypatch):
        """Regression: absent node configuration → byte-identical to today."""
        import executor

        monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.fake/worker-queue')
        # TWO_NODE_WORKFLOW carries an empty workflow config — pin a non-empty
        # one so this asserts pass-through rather than empty == empty.
        wf = copy.deepcopy(TWO_NODE_WORKFLOW)
        wf['configuration'] = json.dumps(WF_CONFIG)
        mock_exec['workflows_table'].get_item.return_value = {'Item': wf}
        mock_exec['executions_table'].get_item.return_value = {'Item': copy.deepcopy(TWO_NODE_EXEC)}

        executor.handle_node_completion('exec-chain', 'n0', {'result': 'done'})

        bodies = _dispatched_bodies(mock_exec['sqs'])
        assert len(bodies) == 1
        assert bodies[0]['node_id'] == 'n1'
        assert bodies[0]['configuration'] == WF_CONFIG
