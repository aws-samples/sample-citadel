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


def test_update_project_status_finds_linked_row_beyond_first_scan_page(monkeypatch):
    """Same latent bug as the resolver/postfab lookups: a single-page scan
    with Limit caps items EVALUATED pre-filter, so the conversation row that
    links the session to its project is routinely missed once the table
    grows. _update_project_status must follow LastEvaluatedKey."""
    conv_table = mock.MagicMock()
    conv_table.scan.side_effect = [
        {"Items": [], "LastEvaluatedKey": {"projectId": "other", "timestamp": "t1"}},
        {"Items": [{"projectId": "proj-1"}]},
    ]
    proj_table = mock.MagicMock()
    ddb = mock.MagicMock()
    ddb.Table.side_effect = lambda name: conv_table if name == "conv-t" else proj_table
    monkeypatch.setattr(state, "dynamodb", ddb)
    monkeypatch.setattr(state, "CONVERSATIONS_TABLE", "conv-t")
    monkeypatch.setattr(state, "PROJECTS_TABLE", "proj-t")

    state._update_project_status("sess-1", "assessment", 100)

    # Pagination proof: the second scan continues from LastEvaluatedKey.
    assert conv_table.scan.call_count == 2
    second_kwargs = conv_table.scan.call_args_list[1].kwargs
    assert second_kwargs["ExclusiveStartKey"] == {"projectId": "other", "timestamp": "t1"}
    # The project update targets the page-2 linked projectId, not the session id.
    update_keys = [c.kwargs["Key"] for c in proj_table.update_item.call_args_list]
    assert {"id": "proj-1"} in update_keys
    assert {"id": "sess-1"} not in update_keys


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


# --- monotonic floor on the project record (mirrors project-progress-updater) ---


def _floor_tables(monkeypatch):
    """Projects/conversations table pair with a direct session->project link."""
    conv_table = mock.MagicMock()
    conv_table.scan.return_value = {"Items": [{"projectId": "proj-1"}]}
    proj_table = mock.MagicMock()
    ddb = mock.MagicMock()
    ddb.Table.side_effect = lambda name: conv_table if name == "conv-t" else proj_table
    monkeypatch.setattr(state, "dynamodb", ddb)
    monkeypatch.setattr(state, "CONVERSATIONS_TABLE", "conv-t")
    monkeypatch.setattr(state, "PROJECTS_TABLE", "proj-t")
    return proj_table


class _ConditionalCheckFailedException(Exception):
    """Mimics botocore's conditional-check error (matched by class name)."""


def test_update_project_status_guards_progress_with_monotonic_condition(monkeypatch):
    """The progress write must carry a ConditionExpression so implementation
    (and every phase) can never regress — e.g. the Phase 7 prompt's
    post-confirm update must not lower a higher fabrication value."""
    proj_table = _floor_tables(monkeypatch)

    state._update_project_status("sess-1", "implementation", 70)

    first_update = proj_table.update_item.call_args_list[0].kwargs
    assert first_update["ConditionExpression"] == (
        "attribute_not_exists(progress.#phase) OR progress.#phase < :prog"
    )
    assert first_update["ExpressionAttributeNames"]["#phase"] == "implementation"
    assert first_update["ExpressionAttributeValues"][":prog"] == 70


def test_update_project_status_skips_status_write_when_progress_is_stale(monkeypatch):
    """A conditional failure means the caller is stale (lower-or-equal
    progress). The status write must be skipped too — otherwise a stale
    milestone could flip a COMPLETED project back to IN_PROGRESS."""
    proj_table = _floor_tables(monkeypatch)
    proj_table.update_item.side_effect = _ConditionalCheckFailedException("stale")

    # Must not raise.
    state._update_project_status("sess-1", "implementation", 10)

    # Only the (failed) progress update was attempted — no status write.
    assert proj_table.update_item.call_count == 1


def test_update_project_status_still_writes_status_on_fresh_progress(monkeypatch):
    proj_table = _floor_tables(monkeypatch)

    state._update_project_status("sess-1", "implementation", 100)

    assert proj_table.update_item.call_count == 2
    status_update = proj_table.update_item.call_args_list[1].kwargs
    assert status_update["ExpressionAttributeValues"][":s"] == "COMPLETED"
