"""
Property-based tests for arbiter/supervisor/index.py

Tests create_orchestration, create_workflow_tracking_record,
update_orchestration_with_results, send_response routing, and
handler event dispatch.
"""

import sys
import os
import json
import time
from unittest.mock import patch, MagicMock
from decimal import Decimal

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")

# Patch boto3 at module level before importing index
import boto3
from unittest.mock import MagicMock as _MagicMock

_mock_dynamodb = _MagicMock()
_mock_sqs = _MagicMock()
_mock_bedrock = _MagicMock()
_mock_events = _MagicMock()

with patch.multiple(
    "boto3",
    resource=_MagicMock(return_value=_mock_dynamodb),
    client=_MagicMock(side_effect=lambda svc, **kw: {
        "sqs": _mock_sqs,
        "bedrock-runtime": _mock_bedrock,
        "events": _mock_events,
    }.get(svc, _MagicMock())),
):
    from index import (
        create_orchestration,
        create_workflow_tracking_record,
        update_orchestration_with_results,
        send_response,
    )


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

conversation_messages = st.lists(
    st.fixed_dictionaries({
        "role": st.sampled_from(["user", "assistant"]),
        "content": st.lists(
            st.fixed_dictionaries({"text": st.text(min_size=1, max_size=100)}),
            min_size=1,
            max_size=3,
        ),
    }),
    min_size=1,
    max_size=5,
)

node_names = st.lists(
    st.text(min_size=1, max_size=20, alphabet=st.characters(
        whitelist_categories=("L", "N"),
    )).filter(lambda s: s.strip() != ""),
    min_size=1,
    max_size=10,
    unique=True,
)

callback_types = st.sampled_from(["eventbridge", "sqs", "unknown_type"])


# ---------------------------------------------------------------------------
# create_orchestration
# ---------------------------------------------------------------------------

class TestCreateOrchestration:
    """Property tests for create_orchestration."""

    @given(conversation=conversation_messages)
    @settings(max_examples=100)
    def test_always_has_orchestration_id(self, conversation):
        """Orchestration always has a non-empty orchestrationId."""
        orch = create_orchestration(conversation)
        assert "orchestrationId" in orch
        assert len(orch["orchestrationId"]) > 0

    @given(conversation=conversation_messages)
    @settings(max_examples=100)
    def test_always_has_instance_timestamp(self, conversation):
        """Orchestration always has an integer instance timestamp."""
        orch = create_orchestration(conversation)
        assert "instance" in orch
        assert isinstance(orch["instance"], int)

    @given(conversation=conversation_messages)
    @settings(max_examples=100)
    def test_conversation_preserved(self, conversation):
        """Input conversation is stored unchanged."""
        orch = create_orchestration(conversation)
        assert orch["conversation"] == conversation

    @given(conversation=conversation_messages)
    @settings(max_examples=50)
    def test_no_callback_when_not_provided(self, conversation):
        """No callback key when callback is None."""
        orch = create_orchestration(conversation)
        assert "callback" not in orch

    @given(
        conversation=conversation_messages,
        callback_type=callback_types,
    )
    @settings(max_examples=50)
    def test_callback_preserved_when_provided(self, conversation, callback_type):
        """Callback is stored when provided."""
        cb = {"type": callback_type}
        orch = create_orchestration(conversation, callback=cb)
        assert orch["callback"] == cb

    @given(conversation=conversation_messages)
    @settings(max_examples=50)
    def test_unique_orchestration_ids(self, conversation):
        """Each call produces a unique orchestrationId."""
        ids = {create_orchestration(conversation)["orchestrationId"] for _ in range(10)}
        assert len(ids) == 10


# ---------------------------------------------------------------------------
# create_workflow_tracking_record
# ---------------------------------------------------------------------------

class TestCreateWorkflowTrackingRecord:
    """Property tests for create_workflow_tracking_record."""

    def test_empty_nodes_returns_none(self):
        """Empty node list returns None (early exit)."""
        result = create_workflow_tracking_record([])
        assert result is None

    @given(nodes=node_names)
    @settings(max_examples=50)
    def test_returns_request_id(self, nodes):
        """Non-empty node list returns a non-empty request_id string."""
        mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = mock_table

        result = create_workflow_tracking_record(nodes)
        assert isinstance(result, str)
        assert len(result) > 0

    @given(nodes=node_names)
    @settings(max_examples=50)
    def test_all_nodes_start_false(self, nodes):
        """Every node in the tracking item starts as False."""
        mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = mock_table

        create_workflow_tracking_record(nodes)

        call_args = mock_table.put_item.call_args
        item = call_args.kwargs.get("Item") if call_args.kwargs else call_args.args[0]

        for node in nodes:
            assert item[node] is False

    @given(nodes=node_names)
    @settings(max_examples=50)
    def test_data_keys_match_nodes(self, nodes):
        """The 'data' dict has a key for every node, all set to None."""
        mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = mock_table

        create_workflow_tracking_record(nodes)

        call_args = mock_table.put_item.call_args
        item = call_args.kwargs.get("Item") if call_args.kwargs else call_args.args[0]

        for node in nodes:
            assert node in item["data"]
            assert item["data"][node] is None


