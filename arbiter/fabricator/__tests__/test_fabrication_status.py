"""
Tests for the durable fabrication-jobs status writes in
arbiter/fabricator/index.py process_event.

process_event must:
  - write status=PROCESSING (+updatedAt) at the START of processing,
  - write status=COMPLETED (+agentId +updatedAt) on success,
  - write status=FAILED (+errorMessage +updatedAt) on exception (then re-raise),
  - skip the write when FABRICATION_JOBS_TABLE is unset,
  - never let a status-write failure change the fabrication outcome.
"""

import sys
import os
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index


def _base_event():
    return {
        "orchestration_id": "sess-1",
        "agent_use_id": "MyAgent",
        "node": "fabricator",
        "agent_input": {"taskDetails": "Create an agent that does things"},
        "agent_index": 0,
        "total_agents": 1,
    }


class TestFabricationStatusWrites:
    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_processing_then_completed_on_success(self):
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            index.process_event(_base_event(), {}, request_type="agent-creation")

        seq = [s for s, _ in statuses]
        assert seq[0] == "PROCESSING"
        assert "COMPLETED" in seq
        completed_kwargs = next(kw for s, kw in statuses if s == "COMPLETED")
        assert completed_kwargs.get("agent_id") == "MyAgent"

    def test_failed_on_exception_and_reraises(self):
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        boom = RuntimeError("fabrication blew up")
        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            agent = MagicMock(side_effect=boom)
            mk.return_value = agent
            with pytest.raises(RuntimeError):
                index.process_event(_base_event(), {}, request_type="agent-creation")

        seq = [s for s, _ in statuses]
        assert seq[0] == "PROCESSING"
        assert "FAILED" in seq
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        assert "fabrication blew up" in (failed_kwargs.get("error_message") or "")

    def test_status_write_failure_does_not_change_success(self):
        # The underlying DynamoDB update_item raising must not break
        # fabrication — the helper swallows it (best-effort).
        failing_ddb = MagicMock()
        failing_ddb.update_item.side_effect = Exception("ddb down")
        with patch.object(index.boto3, "client", return_value=failing_ddb), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            mk.return_value = MagicMock()
            # Should NOT raise — status writes are best-effort.
            index.process_event(_base_event(), {}, request_type="agent-creation")

    def test_helper_skips_when_table_unset(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status("sess-1", "MyAgent", "PROCESSING")
        mock_client.update_item.assert_not_called()

    def test_helper_writes_update_item_with_keys(self):
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "COMPLETED", agent_id="MyAgent"
            )
        assert mock_client.update_item.called
        kwargs = mock_client.update_item.call_args.kwargs
        assert kwargs["TableName"] == "citadel-fabrication-jobs-test"
        assert kwargs["Key"] == {
            "orchestrationId": {"S": "sess-1"},
            "agentUseId": {"S": "MyAgent"},
        }

    def test_helper_sets_agent_name_via_if_not_exists(self):
        # agentName must be set with if_not_exists so a producer-set value
        # is never clobbered, using the threaded agent_name param.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "PROCESSING", agent_name="MyAgent"
            )
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "agentName = if_not_exists(agentName, :agentName)" in expr
        assert kwargs["ExpressionAttributeValues"][":agentName"] == {"S": "MyAgent"}

    def test_helper_sets_submitted_at_via_if_not_exists(self):
        # submittedAt must be stamped with if_not_exists so the first write
        # records a submit time when no PENDING row exists.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "PROCESSING", agent_name="MyAgent"
            )
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "submittedAt = if_not_exists(submittedAt, :submittedAt)" in expr
        assert ":submittedAt" in kwargs["ExpressionAttributeValues"]

    def test_helper_omits_agent_name_when_not_provided(self):
        # Backward compatible: with no agent_name the agentName clause is
        # skipped (no :agentName binding).
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status("sess-1", "MyAgent", "PROCESSING")
        kwargs = mock_client.update_item.call_args.kwargs
        assert "agentName" not in kwargs["UpdateExpression"]
        assert ":agentName" not in kwargs["ExpressionAttributeValues"]

    def test_process_event_threads_agent_use_id_as_agent_name(self):
        # process_event must pass agent_use_id as agent_name at the
        # PROCESSING/COMPLETED call sites.
        calls = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            calls.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            index.process_event(_base_event(), {}, request_type="agent-creation")

        processing_kwargs = next(kw for s, kw in calls if s == "PROCESSING")
        assert processing_kwargs.get("agent_name") == "MyAgent"
