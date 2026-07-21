"""Tests for activate_agents (tools/postfab.py).

Contract:
- Calls the intakeActivateProjectAgents mutation via the SigV4 client.
- Itemized results copy: activated / alreadyActive / failed per agent, one
  clear next action; matchedBy=null -> the approved zero-activated explanation.
- Idempotent via the intake:postfab marker: a second call makes NO mutation
  and returns the already-done copy with current state.
- Errors return the nothing-has-been-changed copy; never raw error text.
- Every return carries the next gate's consent question.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_activation.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")

import tools.postfab as postfab
from tools.appsync_client import AppSyncError


@pytest.fixture
def marker_store(monkeypatch):
    store = {"sess-1": {"stage": "built"}}

    def fake_get(session_id):
        return dict(store.get(session_id, {}))

    def fake_set(session_id, **updates):
        merged = store.setdefault(session_id, {})
        merged.update(updates)
        return dict(merged)

    monkeypatch.setattr(postfab, "get_postfab_marker", fake_get)
    monkeypatch.setattr(postfab, "set_postfab_marker", fake_set)
    return store


@pytest.fixture
def execute(monkeypatch):
    ex = mock.MagicMock()
    monkeypatch.setattr(postfab.appsync_client, "execute", ex)
    monkeypatch.setattr(postfab, "_propose_app_name", lambda sid: "Acme Claims")
    return ex


def _activation(activated=(), failed=(), already=(), matched_by="sessionId"):
    return {"intakeActivateProjectAgents": {
        "activated": list(activated), "failed": list(failed),
        "alreadyActive": list(already), "matchedBy": matched_by,
    }}


def _contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions")
    for action in result["actions"]:
        assert all(ord(ch) < 0x2000 for ch in action["label"])


def test_full_success_reports_and_asks_app_creation(execute, marker_store):
    execute.return_value = _activation(activated=["A", "B"])

    result = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert result["ok"] is True
    assert "2" in result["summary"] and "active" in result["summary"]
    assert "agent list" in result["summary"]
    assert "Acme Claims" in result["consent_question"]
    assert marker_store["sess-1"]["stage"] == "activated"
    assert marker_store["sess-1"]["activation"]["activated"] == ["A", "B"]
    kwargs = execute.call_args.kwargs
    args = execute.call_args.args
    variables = kwargs.get("variables") or args[1]
    assert variables == {"sessionId": "sess-1"}
    _contract(result)


def test_already_active_itemized(execute, marker_store):
    execute.return_value = _activation(activated=["A"], already=["B"])

    result = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert result["ok"] is True
    assert "already active" in result["summary"]
    _contract(result)


def test_partial_failure_itemized_with_plain_reason(execute, marker_store):
    execute.return_value = _activation(activated=["A", "B"], failed=["C"])

    result = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert result["ok"] is True
    assert "2 of 3" in result["summary"]
    assert "'C'" in result["summary"]
    assert "couldn't be activated" in result["summary"]
    labels = [a["label"] for a in result["actions"]]
    assert any("Stop here" == label for label in labels)
    _contract(result)


def test_zero_matched_returns_approved_explanation(execute, marker_store):
    execute.return_value = _activation(matched_by=None)

    result = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert result["status"] == "zero_matched"
    assert "couldn't match" in result["summary"].lower()
    assert "nothing has been changed" in result["summary"].lower()
    # stage must NOT advance to activated
    assert marker_store["sess-1"].get("stage") != "activated"
    _contract(result)


def test_idempotent_second_call_makes_no_mutation(execute, marker_store):
    execute.return_value = _activation(activated=["A"])

    first = json.loads(postfab.activate_agents(session_id="sess-1"))
    second = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert execute.call_count == 1
    assert first["ok"] is True
    assert second["ok"] is True
    assert second["status"] == "already_done"
    assert "already" in second["summary"].lower()
    _contract(second)


def test_appsync_error_returns_nothing_changed_copy(execute, marker_store):
    execute.side_effect = AppSyncError("boom internal detail XYZZY", retryable=True)

    result = json.loads(postfab.activate_agents(session_id="sess-1"))

    assert result["ok"] is False
    assert result["retryable"] is True
    assert "nothing has been changed" in result["summary"].lower()
    assert "XYZZY" not in json.dumps(result)  # raw error text never surfaced
    assert marker_store["sess-1"].get("stage") == "built"
    labels = [a["label"] for a in result["actions"]]
    assert "Try again" in labels and "Stop here" in labels
    _contract(result)
