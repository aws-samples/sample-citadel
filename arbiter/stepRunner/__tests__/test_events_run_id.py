"""Tests for run_id threading through stepRunner/events.py publish helpers
(Pass 1, decision f1cbd5ef) — additive, optional, omitted-when-absent,
mirroring the traceContext/usage precedent in test_events_properties.py.
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


class TestPublishEventRunId:
    def test_run_id_merged_into_detail_when_passed(self, mock_eb_client):
        import events

        events.publish_event('workflow.started', {'executionId': 'e1', 'correlationId': 'e1'}, run_id='run-abc')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-abc'

    def test_run_id_omitted_when_absent(self, mock_eb_client):
        import events

        events.publish_event('workflow.started', {'executionId': 'e1', 'correlationId': 'e1'})
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'runId' not in detail

    def test_run_id_omitted_when_none(self, mock_eb_client):
        import events

        events.publish_event('workflow.started', {'executionId': 'e1', 'correlationId': 'e1'}, run_id=None)
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'runId' not in detail


class TestWorkflowLifecycleHelpersRunId:
    """workflow.* + supervisor.chatter: run_id threaded through, byte-identical when absent."""

    def test_publish_workflow_started_includes_run_id(self, mock_eb_client):
        import events

        events.publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z', run_id='run-1')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-1'

    def test_publish_workflow_started_omits_run_id_when_absent(self, mock_eb_client):
        import events

        events.publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'runId' not in detail
        # Byte-identical exact-keys check (pre-runId shape).
        assert set(detail.keys()) == {
            'executionId', 'workflowId', 'appId', 'startedAt', 'correlationId', 'timestamp',
        }

    def test_publish_node_started_includes_run_id(self, mock_eb_client):
        import events

        events.publish_node_started('e2', 'w2', 'n1', 'ag1', '2025-01-01T00:00:00Z', run_id='run-2')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-2'

    def test_publish_node_completed_includes_run_id(self, mock_eb_client):
        import events

        events.publish_node_completed(
            'e3', 'w3', 'n2', 'ag2', '2025-01-01T00:01:00Z', {}, run_id='run-3',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-3'

    def test_publish_node_completed_omits_run_id_when_absent(self, mock_eb_client):
        import events

        events.publish_node_completed('e3', 'w3', 'n2', 'ag2', '2025-01-01T00:01:00Z', {})
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'runId' not in detail

    def test_publish_node_failed_includes_run_id(self, mock_eb_client):
        import events

        events.publish_node_failed('e4', 'w4', 'n3', 'ag3', 'boom', 0, run_id='run-4')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-4'

    def test_publish_node_retrying_includes_run_id(self, mock_eb_client):
        import events

        events.publish_node_retrying('e5', 'w5', 'n4', 'ag4', 1, 2.0, run_id='run-5')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-5'

    def test_publish_workflow_completed_includes_run_id(self, mock_eb_client):
        import events

        events.publish_workflow_completed('e6', 'w6', '2025-01-01T00:10:00Z', {}, run_id='run-6')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-6'

    def test_publish_workflow_failed_includes_run_id(self, mock_eb_client):
        import events

        events.publish_workflow_failed('e7', 'w7', 'n5', 'boom', '2025-01-01T00:10:00Z', run_id='run-7')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-7'

    def test_publish_supervisor_chatter_includes_run_id(self, mock_eb_client):
        import events

        events.publish_supervisor_chatter('e8', 'w8', 'n6', run_id='run-8')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['runId'] == 'run-8'

    def test_publish_supervisor_chatter_omits_run_id_when_absent(self, mock_eb_client):
        import events

        events.publish_supervisor_chatter('e9', 'w9', 'n7')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'runId' not in detail
