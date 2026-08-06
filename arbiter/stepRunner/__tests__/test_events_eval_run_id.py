"""Tests for evalRunId threading through stepRunner/events.py publish
helpers (CIT-102 Pass B) — additive, optional, omitted-when-absent,
mirroring the run_id precedent in test_events_run_id.py.
"""
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture
def mock_eb_client():
    with patch('events.eb_client') as mock_client:
        mock_client.put_events = MagicMock(return_value={'FailedEntryCount': 0})
        yield mock_client


def _entries(mock_eb_client):
    call_args = mock_eb_client.put_events.call_args
    return call_args[1].get('Entries') or call_args.kwargs.get('Entries')


class TestPublishEventEvalRunId:
    def test_eval_run_id_merged_into_detail_when_passed(self, mock_eb_client):
        import events

        events.publish_event(
            'workflow.completed', {'executionId': 'e1', 'correlationId': 'e1'},
            eval_run_id='eval-run-abc',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['evalRunId'] == 'eval-run-abc'

    def test_eval_run_id_omitted_when_absent(self, mock_eb_client):
        import events

        events.publish_event('workflow.completed', {'executionId': 'e1', 'correlationId': 'e1'})
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'evalRunId' not in detail

    def test_eval_run_id_omitted_when_none(self, mock_eb_client):
        import events

        events.publish_event(
            'workflow.completed', {'executionId': 'e1', 'correlationId': 'e1'}, eval_run_id=None,
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'evalRunId' not in detail

    def test_eval_run_id_and_run_id_independent(self, mock_eb_client):
        """Both stamps present simultaneously — no cross-contamination."""
        import events

        events.publish_event(
            'workflow.completed', {'executionId': 'e1', 'correlationId': 'e1'},
            run_id='run-1', eval_run_id='eval-run-1',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-1'
        assert detail['evalRunId'] == 'eval-run-1'


class TestWorkflowCompletionHelpersEvalRunId:
    """workflow.completed / workflow.failed: eval_run_id threaded through,
    byte-identical when absent (the additive-contract guarantee)."""

    def test_publish_workflow_completed_includes_eval_run_id(self, mock_eb_client):
        import events

        events.publish_workflow_completed(
            'e1', 'w1', '2025-01-01T00:00:00Z', {}, eval_run_id='eval-run-9',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['evalRunId'] == 'eval-run-9'

    def test_publish_workflow_completed_omits_eval_run_id_when_absent(self, mock_eb_client):
        import events

        events.publish_workflow_completed('e1', 'w1', '2025-01-01T00:00:00Z', {})
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'evalRunId' not in detail
        # Byte-identical exact-keys check (pre-CIT-102 shape).
        assert set(detail.keys()) == {
            'executionId', 'workflowId', 'completedAt', 'output', 'correlationId', 'timestamp',
        }

    def test_publish_workflow_failed_includes_eval_run_id(self, mock_eb_client):
        import events

        events.publish_workflow_failed(
            'e1', 'w1', 'n1', 'boom', '2025-01-01T00:00:00Z', eval_run_id='eval-run-10',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['evalRunId'] == 'eval-run-10'

    def test_publish_workflow_failed_omits_eval_run_id_when_absent(self, mock_eb_client):
        import events

        events.publish_workflow_failed('e1', 'w1', 'n1', 'boom', '2025-01-01T00:00:00Z')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'evalRunId' not in detail
        assert set(detail.keys()) == {
            'executionId', 'workflowId', 'failedNodeId', 'error', 'failedAt',
            'correlationId', 'timestamp',
        }
