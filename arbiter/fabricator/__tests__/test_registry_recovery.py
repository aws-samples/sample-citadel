"""
Tests for arbiter/fabricator/registry_recovery.py — bounded recovery of
AgentCore Registry records stuck in CREATING state.

Live evidence (2026-07-23): a 900s SIGKILL mid tool-registration orphaned
Registry tool records in CREATING; every subsequent
UpdateRegistryRecordStatus raised ConflictException 'Registry record cannot
be modified while in CREATING state' and the fabricator LLM retried the
tool 92-110× (~825-834s of the 900s budget). The record never leaves
CREATING without intervention — the condition is NON-RETRYABLE within a run.

Contract under test:
  - ``is_creating_conflict`` matches ONLY the poison shape: a botocore-style
    ConflictException whose message mentions the CREATING state.
  - ``recover_creating_record`` follows the documented recovery path,
    strictly bounded (never spins):
      (a) poll GetRegistryRecord ≤2 checks, seconds apart, in case CREATING
          is genuinely in-flight → approve and return the same recordId;
      (b) delete-and-recreate: DeleteRegistryRecord (supported by the
          bedrock-agentcore-control SDK; deletion is asynchronous), wait ≤2
          checks for the record to disappear, recreate, approve;
      (d) any recovery step failing → OrphanedRegistryRecordError — a
          terminal, user-actionable error naming the orphaned record.
  - ``OrphanedRegistryRecordError`` is an ordinary Exception (it must reach
    the LLM as a tool error) whose message says NON-RETRYABLE / DO NOT
    retry, so the model does not re-enter the retry spiral.
"""

import sys
import os
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from registry_recovery import (
    POLL_ATTEMPTS,
    POLL_INTERVAL_SECONDS,
    OrphanedRegistryRecordError,
    is_creating_conflict,
    recover_creating_record,
)

LIVE_CONFLICT_MESSAGE = (
    "Registry record cannot be modified while in CREATING state."
)


def _client_error(code, message, operation="UpdateRegistryRecordStatus"):
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


def _creating_conflict():
    return _client_error("ConflictException", LIVE_CONFLICT_MESSAGE)


def _not_found():
    return _client_error(
        "ResourceNotFoundException", "Record not found", "GetRegistryRecord"
    )


# ---------------------------------------------------------------------------
# is_creating_conflict
# ---------------------------------------------------------------------------

class TestIsCreatingConflict:
    def test_true_for_live_conflict_shape(self):
        assert is_creating_conflict(_creating_conflict()) is True

    def test_false_for_conflict_without_creating_mention(self):
        err = _client_error("ConflictException", "Record is being updated")
        assert is_creating_conflict(err) is False

    def test_false_for_other_codes_even_with_creating_text(self):
        err = _client_error("ValidationException", LIVE_CONFLICT_MESSAGE)
        assert is_creating_conflict(err) is False

    def test_false_for_plain_exception(self):
        assert is_creating_conflict(RuntimeError(LIVE_CONFLICT_MESSAGE)) is False


# ---------------------------------------------------------------------------
# recover_creating_record
# ---------------------------------------------------------------------------

class _Recorder:
    """Records sleep durations and approve/recreate invocations."""

    def __init__(self):
        self.sleeps = []
        self.approved = []
        self.recreated = 0

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    def approve(self, record_id):
        self.approved.append(record_id)

    def recreate(self):
        self.recreated += 1
        return f"rec-new-{self.recreated}"


def _recover(client, rec, **overrides):
    kwargs = dict(
        registry_id="reg-1",
        record_id="rec-old",
        name="my_tool",
        recreate=rec.recreate,
        approve=rec.approve,
        sleep=rec.sleep,
    )
    kwargs.update(overrides)
    return recover_creating_record(client, **kwargs)


