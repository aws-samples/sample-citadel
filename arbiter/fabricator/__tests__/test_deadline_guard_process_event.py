"""
Tests for the deadline guard in arbiter/fabricator/index.py process_event.

Live evidence (2026-07-23): the fabricator Lambda was SIGKILLed at exactly
900s (REPORT Status: timeout). The kill skipped the terminal DDB write, SQS
redelivered the message into the same poison state (visibility 90 min,
maxReceiveCount 3), and after the 3rd kill both messages parked in the DLQ
with rows stuck PROCESSING forever.

Contract under test:
  - process_event builds a FabricationDeadline from the REAL Lambda context
    (context.get_remaining_time_in_millis) and threads it into
    call_with_transient_retry.
  - When the deadline guard trips (FabricationDeadlineExceeded propagating
    out of the agent loop), process_event writes the job's terminal FAILED
    status ONCE with a 'timed out' actionable message, publishes the
    failure signals ONCE, and RETURNS CLEANLY (no re-raise) — deleting the
    SQS message instead of feeding the kill→redeliver→kill→DLQ loop.
  - Belt-and-braces: if a checkpoint tripped but the exception was converted
    into an LLM-visible tool error inside the agent loop, the run must still
    end FAILED('timed out'), never COMPLETED.
  - The module-level deadline is set for the run and cleared afterwards
    (Lambda containers are reused), on success AND on failure.
  - Legacy contexts without get_remaining_time_in_millis ({} in tests and
    __main__) degrade to an unlimited deadline — behavior unchanged.
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

import index  # noqa: E402
from deadline import (  # noqa: E402
    FabricationDeadline,
    FabricationDeadlineExceeded,
    get_fabrication_deadline,
)


class _FakeLambdaContext:
    def __init__(self, remaining_ms):
        self._remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self._remaining_ms


def _base_event():
    return {
        "orchestration_id": "sess-1",
        "agent_use_id": "MyAgent",
        "node": "fabricator",
        "agent_input": {"taskDetails": "Create an agent that does things"},
        "agent_index": 0,
        "total_agents": 1,
    }


class TestProcessEventDeadlineGuard:
    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def _run(self, agent, context, statuses):
        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress") as progress, \
                patch.object(index, "publish_fabrication_event") as events:
            mk.return_value = agent
            result = index.process_event(
                _base_event(), context, request_type="agent-creation"
            )
        return result, progress, events

    def test_deadline_trip_writes_timed_out_failed_and_returns_cleanly(self):
        # A checkpoint deep in the agent loop tripped: the BaseException
        # propagates out; process_event must terminal-write and RETURN.
        statuses = []
        agent = MagicMock(
            side_effect=FabricationDeadlineExceeded("margin reached")
        )

        # Must NOT raise — a re-raise would nack the SQS message and restart
        # the kill→redeliver→kill loop.
        result, progress, events = self._run(
            agent, _FakeLambdaContext(900_000), statuses
        )

        assert result is None
        seq = [s for s, _ in statuses]
        assert seq == ["PROCESSING", "FAILED"]
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        message = failed_kwargs.get("error_message") or ""
        assert "timed out" in message
        assert "Re-queue" in message

    def test_deadline_trip_publishes_failure_signals_once(self):
        statuses = []
        agent = MagicMock(
            side_effect=FabricationDeadlineExceeded("margin reached")
        )

        _, progress, events = self._run(
            agent, _FakeLambdaContext(900_000), statuses
        )

        assert events.call_count == 1
        assert events.call_args.kwargs["event_type"] == "agent.fabrication.failed"
        assert progress.call_count == 1
        assert progress.call_args.kwargs.get("failed") is True

    def test_deadline_trip_returns_cleanly_even_if_publishes_fail(self):
        # The clean return (SQS message deletion) is the loop-breaker; a
        # failing EventBridge publish must not turn it back into a re-raise
        # that redelivers the message for another 900s run.
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress",
                             side_effect=RuntimeError("eventbridge down")), \
                patch.object(index, "publish_fabrication_event",
                             side_effect=RuntimeError("eventbridge down")):
            mk.return_value = MagicMock(
                side_effect=FabricationDeadlineExceeded("margin reached")
            )
            result = index.process_event(
                _base_event(), _FakeLambdaContext(900_000),
                request_type="agent-creation",
            )

        assert result is None
        assert [s for s, _ in statuses] == ["PROCESSING", "FAILED"]

    def test_tripped_flag_fallback_prevents_completed(self):
        # If the trip was converted into an LLM-visible tool error inside the
        # agent loop (Strands catches Exception; conversions are possible),
        # the run returns "normally" — but COMPLETED must NOT be written.
        statuses = []

        def fake_agent_call(task):
            deadline = get_fabrication_deadline()
            try:
                deadline.check("simulated checkpoint")
            except FabricationDeadlineExceeded:
                pass  # simulate the exception being swallowed downstream
            return MagicMock()

        agent = MagicMock(side_effect=fake_agent_call)
        result, _, _ = self._run(agent, _FakeLambdaContext(10_000), statuses)

        assert result is None
        seq = [s for s, _ in statuses]
        assert "COMPLETED" not in seq
        assert seq == ["PROCESSING", "FAILED"]
        failed_kwargs = next(kw for s, kw in statuses if s == "FAILED")
        assert "timed out" in (failed_kwargs.get("error_message") or "")

    def test_success_path_unchanged_with_roomy_context(self):
        statuses = []
        result, progress, _ = self._run(
            MagicMock(), _FakeLambdaContext(900_000), statuses
        )

        assert result is None
        seq = [s for s, _ in statuses]
        assert seq == ["PROCESSING", "COMPLETED"]

    def test_dict_context_degrades_to_unlimited_and_succeeds(self):
        statuses = []
        result, _, _ = self._run(MagicMock(), {}, statuses)
        assert [s for s, _ in statuses] == ["PROCESSING", "COMPLETED"]

    def test_deadline_threaded_into_transient_retry(self):
        captured = {}

        def fake_retry(operation, **kwargs):
            captured.update(kwargs)
            return operation()

        with patch.object(index, "call_with_transient_retry", side_effect=fake_retry), \
                patch.object(index, "_write_fabrication_status"), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            index.process_event(
                _base_event(), _FakeLambdaContext(900_000),
                request_type="agent-creation",
            )

        assert isinstance(captured.get("deadline"), FabricationDeadline)

    def test_module_deadline_cleared_after_success(self):
        statuses = []
        self._run(MagicMock(), _FakeLambdaContext(900_000), statuses)
        assert get_fabrication_deadline() is None

    def test_module_deadline_cleared_after_failure(self):
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            mk.return_value = MagicMock(side_effect=RuntimeError("boom"))
            with pytest.raises(RuntimeError):
                index.process_event(
                    _base_event(), _FakeLambdaContext(900_000),
                    request_type="agent-creation",
                )
        assert get_fabrication_deadline() is None

    def test_non_deadline_failures_keep_reraising_for_sqs_redelivery(self):
        # Regression guard: the clean-return path is ONLY for the deadline
        # trip; genuine errors must still re-raise (SQS poison guard).
        statuses = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            statuses.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            mk.return_value = MagicMock(side_effect=RuntimeError("boom"))
            with pytest.raises(RuntimeError):
                index.process_event(
                    _base_event(), _FakeLambdaContext(900_000),
                    request_type="agent-creation",
                )
        assert "FAILED" in [s for s, _ in statuses]
