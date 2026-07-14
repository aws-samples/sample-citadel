"""
Correlation-logging tests for the worker's workflow-node path.

The worker's ``_process_workflow_node`` must emit structured JSON log lines
that carry ``executionId``, ``nodeId`` and ``workflowId`` on both the success
and failure paths, so a log search can stitch a node's worker-side execution
to the step runner's coordinator-side view of the same execution.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
"""

import json
import sys

from unittest.mock import patch, MagicMock


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
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _json_logs(capsys):
    logs = []
    for line in capsys.readouterr().out.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                logs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return logs


def _has_correlation(logs):
    return [
        log for log in logs
        if log.get('executionId') == 'exec-1'
        and log.get('nodeId') == 'n0'
        and log.get('workflowId') == 'wf-1'
    ]


class TestWorkerNodeCorrelationLogging:
    def test_success_path_logs_execution_node_workflow_ids(self, capsys):
        mock_result = MagicMock(returncode=0, stdout=json.dumps({'response': 'done'}), stderr='')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        assert _has_correlation(_json_logs(capsys)), \
            "expected a structured log carrying executionId/nodeId/workflowId on success"

    def test_failure_path_logs_execution_node_workflow_ids(self, capsys):
        # Non-zero subprocess exit → node.failed path.
        mock_result = MagicMock(returncode=1, stdout='', stderr='boom')
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        matches = _has_correlation(_json_logs(capsys))
        assert matches, \
            "expected a structured log carrying executionId/nodeId/workflowId on failure"
        # The failure log should reference the error.
        assert any('error' in log for log in matches)
