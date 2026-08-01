"""
Integration tests (through arbiter/fabricator/index.py) for the
kill→poison→kill loop fix around store_tool_config_registry.

Live evidence (2026-07-23): after a 900s SIGKILL orphaned tool records in
CREATING state, every store_tool_config_registry call failed with
ConflictException 'Registry record cannot be modified while in CREATING
state' on UpdateRegistryRecordStatus. The fabricator LLM retried the tool
92-110× per run (~825-834s of the 900s budget) and tool.fabrication.failed
was published 45-53× per run.

Contract under test:
  - On a CREATING conflict at the approve step, the tool runs the bounded
    recovery (poll → delete-and-recreate → approve) instead of re-raising
    the raw ConflictException for the LLM to retry.
  - A recovered registration returns True and publishes NO failure event.
  - When recovery fails, the tool raises OrphanedRegistryRecordError
    (terminal, 'DO NOT retry') and, within a registration run, LATCHES the
    tool_id: repeat calls fail instantly with no registry API traffic.
  - tool.fabrication.failed is emitted ONCE per (tool_id, error type) per
    registration run — never once per LLM retry iteration.
  - Outside a registration run (legacy direct calls), publish behavior is
    unchanged (one event per failing call).
  - Deadline watchdog checkpoints guard each registration site: the tool
    and agent registration @tools and create_custom_tool refuse to START
    (and the tool path refuses to CONTINUE past) a registration inside the
    Lambda's safety margin, raising FabricationDeadlineExceeded so
    process_event can write the terminal 'timed out' status.
"""

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
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402
import registry_recovery  # noqa: E402
from deadline import (  # noqa: E402
    FabricationDeadline,
    FabricationDeadlineExceeded,
    clear_fabrication_deadline,
    set_fabrication_deadline,
)
from registry_recovery import OrphanedRegistryRecordError  # noqa: E402

LIVE_CONFLICT_MESSAGE = (
    "Registry record cannot be modified while in CREATING state."
)


def _conflict(operation="UpdateRegistryRecordStatus", message=LIVE_CONFLICT_MESSAGE):
    return ClientError(
        {"Error": {"Code": "ConflictException", "Message": message}}, operation
    )


def _not_found():
    return ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "gone"}},
        "GetRegistryRecord",
    )


def _arn(record_id):
    return {
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:1:registry/reg/record/{record_id}",
        "status": "CREATING",
    }


def _call_store_tool(tool_id="my_tool"):
    return index.store_tool_config_registry(
        file_name=f"tools/{tool_id}.py",
        tool_id=tool_id,
        tool_schema={"type": "object", "properties": {}},
        tool_description="a test tool",
    )


@pytest.fixture(autouse=True)
def _no_recovery_sleep():
    with patch.object(registry_recovery, "_sleep", lambda seconds: None):
        yield


@pytest.fixture(autouse=True)
def _clean_deadline():
    clear_fabrication_deadline()
    yield
    clear_fabrication_deadline()


@pytest.fixture()
def run_state():
    index._begin_registration_run()
    yield
    index._end_registration_run()


# ---------------------------------------------------------------------------
# Recovery wiring through store_tool_config_registry
# ---------------------------------------------------------------------------