class TestPollResolvesInFlightCreating:
    def test_status_settles_then_approves_same_record(self):
        # (a) CREATING was genuinely in-flight: first check still CREATING,
        # second check DRAFT → approve the SAME record; no delete/recreate.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        result = _recover(client, rec)

        assert result == "rec-old"
        assert rec.approved == ["rec-old"]
        assert rec.recreated == 0
        client.delete_registry_record.assert_not_called()

    def test_poll_checks_are_seconds_apart_and_bounded(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        _recover(client, rec)

        assert rec.sleeps == [POLL_INTERVAL_SECONDS, POLL_INTERVAL_SECONDS]
        assert client.get_registry_record.call_count == POLL_ATTEMPTS

    def test_settles_on_first_check_uses_single_poll(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [{"status": "DRAFT"}]

        result = _recover(client, rec)

        assert result == "rec-old"
        assert client.get_registry_record.call_count == 1
        assert rec.sleeps == [POLL_INTERVAL_SECONDS]


class TestDeleteAndRecreate:
    def test_stuck_creating_is_deleted_and_recreated_then_approved(self):
        # (b) record never leaves CREATING → delete (async) → gone on the
        # first deletion check → recreate → approve the NEW record.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},   # poll 1
            {"status": "CREATING"},   # poll 2 — still stuck: orphaned
            _not_found(),             # deletion check: record gone
        ]

        result = _recover(client, rec)

        assert result == "rec-new-1"
        client.delete_registry_record.assert_called_once_with(
            registryId="reg-1", recordId="rec-old"
        )
        assert rec.recreated == 1
        assert rec.approved == ["rec-new-1"]

    def test_deletion_wait_tolerates_deleting_status(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},   # poll 1
            {"status": "CREATING"},   # poll 2
            {"status": "DELETING"},   # deletion check 1: async delete running
            _not_found(),             # deletion check 2: gone
        ]

        result = _recover(client, rec)

        assert result == "rec-new-1"
        # 2 poll sleeps + 2 deletion-wait sleeps, all bounded.
        assert rec.sleeps == [POLL_INTERVAL_SECONDS] * 4

    def test_record_already_gone_when_polled_skips_delete(self):
        # The orphan vanished between the conflict and our poll (e.g. an
        # operator deleted it): go straight to recreate + approve.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [_not_found()]

        result = _recover(client, rec)

        assert result == "rec-new-1"
        client.delete_registry_record.assert_not_called()
        assert rec.approved == ["rec-new-1"]


class TestFailFastTerminal:
    def test_delete_refused_raises_terminal_orphaned_error(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "CREATING"},
        ]
        client.delete_registry_record.side_effect = _client_error(
            "ConflictException",
            "Registry record cannot be deleted while in CREATING state.",
            "DeleteRegistryRecord",
        )

        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec)

        message = str(exc_info.value)
        assert "my_tool" in message
        assert "rec-old" in message
        assert "NON-RETRYABLE" in message
        assert "DO NOT retry" in message
        assert rec.recreated == 0

    def test_record_never_disappears_after_delete_raises_terminal(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},   # poll 1
            {"status": "CREATING"},   # poll 2
            {"status": "DELETING"},   # deletion check 1
            {"status": "DELETING"},   # deletion check 2 — still there
        ]

        with pytest.raises(OrphanedRegistryRecordError):
            _recover(client, rec)

        assert rec.recreated == 0
        # Strictly bounded: no further get calls beyond 2 polls + 2 checks.
        assert client.get_registry_record.call_count == 4

    def test_recreate_failure_raises_terminal(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "CREATING"},
            _not_found(),
        ]

        def failing_recreate():
            raise _client_error(
                "ConflictException", "name already exists", "CreateRegistryRecord"
            )

        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec, recreate=failing_recreate)

        assert "my_tool" in str(exc_info.value)

    def test_approve_after_recreate_failing_cleans_up_and_raises_terminal(self):
        # Never leave a FRESH orphan behind: if the recreated record can't be
        # approved either, best-effort delete it before failing terminally.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "CREATING"},
            _not_found(),
        ]

        def failing_approve(record_id):
            raise _creating_conflict()

        with pytest.raises(OrphanedRegistryRecordError):
            _recover(client, rec, approve=failing_approve)

        client.delete_registry_record.assert_any_call(
            registryId="reg-1", recordId="rec-new-1"
        )

    def test_poll_infrastructure_error_raises_terminal(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = _client_error(
            "AccessDeniedException", "no", "GetRegistryRecord"
        )

        with pytest.raises(OrphanedRegistryRecordError):
            _recover(client, rec)


class TestApproveAfterSettleFallsBackToRecreate:
    def test_settled_but_unusable_record_falls_back_to_delete_recreate(self):
        # The record left CREATING but landed somewhere unusable
        # (e.g. CREATE_FAILED) — approve fails → delete-and-recreate.
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATE_FAILED"},  # poll 1: settled but broken
            _not_found(),                  # deletion check: gone
        ]
        rec = _Recorder()
        calls = {"n": 0}

        def approve_first_fails(record_id):
            calls["n"] += 1
            if record_id == "rec-old":
                raise _client_error(
                    "ValidationException", "Invalid source status", "UpdateRegistryRecordStatus"
                )
            rec.approve(record_id)

        result = _recover(client, rec, approve=approve_first_fails)

        assert result == "rec-new-1"
        client.delete_registry_record.assert_called_once_with(
            registryId="reg-1", recordId="rec-old"
        )
        assert rec.approved == ["rec-new-1"]
