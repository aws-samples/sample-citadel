"""
Tests for stepRunner/events.py — EventBridge publishing helpers.

Tests cover:
- publish_workflow_started event has correct structure
- publish_node_completed event has correct structure
- All events include timestamp and correlationId

**Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8**
"""

import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_eb_client():
    """Mock the EventBridge boto3 client used by events module."""
    with patch('events.eb_client') as mock_client:
        mock_client.put_events = MagicMock(return_value={'FailedEntryCount': 0})
        yield mock_client


# ---------------------------------------------------------------------------
# Test: publish_workflow_started event structure (Task 10.1)
# ---------------------------------------------------------------------------

class TestPublishWorkflowStartedEvent:
    """
    **Validates: Requirements 12.1, 12.2, 12.8**

    publish_workflow_started publishes a workflow.started event with correct fields.
    """

    def test_publish_workflow_started_event_has_correct_structure(self, mock_eb_client):
        from events import publish_workflow_started

        publish_workflow_started(
            execution_id='exec-001',
            workflow_id='wf-001',
            app_id='app-001',
            started_at='2025-01-01T00:00:00Z',
        )

        mock_eb_client.put_events.assert_called_once()
        call_args = mock_eb_client.put_events.call_args
        entries = call_args[1]['Entries'] if 'Entries' in call_args[1] else call_args[0][0] if call_args[0] else call_args[1].get('Entries', [])

        # Handle both keyword and positional args
        if not entries:
            entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')

        assert len(entries) == 1
        entry = entries[0]

        assert entry['Source'] == 'citadel.workflows'
        assert entry['DetailType'] == 'workflow.started'

        detail = json.loads(entry['Detail'])
        assert detail['executionId'] == 'exec-001'
        assert detail['workflowId'] == 'wf-001'
        assert detail['appId'] == 'app-001'
        assert detail['startedAt'] == '2025-01-01T00:00:00Z'
        assert detail['correlationId'] == 'exec-001'
        assert 'timestamp' in detail


# ---------------------------------------------------------------------------
# Test: publish_node_completed event structure (Task 10.1)
# ---------------------------------------------------------------------------

class TestPublishNodeCompletedEvent:
    """
    **Validates: Requirements 12.1, 12.4, 12.8**

    publish_node_completed publishes a workflow.node.completed event with correct fields.
    """

    def test_publish_workflow_node_completed_event_has_correct_structure(self, mock_eb_client):
        from events import publish_node_completed

        publish_node_completed(
            execution_id='exec-002',
            workflow_id='wf-002',
            node_id='node-A',
            agent_id='agent-1',
            completed_at='2025-01-01T00:05:00Z',
            output={'result': 'success'},
        )

        mock_eb_client.put_events.assert_called_once()
        call_args = mock_eb_client.put_events.call_args
        entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')

        assert len(entries) == 1
        entry = entries[0]

        assert entry['Source'] == 'citadel.workflows'
        assert entry['DetailType'] == 'workflow.node.completed'

        detail = json.loads(entry['Detail'])
        assert detail['executionId'] == 'exec-002'
        assert detail['workflowId'] == 'wf-002'
        assert detail['nodeId'] == 'node-A'
        assert detail['agentId'] == 'agent-1'
        assert detail['completedAt'] == '2025-01-01T00:05:00Z'
        assert detail['output'] == {'result': 'success'}
        assert detail['correlationId'] == 'exec-002'
        assert 'timestamp' in detail


# ---------------------------------------------------------------------------
# Test: All events include timestamp and correlationId (Task 10.1)
# ---------------------------------------------------------------------------

class TestAllEventsIncludeTimestampAndCorrelationId:
    """
    **Validates: Requirements 12.8**

    Every event published by the events module includes timestamp and correlationId.
    """

    def test_all_events_include_timestamp_and_correlation_id(self, mock_eb_client):
        from events import (
            publish_workflow_started,
            publish_node_started,
            publish_node_completed,
            publish_node_failed,
            publish_node_retrying,
            publish_workflow_completed,
            publish_workflow_failed,
        )

        calls = [
            lambda: publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z'),
            lambda: publish_node_started('e2', 'w2', 'n1', 'ag1', '2025-01-01T00:00:00Z'),
            lambda: publish_node_completed('e3', 'w3', 'n2', 'ag2', '2025-01-01T00:01:00Z', {}),
            lambda: publish_node_failed('e4', 'w4', 'n3', 'ag3', 'some error', 0),
            lambda: publish_node_retrying('e5', 'w5', 'n4', 'ag4', 1, 2.0),
            lambda: publish_workflow_completed('e6', 'w6', '2025-01-01T00:10:00Z', {}),
            lambda: publish_workflow_failed('e7', 'w7', 'n5', 'some failure', '2025-01-01T00:10:00Z'),
        ]

        for i, call_fn in enumerate(calls):
            mock_eb_client.put_events.reset_mock()
            call_fn()

            mock_eb_client.put_events.assert_called_once()
            call_args = mock_eb_client.put_events.call_args
            entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')
            detail = json.loads(entries[0]['Detail'])

            assert 'timestamp' in detail, f"Event {i} missing timestamp"
            assert 'correlationId' in detail, f"Event {i} missing correlationId"
