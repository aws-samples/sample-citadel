"""Tests for run_id threading through stepRunner/executor.py (Pass 1,
decision f1cbd5ef) — the execution row's ``runId`` (written by
execution-resolver.ts / app-invoke-handler.ts) must reach the SQS
node-dispatch message unchanged, and be absent when the execution row
carries no runId (pre-runId execution).
"""
import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import patch, MagicMock

SAMPLE_WORKFLOW = {
    'workflowId': 'wf-001',
    'orgId': 'org-001',
    'name': 'Test Workflow',
    'status': 'PUBLISHED',
    'definition': json.dumps({
        'nodes': [
            {'id': 'n0', 'type': 'agent', 'agentId': 'agent-A', 'data': {'label': 'Node A'}},
        ],
        'edges': [],
    }),
    'configuration': json.dumps({}),
}

SAMPLE_EXECUTION_WITH_RUN_ID = {
    'executionId': 'exec-001',
    'workflowId': 'wf-001',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'runId': 'run-abc123',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}

SAMPLE_EXECUTION_WITHOUT_RUN_ID = {
    'executionId': 'exec-002',
    'workflowId': 'wf-001',
    'appId': 'app-001',
    'orgId': 'org-001',
    'status': 'pending',
    'nodeResults': {
        'n0': {'nodeId': 'n0', 'agentId': 'agent-A', 'status': 'pending', 'retryCount': 0},
    },
    'startedAt': '2025-01-01T00:00:00Z',
}


import pytest


@pytest.fixture
def mock_executor(monkeypatch):
    import executor

    monkeypatch.setenv('WORKER_QUEUE_URL', 'https://sqs.example.com/queue')

    mock_wf_table = MagicMock()
    mock_exec_table = MagicMock()
    mock_events = MagicMock()
    mock_sqs = MagicMock()

    with patch.object(executor, '_workflows_table', mock_wf_table), \
         patch.object(executor, '_executions_table', mock_exec_table), \
         patch.object(executor, 'events', mock_events), \
         patch.object(executor, '_get_sqs_client', return_value=mock_sqs):
        yield {
            'workflows_table': mock_wf_table,
            'executions_table': mock_exec_table,
            'events': mock_events,
            'sqs': mock_sqs,
        }


class TestStartExecutionThreadsRunId:
    def test_run_id_reaches_sqs_dispatch_message_when_present_on_execution(self, mock_executor):
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITH_RUN_ID),
        }

        start_execution('exec-001', 'wf-001')

        send_call = mock_executor['sqs'].send_message.call_args
        message = json.loads(send_call.kwargs['MessageBody'])
        assert message['runId'] == 'run-abc123'

    def test_run_id_absent_from_dispatch_message_when_execution_has_none(self, mock_executor):
        """Byte-identical to the pre-runId dispatch: an execution row with
        no runId key produces a dispatch message with no runId key."""
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITHOUT_RUN_ID),
        }

        start_execution('exec-002', 'wf-001')

        send_call = mock_executor['sqs'].send_message.call_args
        message = json.loads(send_call.kwargs['MessageBody'])
        assert 'runId' not in message

    def test_workflow_started_event_also_carries_run_id(self, mock_executor):
        from executor import start_execution

        mock_executor['workflows_table'].get_item.return_value = {'Item': copy.deepcopy(SAMPLE_WORKFLOW)}
        mock_executor['executions_table'].get_item.return_value = {
            'Item': copy.deepcopy(SAMPLE_EXECUTION_WITH_RUN_ID),
        }

        start_execution('exec-001', 'wf-001')

        mock_executor['events'].publish_workflow_started.assert_called_once()
        kwargs = mock_executor['events'].publish_workflow_started.call_args.kwargs
        assert kwargs.get('run_id') == 'run-abc123'
