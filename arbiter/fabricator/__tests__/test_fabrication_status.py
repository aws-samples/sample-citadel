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


class TestRegistrationErrorsJobStatusBranching:
    """process_event's post-agent-loop terminal write branches on this run's
    tool-registration bookkeeping (_registration_run_state), additive only
    — no new status enum value:
      - zero registration failures -> bare COMPLETED (no registrationErrors)
      - some succeeded, some failed (partial) -> COMPLETED + registrationErrors
      - every registration failed (none succeeded) -> FAILED + errorMessage +
        registrationErrors, then a CLEAN RETURN (no raise / no redelivery).
    """

    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def _run_tool_creation(self, agent_side_effect):
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_tool_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            mk.return_value = MagicMock(side_effect=agent_side_effect)
            result = index.process_event(
                _base_event(), {}, request_type="tool-creation"
            )
        return statuses, result

    def test_zero_registration_failures_writes_bare_completed(self):
        # No tool_fabricator call ever touches run_state.failed/succeeded ->
        # registration_errors stays None -> bare COMPLETED, no attribute.
        def fake_fabricator(task):
            return "done"

        statuses, result = self._run_tool_creation(fake_fabricator)

        seq = [s for s, _ in statuses]
        assert seq == ["PROCESSING", "COMPLETED"]
        completed_kwargs = next(kw for s, kw in statuses if s == "COMPLETED")
        assert completed_kwargs.get("registration_errors") is None
        assert result is None

    def test_partial_registration_failure_writes_completed_with_errors(self):
        # One tool succeeded, one failed this run -> still COMPLETED (the
        # agent has usable tools) but registrationErrors must be present.
        def fake_fabricator(task):
            run_state = index._registration_run_state
            run_state.succeeded.add("tool_ok")
            run_state.failed["tool_bad"] = "orphaned CREATING record"
            return "done"

        statuses, result = self._run_tool_creation(fake_fabricator)

        seq = [s for s, _ in statuses]
        assert seq == ["PROCESSING", "COMPLETED"]
        completed_kwargs = next(kw for s, kw in statuses if s == "COMPLETED")
        errors = completed_kwargs.get("registration_errors")
        assert errors == [{"toolId": "tool_bad", "error": "orphaned CREATING record"}]
        assert result is None

    def test_all_registrations_failed_writes_failed_and_returns_cleanly(self):
        # Every tool registration failed this run (succeeded stays empty) ->
        # terminal FAILED + errorMessage + registrationErrors, and the
        # handler returns cleanly (no raise -> no SQS redelivery).
        def fake_fabricator(task):
            run_state = index._registration_run_state
            run_state.failed["tool_a"] = "orphaned CREATING record"
            run_state.failed["tool_b"] = "orphaned CREATING record"
            return "done"

        statuses, result = self._run_tool_creation(fake_fabricator)

        seq = [s for s, _ in statuses]
        assert seq == ["PROCESSING", "FAILED"]
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        assert failed_kwargs.get("error_message")
        errors = failed_kwargs.get("registration_errors")
        assert {"toolId": "tool_a", "error": "orphaned CREATING record"} in errors
        assert {"toolId": "tool_b", "error": "orphaned CREATING record"} in errors
        # Clean return: no exception propagates from process_event.
        assert result is None


