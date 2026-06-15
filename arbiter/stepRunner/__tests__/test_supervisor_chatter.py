"""US-ARB-016 tests for supervisor.chatter correlation events.

Instrumentation in ``stepRunner.invoke_node`` must emit a
``supervisor.chatter`` EventBridge event per node invocation so the
supervisor can correlate its governance findings with the stepRunner
node that triggered them.

Event envelope contract:

- EventBridge ``Source`` stays ``citadel.workflows`` (existing convention).
- EventBridge ``DetailType`` is the literal ``supervisor.chatter``.
- ``detail.source`` is the string ``stepRunner.invoke_node`` (correlation
  hint inside the detail JSON — distinct from the EventBridge Source
  field).
- ``detail`` contains ``correlationId`` (uuid4 str), ``executionId``,
  ``workflowId``, ``nodeId``, and an ISO-8601 timezone-aware
  ``timestamp``.

Emit failures must never break the workflow — ``publish_supervisor_chatter``
is telemetry-only, fire-and-forget.
"""
import json
import logging
import os
import re
import sys
import uuid
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from events import (  # noqa: E402
    STEP_RUNNER_INVOKE_NODE_SOURCE,
    SUPERVISOR_CHATTER_DETAIL_TYPE,
    publish_supervisor_chatter,
)


UUID4_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_eb_client():
    """Mock the EventBridge boto3 client used by events module."""
    with patch('events.eb_client') as mock_client:
        mock_client.put_events = MagicMock(return_value={'FailedEntryCount': 0})
        yield mock_client


def _entry_from_call(mock_eb_client) -> dict:
    """Extract the single Entries[0] dict from a put_events call."""
    call_args = mock_eb_client.put_events.call_args
    entries = call_args.kwargs.get('Entries') or call_args.args[0]
    assert len(entries) == 1, f'expected exactly one entry, got {entries!r}'
    return entries[0]


# ---------------------------------------------------------------------------
# Case 8: Constant exports
# ---------------------------------------------------------------------------

class TestConstantExports:
    """Constants must match the documented contract exactly."""

    def test_supervisor_chatter_detail_type_constant(self):
        assert SUPERVISOR_CHATTER_DETAIL_TYPE == 'supervisor.chatter'

    def test_step_runner_invoke_node_source_constant(self):
        assert STEP_RUNNER_INVOKE_NODE_SOURCE == 'stepRunner.invoke_node'


# ---------------------------------------------------------------------------
# Case 1: publish_supervisor_chatter emits with correct detail-type + source
# ---------------------------------------------------------------------------

class TestEmitContract:
    """publish_supervisor_chatter emits one event with correct envelope."""

    def test_emits_with_correct_detail_type_and_eventbridge_source(self, mock_eb_client):
        publish_supervisor_chatter(
            execution_id='exec-001',
            workflow_id='wf-001',
            node_id='node-a',
        )

        mock_eb_client.put_events.assert_called_once()
        entry = _entry_from_call(mock_eb_client)

        # EventBridge Source field stays 'citadel.workflows' per events.py convention.
        assert entry['Source'] == 'citadel.workflows'
        # DetailType is the literal 'supervisor.chatter'.
        assert entry['DetailType'] == 'supervisor.chatter'

    def test_detail_source_string_is_step_runner_invoke_node(self, mock_eb_client):
        publish_supervisor_chatter(
            execution_id='exec-001',
            workflow_id='wf-001',
            node_id='node-a',
        )
        entry = _entry_from_call(mock_eb_client)
        detail = json.loads(entry['Detail'])

        # detail.source is the correlation hint inside the JSON blob.
        assert detail['source'] == 'stepRunner.invoke_node'


# ---------------------------------------------------------------------------
# Case 2: Returns a valid UUID4 when no correlation_id provided
# ---------------------------------------------------------------------------

