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
