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
        import events

        events.publish_workflow_started(
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
        import events

        events.publish_node_completed(
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
        # Additive: usage omitted by this call — no 'usage' key present,
        # byte-identical to the pre-rollup-feature detail shape.
        assert 'usage' not in detail

    def test_publish_node_completed_with_usage_adds_top_level_usage_key(self, mock_eb_client):
        """Usage rollup hop (additive): passing usage=[...] adds a top-level
        'usage' key to the detail, mirroring the worker's producer shape."""
        import events

        usage = [{'inputTokens': 3, 'outputTokens': 4}]
        events.publish_node_completed(
            execution_id='exec-003',
            workflow_id='wf-003',
            node_id='node-B',
            agent_id='agent-2',
            completed_at='2025-01-01T00:06:00Z',
            output={'result': 'success'},
            usage=usage,
        )

        call_args = mock_eb_client.put_events.call_args
        entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')
        detail = json.loads(entries[0]['Detail'])
        assert detail['usage'] == usage


# ---------------------------------------------------------------------------
# Test: All events include timestamp and correlationId (Task 10.1)
# ---------------------------------------------------------------------------

class TestAllEventsIncludeTimestampAndCorrelationId:
    """
    **Validates: Requirements 12.8**

    Every event published by the events module includes timestamp and correlationId.
    """

    def test_all_events_include_timestamp_and_correlation_id(self, mock_eb_client):
        import events

        calls = [
            lambda: events.publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z'),
            lambda: events.publish_node_started('e2', 'w2', 'n1', 'ag1', '2025-01-01T00:00:00Z'),
            lambda: events.publish_node_completed('e3', 'w3', 'n2', 'ag2', '2025-01-01T00:01:00Z', {}),
            lambda: events.publish_node_failed('e4', 'w4', 'n3', 'ag3', 'some error', 0),
            lambda: events.publish_node_retrying('e5', 'w5', 'n4', 'ag4', 1, 2.0),
            lambda: events.publish_workflow_completed('e6', 'w6', '2025-01-01T00:10:00Z', {}),
            lambda: events.publish_workflow_failed('e7', 'w7', 'n5', 'some failure', '2025-01-01T00:10:00Z'),
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


# ---------------------------------------------------------------------------
# Trace-context propagation (architect task f4f4bab3-7a07-4acf-ba43-
# ba43bb488444): publish_event merges an additive `traceContext` into the
# detail when common.tracing.active_trace_context() returns one, and is
# byte-identical to pre-feature callers when it returns None (as it always
# does under pytest with no active X-Ray segment — R14 property).
# ---------------------------------------------------------------------------

class TestPublishEventTraceContextPropagation:
    def test_publish_event_omits_trace_context_key_with_no_active_segment(self, mock_eb_client):
        """R14: no active segment under pytest -> detail has no traceContext
        key at all, byte-identical to the pre-feature shape."""
        import events

        events.publish_event('workflow.started', {'executionId': 'e1', 'correlationId': 'e1'})

        call_args = mock_eb_client.put_events.call_args
        entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')
        detail = json.loads(entries[0]['Detail'])
        assert 'traceContext' not in detail

    def test_publish_event_merges_trace_context_when_active_segment_present(self, mock_eb_client):
        """R13/R14 counterpart: when common.tracing reports an active trace
        context, publish_event merges it into the detail additively."""
        import events

        fake_ctx = {
            'xrayTraceHeader': 'Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1',
            'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb',
            'parentId': 'cccccccccccccccc',
        }
        with patch('common.tracing.active_trace_context', return_value=fake_ctx):
            events.publish_event('workflow.started', {'executionId': 'e2', 'correlationId': 'e2'})

        call_args = mock_eb_client.put_events.call_args
        entries = call_args[1].get('Entries') or call_args.kwargs.get('Entries')
        detail = json.loads(entries[0]['Detail'])
        assert detail['traceContext'] == fake_ctx
