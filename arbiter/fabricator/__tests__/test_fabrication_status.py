"""
Tests for the durable fabrication-jobs status writes in
arbiter/fabricator/index.py process_event.

process_event must:
  - write status=PROCESSING (+updatedAt) at the START of processing,
  - write status=COMPLETED (+agentId +updatedAt) on success,
  - write status=FAILED (+errorMessage +updatedAt) on exception (then re-raise),
  - retry transient Bedrock faults (bounded) BEFORE any FAILED write,
  - skip the write when FABRICATION_JOBS_TABLE is unset,
  - never let a status-write failure change the fabrication outcome.
"""

import functools
import sys
import os
from unittest.mock import patch, MagicMock

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index
import transient_retry


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


def _transient_error(code: str = "internalServerException",
                     message: str = "Bedrock had an internal error"):
    return ClientError({"Error": {"Code": code, "Message": message}}, "ConverseStream")


# The real retry logic with sleeping neutralised — integration tests must
# exercise genuine attempt-counting/classification without real backoff.
_NO_SLEEP_RETRY = functools.partial(
    transient_retry.call_with_transient_retry, sleep=lambda _d: None
)


class TestTransientRetryBeforeFailed:
    """process_event must retry transient Bedrock faults (bounded) and only
    write FAILED after the retry budget is exhausted; non-transient faults
    keep failing fast on the first attempt."""

    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def _run(self, agent, request_type="agent-creation", expect_raises=None):
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        factory = "create_tool_fabricator" if request_type == "tool-creation" \
            else "create_agent_fabricator"
        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, factory) as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"), \
                patch.object(index, "call_with_transient_retry", _NO_SLEEP_RETRY):
            mk.return_value = agent
            if expect_raises is not None:
                with pytest.raises(expect_raises):
                    index.process_event(_base_event(), {}, request_type=request_type)
            else:
                index.process_event(_base_event(), {}, request_type=request_type)
        return statuses

    def test_transient_faults_recovered_then_completed_never_failed(self):
        # internalServerException twice, then success → COMPLETED after
        # exactly 3 invocations; no FAILED write ever happens.
        agent = MagicMock(side_effect=[
            _transient_error(), _transient_error(), "done",
        ])
        statuses = self._run(agent)
        seq = [s for s, _ in statuses]
        assert agent.call_count == 3
        assert "COMPLETED" in seq
        assert "FAILED" not in seq

    def test_failed_written_once_only_after_retries_exhaust(self):
        # Always-transient → the original ClientError re-raises after exactly
        # MAX_ATTEMPTS invocations, and FAILED is written exactly once.
        agent = MagicMock(side_effect=_transient_error())
        statuses = self._run(agent, expect_raises=ClientError)
        assert agent.call_count == transient_retry.MAX_ATTEMPTS
        failed = [kw for s, kw in statuses if s == "FAILED"]
        assert len(failed) == 1

    def test_exhausted_transient_error_message_is_actionable_and_keeps_detail(self):
        boom = _transient_error(message="An internal error occurred")
        agent = MagicMock(side_effect=boom)
        statuses = self._run(agent, expect_raises=ClientError)
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        msg = failed_kwargs.get("error_message") or ""
        # Bedrock detail kept …
        assert "internalServerException" in msg
        assert "An internal error occurred" in msg
        # … plus operator guidance.
        assert "temporary" in msg.lower()
        assert "again" in msg.lower()

    def test_validation_exception_fails_fast_single_attempt_raw_message(self):
        boom = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "bad request"}},
            "Converse",
        )
        agent = MagicMock(side_effect=boom)
        statuses = self._run(agent, expect_raises=ClientError)
        assert agent.call_count == 1
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        # Non-transient failure detail stays the raw Bedrock message.
        assert failed_kwargs.get("error_message") == str(boom)

    def test_tool_creation_path_also_retries_transient(self):
        tool_fab = MagicMock(side_effect=[
            _transient_error("throttlingException"), "ok",
        ])
        self._run(tool_fab, request_type="tool-creation")
        assert tool_fab.call_count == 2