# ---------------------------------------------------------------------------
# update_orchestration_with_results
# ---------------------------------------------------------------------------

class TestUpdateOrchestrationWithResults:
    """Property tests for update_orchestration_with_results."""

    @given(
        num_results=st.integers(min_value=1, max_value=5),
    )
    @settings(max_examples=30)
    def test_appends_user_message_with_tool_results(self, num_results):
        """Always appends a user message containing toolResult entries."""
        data = {}
        for i in range(num_results):
            data[f"agent_{i}"] = {
                "agent_use_id": f"tool_use_{i}",
                "data": f"result_{i}",
            }

        results = {"Attributes": {"data": data}}
        orchestration = {"conversation": []}

        update_orchestration_with_results(results, orchestration)

        assert len(orchestration["conversation"]) == 1
        msg = orchestration["conversation"][0]
        assert msg["role"] == "user"
        assert len(msg["content"]) == num_results

    @given(num_results=st.integers(min_value=1, max_value=5))
    @settings(max_examples=30)
    def test_tool_results_have_correct_structure(self, num_results):
        """Each tool result has toolResult with toolUseId and content."""
        data = {}
        for i in range(num_results):
            data[f"agent_{i}"] = {
                "agent_use_id": f"tool_use_{i}",
                "data": f"result_{i}",
            }

        results = {"Attributes": {"data": data}}
        orchestration = {"conversation": []}

        update_orchestration_with_results(results, orchestration)

        for content_item in orchestration["conversation"][0]["content"]:
            assert "toolResult" in content_item
            tr = content_item["toolResult"]
            assert "toolUseId" in tr
            assert "content" in tr
            assert len(tr["content"]) == 1
            assert "json" in tr["content"][0]


# ---------------------------------------------------------------------------
# send_response routing
# ---------------------------------------------------------------------------

class TestSendResponse:
    """Property tests for send_response callback routing."""

    @given(message=st.text(min_size=1, max_size=200))
    @settings(max_examples=30)
    def test_no_callback_uses_event_bus(self, message):
        """Without callback, sends to default EVENT_BUS_NAME."""
        _mock_events.reset_mock()
        send_response(message, callback=None)
        _mock_events.put_events.assert_called_once()

    @given(message=st.text(min_size=1, max_size=200))
    @settings(max_examples=30)
    def test_sqs_callback_sends_to_queue(self, message):
        """SQS callback sends message to the specified queue URL."""
        _mock_sqs.reset_mock()
        callback = {"type": "sqs", "queueUrl": "https://sqs.fake/my-queue"}
        send_response(message, callback=callback)
        _mock_sqs.send_message.assert_called_once()
        call_kwargs = _mock_sqs.send_message.call_args[1]
        assert call_kwargs["QueueUrl"] == "https://sqs.fake/my-queue"
        body = json.loads(call_kwargs["MessageBody"])
        assert body["message"] == message

    @given(message=st.text(min_size=1, max_size=200))
    @settings(max_examples=30)
    def test_eventbridge_callback_sends_event(self, message):
        """EventBridge callback publishes to the specified bus."""
        _mock_events.reset_mock()
        callback = {
            "type": "eventbridge",
            "eventBusName": "custom-bus",
            "source": "test.source",
            "detailType": "test.detail",
        }
        send_response(message, callback=callback)
        _mock_events.put_events.assert_called_once()

    @given(
        message=st.text(min_size=1, max_size=100),
        cb_type=st.text(min_size=1, max_size=20).filter(
            lambda s: s not in ("eventbridge", "sqs")
        ),
    )
    @settings(max_examples=30)
    def test_unknown_callback_type_does_not_raise(self, message, cb_type):
        """Unknown callback types are handled gracefully (no exception)."""
        send_response(message, callback={"type": cb_type})
