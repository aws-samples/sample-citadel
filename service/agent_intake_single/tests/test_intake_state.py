"""Tests for intake-state progress field alignment (Bug B).

Writers store '<phase>_progress' for PHASES = assessment, design, planning,
implementation. get_intake_state previously read 'delivery_plan_progress'
(never written -> always 0). It must instead read the ACTUAL written fields.

Run with:
    PYTHONPATH=. pytest tests/test_intake_state.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tools.state as state


def test_get_intake_state_reads_actual_written_fields(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {
        "Item": {
            "phase": "planning",
            "assessment_progress": 100,
            "design_progress": 100,
            "planning_progress": 66,
            "implementation_progress": 0,
            "last_updated": 123,
        }
    }
    monkeypatch.setattr(state, "_table", lambda: table)

    result = json.loads(state.get_intake_state(session_id="s1"))

    assert result["phase"] == "planning"
    assert result["assessment_progress"] == 100
    assert result["design_progress"] == 100
    assert result["planning_progress"] == 66
    assert result["implementation_progress"] == 0
    # The never-written legacy key must be gone.
    assert "delivery_plan_progress" not in result


def test_progress_path_publishes_event_with_full_updater_payload(monkeypatch):
    """The intake.progress.updated event is the ONLY project-record write
    trigger on the progress path: backend project-progress-updater consumes
    it (nested progress.<phase> + currentPhase, monotonic, idempotent, keyed
    id=sessionId). The Detail must therefore keep carrying everything the
    updater reads — sessionId, phase, completionPercentage — plus the
    changeSummary/timestamp context fields."""
    table = mock.MagicMock()
    monkeypatch.setattr(state, "_table", lambda: table)
    events = mock.MagicMock()
    monkeypatch.setattr(state, "events_client", events)
    monkeypatch.setattr(state, "EVENT_BUS_NAME", "bus-t")

    result = state._internal_update_progress("sess-1", "design", 40, "Section drafted")

    assert result == "design progress: 40%"
    # Intake-state DDB write retained.
    table.update_item.assert_called_once()
    # Event publish retained, with the full payload the async updater needs.
    entry = events.put_events.call_args.kwargs["Entries"][0]
    assert entry["Source"] == "agent_intake.design"
    assert entry["DetailType"] == "intake.progress.updated"
    assert entry["EventBusName"] == "bus-t"
    detail = json.loads(entry["Detail"])
    assert detail["sessionId"] == "sess-1"
    assert detail["phase"] == "design"
    assert detail["completionPercentage"] == 40
    assert detail["changeSummary"] == "Section drafted"
    assert "timestamp" in detail


def test_progress_path_does_no_conversations_scan_or_project_write(monkeypatch):
    """The hot path (~30 ticks per design generation) must not Scan the
    conversations table nor write the projects table synchronously — that
    work is owned by the async project-progress-updater consumer. The
    scan/status helpers are removed outright, and the boto3 resource sees
    no Table() access beyond the (mocked) intake-state table."""
    table = mock.MagicMock()
    monkeypatch.setattr(state, "_table", lambda: table)
    monkeypatch.setattr(state, "events_client", mock.MagicMock())
    monkeypatch.setattr(state, "EVENT_BUS_NAME", "bus-t")
    # Even with project/conversation tables configured, the hot path must
    # not touch them (raising=False: the constants are removed with the
    # helpers, so there is nothing to configure post-change).
    monkeypatch.setattr(state, "PROJECTS_TABLE", "proj-t", raising=False)
    monkeypatch.setattr(state, "CONVERSATIONS_TABLE", "conv-t", raising=False)
    ddb = mock.MagicMock()
    # Terminating scan response: pre-change code paginates until a linked
    # row or a missing LastEvaluatedKey, and a bare MagicMock is truthy —
    # give it a linking row so the legacy loop exits and the assertion below
    # fails fast instead of spinning.
    ddb.Table.return_value.scan.return_value = {"Items": [{"projectId": "proj-1"}]}
    monkeypatch.setattr(state, "dynamodb", ddb)

    state._internal_update_progress("sess-1", "implementation", 70, "tick")

    # The synchronous project-status helpers are gone from the hot path.
    assert not hasattr(state, "_update_project_status")
    assert not hasattr(state, "_find_linked_project_id")
    # No conversations Scan, no projects update: the resource is untouched.
    ddb.Table.assert_not_called()


def test_get_intake_state_defaults_when_no_item(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {}
    monkeypatch.setattr(state, "_table", lambda: table)

    result = json.loads(state.get_intake_state(session_id="s1"))

    assert result["phase"] == "assessment"
    assert result["assessment_progress"] == 0
    assert result["design_progress"] == 0
    assert result["planning_progress"] == 0
    assert result["implementation_progress"] == 0
    assert "delivery_plan_progress" not in result


def test_update_intake_progress_docstring_matches_phases():
    """The documented phase names must EXACTLY match PHASES."""
    doc = state.update_intake_progress.__doc__ or ""
    for phase in state.PHASES:
        assert phase in doc
    # The rejected legacy names must be gone from the docstring.
    assert "technical_design" not in doc
    assert "delivery_plan" not in doc


# NOTE: the synchronous project-record write (monotonic floor + status) was
# removed from the progress hot path — that behavior is owned by the async
# consumer backend/src/lambda/project-progress-updater.ts, which has its own
# suite (backend/src/lambda/__tests__/project-progress-updater.test.ts)
# covering the monotonic ConditionExpression, stale-skip, and idempotency.
