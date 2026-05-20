"""
Property-based tests for arbiter/seedConfig/index.py

Tests the CloudFormation custom resource handler for seed configuration,
verifying Delete always succeeds and Create seeds correct data structure.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

cfn_events_base = st.fixed_dictionaries({
    "ResponseURL": st.just("https://cfn-response.example.com/callback"),
    "StackId": st.text(min_size=1, max_size=40).map(
        lambda s: f"arn:aws:cloudformation:us-east-1:123456789012:stack/{s}"
    ),
    "RequestId": st.uuids().map(str),
    "LogicalResourceId": st.text(
        min_size=1, max_size=30,
        alphabet=st.characters(whitelist_categories=("L", "N")),
    ),
})

lambda_contexts = st.builds(
    lambda name: type("Ctx", (), {"log_stream_name": name})(),
    st.text(min_size=1, max_size=60),
)


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------

class TestSeedConfigHandler:
    """Property tests for the seedConfig handler."""

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_delete_always_sends_success(self, event, context):
        """Delete requests always respond with SUCCESS."""
        event = {**event, "RequestType": "Delete"}

        with patch("cfnresponse.send") as mock_send:
            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "SUCCESS"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_create_seeds_fabricator_agent(self, event, context):
        """Create requests seed a fabricator agent with correct structure."""
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            # Verify put_item was called
            mock_table.put_item.assert_called_once()
            item = mock_table.put_item.call_args[1]["Item"]

            # Verify fabricator agent structure
            assert item["agentId"] == "fabricator"
            assert item["state"] == "active"
            assert "config" in item
            assert item["config"]["name"] == "fabricator"
            assert "description" in item["config"]
            assert "schema" in item["config"]
            assert "action" in item["config"]
            assert item["config"]["action"]["type"] == "sqs"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_create_schema_is_valid_object_schema(self, event, context):
        """Seeded agent schema is a valid JSON object schema."""
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send"):
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            item = mock_table.put_item.call_args[1]["Item"]
            schema = item["config"]["schema"]

            assert schema["type"] == "object"
            assert "properties" in schema
            assert "required" in schema
            assert isinstance(schema["required"], list)
            assert "taskDetails" in schema["properties"]

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=30)
    def test_create_sends_success_on_completion(self, event, context):
        """Successful Create sends SUCCESS cfnresponse."""
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "SUCCESS"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=30)
    def test_create_failure_sends_failed(self, event, context):
        """DynamoDB errors during Create send FAILED cfnresponse."""
        event = {**event, "RequestType": "Create"}

        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.side_effect = Exception("DDB error")

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "FAILED"

    @given(
        request_type=st.sampled_from(["Create", "Update", "Delete"]),
        event=cfn_events_base,
        context=lambda_contexts,
    )
    @settings(max_examples=30)
    def test_handler_never_raises(self, request_type, event, context):
        """Handler never raises; errors are sent via cfnresponse."""
        event = {**event, "RequestType": request_type}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send"):
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            # Should not raise
            handler(event, context)