class TestGeneratedCorrelationId:
    """Auto-generated correlationIds must be valid UUID4 strings."""

    def test_returns_uuid4_string_when_not_provided(self, mock_eb_client):
        cid = publish_supervisor_chatter(
            execution_id='exec-001',
            workflow_id='wf-001',
            node_id='node-a',
        )
        assert isinstance(cid, str)
        assert UUID4_RE.match(cid), f'{cid!r} is not a UUID4 string'
        # Round-trip through uuid module to be defensive.
        parsed = uuid.UUID(cid)
        assert parsed.version == 4

    def test_generated_cids_are_unique_per_call(self, mock_eb_client):
        cids = {
            publish_supervisor_chatter('e', 'w', 'n')
            for _ in range(20)
        }
        assert len(cids) == 20

    def test_generated_cid_matches_detail_payload(self, mock_eb_client):
        cid = publish_supervisor_chatter('e', 'w', 'n')
        entry = _entry_from_call(mock_eb_client)
        detail = json.loads(entry['Detail'])
        assert detail['correlationId'] == cid


# ---------------------------------------------------------------------------
# Case 3: Caller-provided correlation_id is used verbatim
# ---------------------------------------------------------------------------

class TestCallerProvidedCorrelationId:
    """When the caller provides a correlation_id, it must be used verbatim."""

    def test_uses_caller_provided_cid_verbatim(self, mock_eb_client):
        provided = 'caller-cid-123'
        returned = publish_supervisor_chatter(
            execution_id='e',
            workflow_id='w',
            node_id='n',
            correlation_id=provided,
        )
        assert returned == provided

        entry = _entry_from_call(mock_eb_client)
        detail = json.loads(entry['Detail'])
        assert detail['correlationId'] == provided


# ---------------------------------------------------------------------------
# Case 4: Detail contains all six required fields
# ---------------------------------------------------------------------------

class TestDetailFields:
    """Detail payload must contain every documented field."""

    def test_detail_has_all_six_fields(self, mock_eb_client):
        publish_supervisor_chatter(
            execution_id='exec-abc',
            workflow_id='wf-xyz',
            node_id='node-42',
        )
        entry = _entry_from_call(mock_eb_client)
        detail = json.loads(entry['Detail'])

        required = {
            'correlationId',
            'source',
            'executionId',
            'workflowId',
            'nodeId',
            'timestamp',
        }
        assert required.issubset(detail.keys()), (
            f'missing fields: {required - set(detail.keys())}'
        )
        assert detail['executionId'] == 'exec-abc'
        assert detail['workflowId'] == 'wf-xyz'
        assert detail['nodeId'] == 'node-42'


# ---------------------------------------------------------------------------
# Case 5: Timestamp is a timezone-aware ISO-8601 string
# ---------------------------------------------------------------------------

class TestTimestamp:
    """Timestamp must be timezone-aware ISO-8601."""

    def test_timestamp_is_timezone_aware_iso8601(self, mock_eb_client):
        publish_supervisor_chatter('e', 'w', 'n')
        entry = _entry_from_call(mock_eb_client)
        detail = json.loads(entry['Detail'])

        ts = detail['timestamp']
        assert isinstance(ts, str)
        # UTC indicator: +00:00 or trailing Z.
        assert ts.endswith('+00:00') or ts.endswith('Z'), (
            f'{ts!r} is not UTC-tagged ISO-8601'
        )


# ---------------------------------------------------------------------------
# Case 6: publish_event failure is swallowed with a warning log
# ---------------------------------------------------------------------------

class TestPublishFailureIsSwallowed:
    """Telemetry path must never propagate exceptions to the workflow."""

    def test_returns_cid_and_logs_warning_when_publish_raises(self, caplog):
        with patch('events.publish_event', side_effect=RuntimeError('EB down')):
            with caplog.at_level(logging.WARNING, logger='events'):
                cid = publish_supervisor_chatter(
                    execution_id='exec-1',
                    workflow_id='wf-1',
                    node_id='node-1',
                )

        assert UUID4_RE.match(cid), 'cid should still be returned on failure'
        # At least one warning should mention the failure context.
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert warnings, 'expected a warning log on publish failure'
        combined = ' '.join(r.getMessage() for r in warnings)
        assert 'exec-1' in combined
        assert 'node-1' in combined

    def test_caller_cid_preserved_when_publish_raises(self):
        with patch('events.publish_event', side_effect=RuntimeError('EB down')):
            cid = publish_supervisor_chatter(
                'e', 'w', 'n', correlation_id='pinned-cid',
            )
        assert cid == 'pinned-cid'


