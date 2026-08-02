"""
Tests for arbiter/fabricator/registry_recovery.py — bounded recovery of
AgentCore Registry records stuck in CREATING state.

Live evidence (2026-07-23): a 900s SIGKILL mid tool-registration orphaned
Registry tool records in CREATING; every subsequent
UpdateRegistryRecordStatus raised ConflictException 'Registry record cannot
be modified while in CREATING state' and the fabricator LLM retried the
tool 92-110× per run (~825-834s of the 900s budget). The record never leaves
CREATING without intervention — the condition is NON-RETRYABLE within a run.

Revised contract (post-incident-2, 2026-08-01) under test:
  - ``is_creating_conflict`` matches ONLY the poison shape: a botocore-style
    ConflictException whose message mentions the CREATING state.
  - ``recover_creating_record`` approve-in-place is the PRIMARY and ONLY
    recovery mechanism — it NEVER creates or deletes a Registry record:
      (a) poll GetRegistryRecord ≤``POLL_ATTEMPTS`` (5) checks, seconds
          apart, in case CREATING is genuinely in-flight;
      (b) if the record settles to a non-CREATING, non-``*_FAILED`` status,
          approve it IN PLACE and return the SAME recordId;
      (c) if the record settles to CREATE_FAILED/UPDATE_FAILED, or never
          settles within the poll budget, or approve itself raises: raise
          the terminal, NON-RETRYABLE ``OrphanedRegistryRecordError`` — a
          single attempt, zero net-new orphans (no delete, no recreate).
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
    """Records sleep durations and approve invocations."""

    def __init__(self):
        self.sleeps = []
        self.approved = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    def approve(self, record_id):
        self.approved.append(record_id)


def _recover(client, rec, **overrides):
    kwargs = dict(
        registry_id="reg-1",
        record_id="rec-old",
        name="my_tool",
        approve=rec.approve,
        sleep=rec.sleep,
    )
    kwargs.update(overrides)
    return recover_creating_record(client, **kwargs)


class TestPollResolvesInFlightCreating:
    def test_status_settles_then_approves_same_record(self):
        # CREATING was genuinely in-flight: first check still CREATING,
        # second check DRAFT → approve the SAME record; zero net-new.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        result = _recover(client, rec)

        assert result == "rec-old"
        assert rec.approved == ["rec-old"]
        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_not_called()

    def test_poll_checks_are_seconds_apart_and_bounded(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        _recover(client, rec)

        assert rec.sleeps == [POLL_INTERVAL_SECONDS, POLL_INTERVAL_SECONDS]
        assert client.get_registry_record.call_count == 2

    def test_settles_on_first_check_uses_single_poll(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [{"status": "DRAFT"}]

        result = _recover(client, rec)

        assert result == "rec-old"
        assert client.get_registry_record.call_count == 1
        assert rec.sleeps == [POLL_INTERVAL_SECONDS]

    def test_longer_budget_settles_on_fifth_poll(self):
        # Raised poll budget (POLL_ATTEMPTS=5): CREATING for the first 4
        # checks then DRAFT on the 5th → approve in place, no failure.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [
            {"status": "CREATING"},
            {"status": "CREATING"},
            {"status": "CREATING"},
            {"status": "CREATING"},
            {"status": "DRAFT"},
        ]

        result = _recover(client, rec)

        assert result == "rec-old"
        assert rec.approved == ["rec-old"]
        assert client.get_registry_record.call_count == 5
        assert POLL_ATTEMPTS == 5


class TestFailFastTerminal:
    def test_never_settles_raises_terminal_with_zero_net_new(self):
        # Stuck in CREATING for the entire poll budget → terminal error;
        # NO delete, NO recreate, NO approve attempted — the original
        # record is the only record that exists, unmodified.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.return_value = {"status": "CREATING"}

        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec)

        message = str(exc_info.value)
        assert "my_tool" in message
        assert "rec-old" in message
        assert "NON-RETRYABLE" in message
        assert "DO NOT retry" in message
        assert client.get_registry_record.call_count == POLL_ATTEMPTS
        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_not_called()
        assert rec.approved == []

    def test_settles_to_create_failed_raises_terminal_without_approving(self):
        # Creation genuinely failed service-side: PENDING_APPROVAL is
        # unreachable from CREATE_FAILED, so approve must NOT be attempted.
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [{"status": "CREATE_FAILED"}]

        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec)

        assert "CREATE_FAILED" in str(exc_info.value)
        assert rec.approved == []
        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_not_called()

    def test_settles_to_update_failed_raises_terminal_without_approving(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = [{"status": "UPDATE_FAILED"}]

        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec)

        assert "UPDATE_FAILED" in str(exc_info.value)
        assert rec.approved == []

    def test_approve_raises_after_settle_is_terminal_single_attempt(self):
        # Settled to a usable-looking status but approve itself raises
        # (e.g. an unexpected settled status or a raced-back conflict):
        # terminal immediately — no fallback, no second attempt.
        client = MagicMock()
        client.get_registry_record.side_effect = [{"status": "DRAFT"}]

        def failing_approve(record_id):
            raise _client_error(
                "ValidationException", "Invalid source status"
            )

        rec = _Recorder()
        with pytest.raises(OrphanedRegistryRecordError) as exc_info:
            _recover(client, rec, approve=failing_approve)

        assert "my_tool" in str(exc_info.value)
        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_not_called()

    def test_poll_infrastructure_error_raises_terminal(self):
        rec = _Recorder()
        client = MagicMock()
        client.get_registry_record.side_effect = _client_error(
            "AccessDeniedException", "no", "GetRegistryRecord"
        )

        with pytest.raises(OrphanedRegistryRecordError):
            _recover(client, rec)

        client.delete_registry_record.assert_not_called()
        client.create_registry_record.assert_not_called()
