"""
Property-based tests for arbiter/workerWrapper/index.py

Tests lambda_handler batch failure reporting, credential isolation in
run_agent_in_subprocess, and post_task_complete event structure.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "")

from index import (
    lambda_handler,
    run_agent_in_subprocess,
    post_task_complete,
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

message_ids = st.uuids().map(str)

sqs_records = st.fixed_dictionaries({
    "messageId": message_ids,
    "body": st.just(json.dumps({
        "orchestration_id": "orch-123",
        "agent_use_id": "use-456",
        "agent_input": {"taskDetails": "test task"},
        "node": "test_agent",
    })),
})


# ---------------------------------------------------------------------------
# lambda_handler batch failure reporting
# ---------------------------------------------------------------------------

class TestLambdaHandlerBatchFailures:
    """Property tests for SQS batch processing and failure reporting."""

    @given(records=st.lists(sqs_records, min_size=0, max_size=10))
    @settings(max_examples=50)
    def test_return_has_batch_item_failures_key(self, records):
        """Return value always has 'batchItemFailures' key."""
        with patch("index.process_event"):
            result = lambda_handler({"Records": records}, {})
        assert "batchItemFailures" in result

    @given(records=st.lists(sqs_records, min_size=0, max_size=10))
    @settings(max_examples=50)
    def test_batch_item_failures_is_list(self, records):
        """batchItemFailures is always a list."""
        with patch("index.process_event"):
            result = lambda_handler({"Records": records}, {})
        assert isinstance(result["batchItemFailures"], list)

    @given(records=st.lists(sqs_records, min_size=1, max_size=10))
    @settings(max_examples=50)
    def test_successful_processing_yields_no_failures(self, records):
        """When all records succeed, batchItemFailures is empty."""
        with patch("index.process_event"):
            result = lambda_handler({"Records": records}, {})
        assert result["batchItemFailures"] == []

    @given(records=st.lists(sqs_records, min_size=1, max_size=10))
    @settings(max_examples=50)
    def test_all_failures_reported(self, records):
        """When all records fail, all message IDs appear in failures."""
        with patch("index.process_event", side_effect=Exception("boom")):
            result = lambda_handler({"Records": records}, {})

        failure_ids = {f["itemIdentifier"] for f in result["batchItemFailures"]}
        record_ids = {r["messageId"] for r in records}
        assert failure_ids == record_ids

    @given(records=st.lists(sqs_records, min_size=2, max_size=10))
    @settings(max_examples=30)
    def test_partial_failures_reported_correctly(self, records):
        """Only failed records appear in batchItemFailures."""
        # Fail on even-indexed records
        call_count = {"n": 0}

        def maybe_fail(*args, **kwargs):
            idx = call_count["n"]
            call_count["n"] += 1
            if idx % 2 == 0:
                raise Exception("fail")

        with patch("index.process_event", side_effect=maybe_fail):
            result = lambda_handler({"Records": records}, {})

        expected_failures = {
            records[i]["messageId"]
            for i in range(len(records))
            if i % 2 == 0
        }
        actual_failures = {
            f["itemIdentifier"] for f in result["batchItemFailures"]
        }
        assert actual_failures == expected_failures

    @given(records=st.lists(sqs_records, min_size=1, max_size=10))
    @settings(max_examples=30)
    def test_failure_entries_have_item_identifier(self, records):
        """Each failure entry has an 'itemIdentifier' key."""
        with patch("index.process_event", side_effect=Exception("boom")):
            result = lambda_handler({"Records": records}, {})

        for failure in result["batchItemFailures"]:
            assert "itemIdentifier" in failure


# ---------------------------------------------------------------------------
# run_agent_in_subprocess credential isolation
# ---------------------------------------------------------------------------

class TestRunAgentCredentialIsolation:
    """Property tests for credential handling in subprocess execution."""

    @given(
        access_key=st.text(min_size=10, max_size=30, alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
        secret_key=st.text(min_size=20, max_size=50),
        session_token=st.text(min_size=20, max_size=100),
    )
    @settings(max_examples=30)
    def test_scoped_credentials_passed_to_child_env(
        self, access_key, secret_key, session_token
    ):
        """Scoped credentials are injected into the subprocess environment."""
        creds = {
            "accessKeyId": access_key,
            "secretAccessKey": secret_key,
            "sessionToken": session_token,
        }

        with patch("index.subprocess") as mock_subprocess:
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = json.dumps({"response": "ok"})
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            run_agent_in_subprocess({}, creds)

            call_kwargs = mock_subprocess.run.call_args[1]
            child_env = call_kwargs["env"]
            assert child_env["AWS_ACCESS_KEY_ID"] == access_key
            assert child_env["AWS_SECRET_ACCESS_KEY"] == secret_key
            assert child_env["AWS_SESSION_TOKEN"] == session_token

    def test_no_credentials_removes_stale_env_vars(self):
        """Without scoped creds, AWS credential env vars are removed."""
        # Set stale creds in parent env
        with patch.dict(os.environ, {
            "AWS_ACCESS_KEY_ID": "STALE",
            "AWS_SECRET_ACCESS_KEY": "STALE",
            "AWS_SESSION_TOKEN": "STALE",
        }):
            with patch("index.subprocess") as mock_subprocess:
                mock_result = MagicMock()
                mock_result.returncode = 0
                mock_result.stdout = json.dumps({"response": "ok"})
                mock_result.stderr = ""
                mock_subprocess.run.return_value = mock_result

                run_agent_in_subprocess({}, None)

                call_kwargs = mock_subprocess.run.call_args[1]
                child_env = call_kwargs["env"]
                assert "AWS_ACCESS_KEY_ID" not in child_env
                assert "AWS_SECRET_ACCESS_KEY" not in child_env
                assert "AWS_SESSION_TOKEN" not in child_env

    def test_subprocess_timeout_is_840_seconds(self):
        """Subprocess timeout is set to 840s (14 min, under Lambda 15 min)."""
        with patch("index.subprocess") as mock_subprocess:
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = json.dumps({"response": "ok"})
            mock_result.stderr = ""
            mock_subprocess.run.return_value = mock_result

            run_agent_in_subprocess({}, None)

            call_kwargs = mock_subprocess.run.call_args[1]
            assert call_kwargs["timeout"] == 840

    def test_nonzero_exit_returns_error_message(self):
        """Non-zero exit code returns a graceful error message."""
        with patch("index.subprocess") as mock_subprocess:
            mock_result = MagicMock()
            mock_result.returncode = 1
            mock_result.stdout = ""
            mock_result.stderr = "segfault"
            mock_subprocess.run.return_value = mock_result

            result = run_agent_in_subprocess({}, None)
            assert "could not be completed" in result.lower() or "issues" in result.lower()


# ---------------------------------------------------------------------------
# post_task_complete event structure
# ---------------------------------------------------------------------------

class TestPostTaskComplete:
    """Property tests for post_task_complete event publishing."""

    @given(
        response=st.text(min_size=1, max_size=200),
        agent_use_id=st.text(min_size=1, max_size=50),
        agent_name=st.text(min_size=1, max_size=30),
        orchestration_id=st.uuids().map(str),
    )
    @settings(max_examples=50)
    def test_event_has_correct_source(self, response, agent_use_id, agent_name, orchestration_id):
        """Published event always has Source 'task.completion'."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            post_task_complete(response, agent_use_id, agent_name, orchestration_id)

        call_kwargs = mock_client.put_events.call_args[1]
        entry = call_kwargs["Entries"][0]
        assert entry["Source"] == "task.completion"
        assert entry["DetailType"] == "task.completion"

    @given(
        response=st.text(min_size=1, max_size=200),
        agent_use_id=st.text(min_size=1, max_size=50),
        agent_name=st.text(min_size=1, max_size=30),
        orchestration_id=st.uuids().map(str),
    )
    @settings(max_examples=50)
    def test_event_detail_is_valid_json(self, response, agent_use_id, agent_name, orchestration_id):
        """Event Detail is always valid JSON."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            post_task_complete(response, agent_use_id, agent_name, orchestration_id)

        call_kwargs = mock_client.put_events.call_args[1]
        detail = json.loads(call_kwargs["Entries"][0]["Detail"])
        assert detail["orchestration_id"] == orchestration_id
        assert detail["agent_use_id"] == agent_use_id
        assert detail["node"] == agent_name

    @given(
        response=st.text(min_size=1, max_size=200),
        agent_use_id=st.text(min_size=1, max_size=50),
        agent_name=st.text(min_size=1, max_size=30),
        orchestration_id=st.uuids().map(str),
    )
    @settings(max_examples=50)
    def test_event_uses_completion_bus(self, response, agent_use_id, agent_name, orchestration_id):
        """Event is sent to COMPLETION_BUS_NAME."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            post_task_complete(response, agent_use_id, agent_name, orchestration_id)

        call_kwargs = mock_client.put_events.call_args[1]
        entry = call_kwargs["Entries"][0]
        assert entry["EventBusName"] == os.environ["COMPLETION_BUS_NAME"]