class TestStaleRegistrationAttrsClearedOnCleanTerminalWrite:
    """A terminal write with ZERO registration failures this run must REMOVE
    any registrationErrors/errorMessage left by an earlier failed/partial
    attempt on the same row — otherwise a bare success can be misread as a
    partial-failure completion (finding 5672bc34)."""

    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_clean_completed_write_removes_stale_registration_attrs(self):
        # Seed row (conceptually) carries stale registrationErrors +
        # errorMessage from a prior FAILED attempt. A clean COMPLETED write
        # (no error_message, no registration_errors passed) must emit a
        # REMOVE clause for both attributes rather than leaving them.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "COMPLETED", agent_id="MyAgent",
            )
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "REMOVE" in expr
        assert "#registrationErrors" in expr.split("REMOVE", 1)[1]
        assert "#errorMessage" in expr.split("REMOVE", 1)[1]
        assert kwargs["ExpressionAttributeNames"]["#registrationErrors"] == "registrationErrors"
        assert kwargs["ExpressionAttributeNames"]["#errorMessage"] == "errorMessage"
        # Neither attribute may also appear in a SET clause (would conflict
        # with the REMOVE and is redundant): check the SET portion only.
        set_clause = expr.split("REMOVE", 1)[0]
        assert ":registrationErrors" not in kwargs.get("ExpressionAttributeValues", {})
        assert ":errorMessage" not in kwargs.get("ExpressionAttributeValues", {})
        assert "#registrationErrors = " not in set_clause
        assert "#errorMessage = " not in set_clause

    def test_partial_failure_write_still_sets_registration_attrs_no_remove(self):
        # A write WITH registration_errors/error_message present must SET
        # them (existing behavior) and must NOT include them in REMOVE.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "COMPLETED", agent_id="MyAgent",
                registration_errors=[{"toolId": "tool_bad", "error": "boom"}],
            )
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "#registrationErrors = :registrationErrors" in expr
        remove_clause = expr.split("REMOVE", 1)[1] if "REMOVE" in expr else ""
        assert "#registrationErrors" not in remove_clause
        assert kwargs["ExpressionAttributeValues"][":registrationErrors"]["L"][0]["M"]["toolId"] == {"S": "tool_bad"}

    def test_failed_write_with_error_message_sets_it_no_remove(self):
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status(
                "sess-1", "MyAgent", "FAILED", error_message="boom",
            )
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "#errorMessage = :errorMessage" in expr
        remove_clause = expr.split("REMOVE", 1)[1] if "REMOVE" in expr else ""
        assert "#errorMessage" not in remove_clause

    def test_non_terminal_processing_write_neither_sets_nor_removes_error_attrs(self):
        # PROCESSING is not terminal — must not add a REMOVE clause for
        # attributes it has no opinion about (avoids a no-op REMOVE churn
        # on every PROCESSING write).
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            index._write_fabrication_status("sess-1", "MyAgent", "PROCESSING")
        kwargs = mock_client.update_item.call_args.kwargs
        expr = kwargs["UpdateExpression"]
        assert "REMOVE" not in expr

    def test_end_to_end_stale_attrs_absent_after_clean_rerun(self):
        # Full simulation: seed a row's update_item call history to confirm
        # a later clean COMPLETED call's REMOVE clause would clear both
        # stale attributes a prior FAILED call had set via SET.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            # Attempt one (2026-08-01): FAILED with error attrs set.
            index._write_fabrication_status(
                "sess-1", "MyAgent", "FAILED",
                error_message="registration failed",
                registration_errors=[{"toolId": "t1", "error": "boom"}],
            )
            first_kwargs = mock_client.update_item.call_args.kwargs
            assert "#errorMessage = :errorMessage" in first_kwargs["UpdateExpression"]
            assert "#registrationErrors = :registrationErrors" in first_kwargs["UpdateExpression"]

            # Attempt three (2026-08-02): clean COMPLETED re-run.
            index._write_fabrication_status(
                "sess-1", "MyAgent", "COMPLETED", agent_id="MyAgent",
            )
            second_kwargs = mock_client.update_item.call_args.kwargs
        expr = second_kwargs["UpdateExpression"]
        # Bite: reverting to a no-REMOVE implementation makes this fail,
        # since the stale attrs would only ever be SET, never cleared.
        assert "REMOVE" in expr
        remove_clause = expr.split("REMOVE", 1)[1]
        assert "#errorMessage" in remove_clause
        assert "#registrationErrors" in remove_clause


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