class TestCreatingConflictRecoveryWiring:
    def test_happy_path_approve_is_legal_two_step_sequence(self, run_state):
        # Root-cause regression guard: approve must NEVER be a single
        # DRAFT->APPROVED call (the live service rejects that with
        # ValidationException) — it must always be the two-step
        # DRAFT->PENDING_APPROVAL->APPROVED sequence, on the ordinary happy
        # path (no CREATING conflict at all).
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")

        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            assert _call_store_tool() is True

        calls = client.update_registry_record_status.call_args_list
        assert len(calls) == 2
        assert calls[0].kwargs["status"] == "PENDING_APPROVAL"
        assert calls[0].kwargs["recordId"] == "rec-1"
        assert calls[1].kwargs["status"] == "APPROVED"
        assert calls[1].kwargs["recordId"] == "rec-1"
        pub.assert_not_called()

    def test_in_flight_creating_recovers_and_returns_true(self, run_state):
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        # First approve attempt: PENDING_APPROVAL step hits the CREATING
        # conflict. Recovery polls to DRAFT, then approve-in-place runs the
        # full two-step sequence (PENDING_APPROVAL, APPROVED) again.
        client.update_registry_record_status.side_effect = [
            _conflict(), None, None,
        ]
        client.get_registry_record.side_effect = [{"status": "DRAFT"}]

        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            assert _call_store_tool() is True

        # 1 failed PENDING_APPROVAL (conflict) + 2 recovered steps = 3 calls.
        assert client.update_registry_record_status.call_count == 3
        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_called_once()
        # A recovered registration is a SUCCESS — no failure event.
        pub.assert_not_called()

    def test_seeded_creating_orphan_yields_one_usable_record_zero_net_new(
        self, run_state
    ):
        # Integration-style seed of a CREATING orphan: recovery must yield
        # exactly one usable record and create/delete NOTHING in the
        # process (structural zero-net-new-orphans invariant).
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        client.update_registry_record_status.side_effect = [_conflict(), None, None]
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            assert _call_store_tool() is True

        # Exactly one create call (the original registration) — recovery
        # never calls create_registry_record or delete_registry_record.
        client.create_registry_record.assert_called_once()
        client.delete_registry_record.assert_not_called()
        pub.assert_not_called()

    def test_stuck_creating_beyond_budget_is_single_terminal_no_recreate(
        self, run_state
    ):
        # Replaces the old delete-and-recreate scenario: past the poll
        # budget, recovery raises ONE terminal error — no delete, no
        # recreate, no second attempt.
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        client.update_registry_record_status.side_effect = _conflict()
        client.get_registry_record.return_value = {"status": "CREATING"}

        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            with pytest.raises(OrphanedRegistryRecordError):
                _call_store_tool()

        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_called_once()
        assert pub.call_count == 1

    def test_non_creating_conflict_is_not_recovered(self, run_state):
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        client.update_registry_record_status.side_effect = _conflict(
            message="Record is being updated by another request"
        )

        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event"):
            with pytest.raises(ClientError):
                _call_store_tool()

        client.get_registry_record.assert_not_called()
        client.delete_registry_record.assert_not_called()


# ---------------------------------------------------------------------------
# Terminal latch + failure-event burst bounding
# ---------------------------------------------------------------------------

class TestTerminalLatchAndPublishOnce:
    def _poisoned_client(self):
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        client.update_registry_record_status.side_effect = _conflict()
        client.get_registry_record.return_value = {"status": "CREATING"}
        client.delete_registry_record.side_effect = _conflict(
            "DeleteRegistryRecord",
            "Registry record cannot be deleted while in CREATING state.",
        )
        return client

    def test_failed_recovery_raises_terminal_do_not_retry(self, run_state):
        client = self._poisoned_client()
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event"):
            with pytest.raises(OrphanedRegistryRecordError) as exc_info:
                _call_store_tool()

        message = str(exc_info.value)
        assert "NON-RETRYABLE" in message
        assert "DO NOT retry" in message
        assert "my_tool" in message

    def test_repeat_call_is_latched_instant_and_publishes_once(self, run_state):
        # The LLM retry spiral (92-110 tool retries, 45-53 failure events per
        # run) must collapse to: 1 recovery attempt + 1 event + instant
        # refusals with zero registry traffic.
        client = self._poisoned_client()
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            with pytest.raises(OrphanedRegistryRecordError):
                _call_store_tool()
            assert pub.call_count == 1
            assert pub.call_args.kwargs["event_type"] == "tool.fabrication.failed"

            client.create_registry_record.reset_mock()
            client.update_registry_record_status.reset_mock()

            with pytest.raises(OrphanedRegistryRecordError):
                _call_store_tool()

            client.create_registry_record.assert_not_called()
            client.update_registry_record_status.assert_not_called()
            assert pub.call_count == 1

    def test_other_tools_are_not_latched(self, run_state):
        client = self._poisoned_client()
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event"):
            with pytest.raises(OrphanedRegistryRecordError):
                _call_store_tool("tool_a")

            healthy = MagicMock()
            healthy.create_registry_record.return_value = _arn("rec-9")
        with patch.object(index, "_get_registry_client", return_value=healthy), \
                patch.object(index, "publish_fabrication_event") as pub:
            assert _call_store_tool("tool_b") is True
            pub.assert_not_called()

    def test_new_run_clears_the_latch(self):
        index._begin_registration_run()
        try:
            client = self._poisoned_client()
            with patch.object(index, "_get_registry_client", return_value=client), \
                    patch.object(index, "publish_fabrication_event"):
                with pytest.raises(OrphanedRegistryRecordError):
                    _call_store_tool()

            # Next SQS record → fresh run → no stale latch (Lambda containers
            # are reused across invocations).
            index._begin_registration_run()
            healthy = MagicMock()
            healthy.create_registry_record.return_value = _arn("rec-9")
            with patch.object(index, "_get_registry_client", return_value=healthy), \
                    patch.object(index, "publish_fabrication_event"):
                assert _call_store_tool() is True
        finally:
            index._end_registration_run()

    def test_legacy_direct_calls_outside_run_publish_every_time(self):
        # No registration run active (direct invocation): behavior is the
        # pre-fix one — one failure event per failing call.
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError("boom")
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            for _ in range(2):
                with pytest.raises(RuntimeError):
                    _call_store_tool()
        assert pub.call_count == 2


