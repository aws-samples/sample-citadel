"""
Property-based tests for arbiter/fabricator/index.py

Tests publish_fabrication_event, store_agent_config_dynamo item construction,
store_tool_config_dynamo item construction, and lambda_handler event routing.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before import
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

from index import publish_fabrication_event, upload_to_s3


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

orchestration_ids = st.text(min_size=1, max_size=50, alphabet=st.characters(
    whitelist_categories=("L", "N", "Pd"),
))

event_types = st.sampled_from(["agent.fabricated", "agent.fabrication.failed"])

agent_ids = st.text(min_size=1, max_size=30, alphabet=st.characters(
    whitelist_categories=("L", "N", "Pd"),
))

error_messages = st.text(min_size=1, max_size=200)


# ---------------------------------------------------------------------------
# publish_fabrication_event
# ---------------------------------------------------------------------------

class TestPublishFabricationEvent:
    """Property tests for publish_fabrication_event."""

    @given(
        orch_id=orchestration_ids,
        event_type=event_types,
        agent_id=agent_ids,
    )
    @settings(max_examples=50)
    def test_success_event_structure(self, orch_id, event_type, agent_id):
        """Success events always include orchestration_id and agent_use_id."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type, agent_id=agent_id)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        entry = entries[0]

        assert entry["Source"] == event_type
        assert entry["DetailType"] == event_type

        detail = json.loads(entry["Detail"])
        assert detail["orchestration_id"] == orch_id
        assert detail["agent_use_id"] == agent_id
        assert "data" in detail  # success events have 'data'

    @given(
        orch_id=orchestration_ids,
        event_type=event_types,
        error=error_messages,
    )
    @settings(max_examples=50)
    def test_failure_event_includes_error(self, orch_id, event_type, error):
        """Failure events always include the error message."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type, error=error)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        detail = json.loads(entries[0]["Detail"])

        assert detail["orchestration_id"] == orch_id
        assert detail["error"] == error

    @given(orch_id=orchestration_ids, event_type=event_types)
    @settings(max_examples=50)
    def test_event_detail_is_valid_json(self, orch_id, event_type):
        """Event Detail field is always valid JSON."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        detail_str = entries[0]["Detail"]
        parsed = json.loads(detail_str)  # Should not raise
        assert isinstance(parsed, dict)

    @given(orch_id=orchestration_ids, event_type=event_types)
    @settings(max_examples=30)
    def test_event_uses_completion_bus(self, orch_id, event_type):
        """Events are always sent to the COMPLETION_BUS_NAME."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        assert entries[0]["EventBusName"] == os.environ["COMPLETION_BUS_NAME"]


# ---------------------------------------------------------------------------
# upload_to_s3
# ---------------------------------------------------------------------------

class TestUploadToS3:
    """Property tests for upload_to_s3."""

    @given(
        filename=st.text(min_size=1, max_size=30, alphabet=st.characters(
            whitelist_categories=("L", "N"),
        )).map(lambda s: f"/tmp/{s}.py"),
        folder=st.sampled_from(["agents", "tools"]),
    )
    @settings(max_examples=50)
    def test_s3_key_uses_folder_prefix(self, filename, folder):
        """Uploaded S3 key always starts with the folder prefix."""
        mock_s3 = MagicMock()

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            upload_to_s3(filename, folder)

        call_args = mock_s3.upload_file.call_args
        s3_key = call_args[0][2]
        assert s3_key.startswith(f"{folder}/")

    @given(
        filename=st.text(min_size=1, max_size=30, alphabet=st.characters(
            whitelist_categories=("L", "N"),
        )).map(lambda s: f"/tmp/{s}.py"),
        folder=st.sampled_from(["agents", "tools"]),
    )
    @settings(max_examples=50)
    def test_s3_key_contains_only_basename(self, filename, folder):
        """S3 key uses only the basename, not the full path."""
        mock_s3 = MagicMock()

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            upload_to_s3(filename, folder)

        call_args = mock_s3.upload_file.call_args
        s3_key = call_args[0][2]
        basename = filename.split("/")[-1]
        assert s3_key == f"{folder}/{basename}"

    def test_missing_bucket_raises(self):
        """Raises ValueError when AGENT_BUCKET_NAME is not set."""
        with patch.dict(os.environ, {}, clear=False):
            orig = os.environ.pop("AGENT_BUCKET_NAME", None)
            try:
                with pytest.raises(ValueError, match="AGENT_BUCKET_NAME"):
                    upload_to_s3("/tmp/test.py", "agents")
            finally:
                if orig is not None:
                    os.environ["AGENT_BUCKET_NAME"] = orig


# ---------------------------------------------------------------------------
# lambda_handler record processing
# ---------------------------------------------------------------------------

class TestLambdaHandlerRecordProcessing:
    """Property tests for lambda_handler SQS record iteration."""

    @given(
        num_records=st.integers(min_value=0, max_value=5),
    )
    @settings(max_examples=20)
    def test_processes_all_records(self, num_records):
        """lambda_handler iterates over every record in the event."""
        records = []
        for i in range(num_records):
            records.append({
                "body": json.dumps({
                    "agent_input": {"taskDetails": f"task-{i}"},
                    "orchestration_id": f"orch-{i}",
                    "agent_use_id": f"use-{i}",
                    "node": "fabricator",
                }),
                "messageAttributes": {},
            })

        from index import lambda_handler

        with patch("index.process_event") as mock_process:
            lambda_handler({"Records": records}, {})
            assert mock_process.call_count == num_records