# ---------------------------------------------------------------------------
# Case 7: Property test — round-trip detail field values
# ---------------------------------------------------------------------------

_id_text = st.text(
    alphabet=st.characters(
        min_codepoint=0x20,
        max_codepoint=0x7E,
        blacklist_characters='"\\',
    ),
    min_size=1,
    max_size=64,
)


class TestPropertyRoundTrip:
    """Random (execution_id, workflow_id, node_id) must round-trip verbatim."""

    @settings(max_examples=100, deadline=None)
    @given(
        execution_id=_id_text,
        workflow_id=_id_text,
        node_id=_id_text,
    )
    def test_detail_values_round_trip(self, execution_id, workflow_id, node_id):
        with patch('events.eb_client') as mock_client:
            mock_client.put_events = MagicMock(return_value={'FailedEntryCount': 0})
            cid = publish_supervisor_chatter(execution_id, workflow_id, node_id)

            mock_client.put_events.assert_called_once()
            entries = mock_client.put_events.call_args.kwargs.get('Entries') \
                or mock_client.put_events.call_args.args[0]
            detail = json.loads(entries[0]['Detail'])

        assert detail['executionId'] == execution_id
        assert detail['workflowId'] == workflow_id
        assert detail['nodeId'] == node_id
        assert detail['correlationId'] == cid
        assert detail['source'] == 'stepRunner.invoke_node'
        assert entries[0]['DetailType'] == 'supervisor.chatter'
        assert entries[0]['Source'] == 'citadel.workflows'


# ---------------------------------------------------------------------------
# Integration test: executor.invoke_node emits a chatter event
# ---------------------------------------------------------------------------

class TestInvokeNodeEmitsChatter:
    """invoke_node must call publish_supervisor_chatter on every invocation."""

    def test_invoke_node_emits_supervisor_chatter(self):
        import executor  # noqa: WPS433 (local import: avoids boto eager init)

        node = {'id': 'node-integration-1', 'agentId': 'agent-1'}

        with patch('executor.events') as mock_events, \
                patch.object(executor, '_executions_table') as mock_table, \
                patch.object(executor, '_now_iso', return_value='2025-01-01T00:00:00+00:00'):
            mock_events.publish_supervisor_chatter = MagicMock(
                return_value='cid-from-helper',
            )
            mock_table.update_item = MagicMock(return_value={})

            executor.invoke_node(
                execution_id='exec-int-1',
                workflow_id='wf-int-1',
                node=node,
                input_data={'foo': 'bar'},
                configuration={},
            )

            mock_events.publish_supervisor_chatter.assert_called_once_with(
                execution_id='exec-int-1',
                workflow_id='wf-int-1',
                node_id='node-integration-1',
            )

    def test_invoke_node_uses_unknown_when_node_id_missing(self):
        import executor  # noqa: WPS433

        node = {'agentId': 'agent-1'}  # intentionally no 'id'

        with patch('executor.events') as mock_events, \
                patch.object(executor, '_executions_table') as mock_table, \
                patch.object(executor, '_now_iso', return_value='2025-01-01T00:00:00+00:00'):
            mock_events.publish_supervisor_chatter = MagicMock(return_value='cid-x')
            mock_table.update_item = MagicMock(return_value={})

            # invoke_node must not crash on missing id; if it does today,
            # this test will flag the behaviour change required by US-ARB-016.
            try:
                executor.invoke_node(
                    execution_id='exec-int-2',
                    workflow_id='wf-int-2',
                    node=node,
                    input_data={},
                    configuration={},
                )
            except KeyError:
                # Existing implementation uses node['id'] elsewhere; the
                # chatter call must still fire before that failure.
                pass

            # The chatter helper must have been called with 'unknown'
            # because the US-ARB-016 instrumentation sits at the top of
            # invoke_node and uses .get('id', 'unknown').
            mock_events.publish_supervisor_chatter.assert_called_once_with(
                execution_id='exec-int-2',
                workflow_id='wf-int-2',
                node_id='unknown',
            )