# ---------------------------------------------------------------------------
# Deadline watchdog checkpoints at the registration sites
# ---------------------------------------------------------------------------

class TestRegistrationDeadlineCheckpoints:
    def test_tool_registration_refuses_to_start_inside_margin(self):
        set_fabrication_deadline(FabricationDeadline(lambda: 10_000))
        client = MagicMock()
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            with pytest.raises(FabricationDeadlineExceeded):
                _call_store_tool()
        client.create_registry_record.assert_not_called()
        # BaseException must skip the except-Exception publish path.
        pub.assert_not_called()

    def test_tool_registration_checkpoints_after_completing_registration(self):
        # Entry has room; the exit checkpoint lands inside the margin —
        # registration completes, then the guard stops further work.
        clock = iter([900_000, 10_000])
        set_fabrication_deadline(
            FabricationDeadline(lambda: next(clock, 10_000))
        )
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event"):
            with pytest.raises(FabricationDeadlineExceeded):
                _call_store_tool()
        client.create_registry_record.assert_called_once()
        # Approve is now the legal two-step DRAFT->PENDING_APPROVAL->APPROVED
        # sequence (root-cause fix), so a completed registration makes two
        # update_registry_record_status calls, not one.
        assert client.update_registry_record_status.call_count == 2

    def test_agent_registration_refuses_to_start_inside_margin(self):
        set_fabrication_deadline(FabricationDeadline(lambda: 10_000))
        client = MagicMock()
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event") as pub:
            with pytest.raises(FabricationDeadlineExceeded):
                index.store_agent_config_registry(
                    file_name="agents/my_agent.py",
                    agent_id="MyAgent",
                    llm_tool_schema={"type": "object"},
                    agent_description="an agent",
                )
        client.create_registry_record.assert_not_called()
        client.list_registry_records.assert_not_called()
        pub.assert_not_called()

    def test_create_custom_tool_refuses_to_start_inside_margin(self):
        set_fabrication_deadline(FabricationDeadline(lambda: 10_000))
        with patch.object(index, "create_tool_fabricator") as mk:
            with pytest.raises(FabricationDeadlineExceeded):
                index.create_custom_tool(tool_description="a nested tool")
        mk.assert_not_called()

    def test_no_deadline_set_keeps_registration_working(self):
        client = MagicMock()
        client.create_registry_record.return_value = _arn("rec-1")
        with patch.object(index, "_get_registry_client", return_value=client), \
                patch.object(index, "publish_fabrication_event"):
            assert _call_store_tool() is True
