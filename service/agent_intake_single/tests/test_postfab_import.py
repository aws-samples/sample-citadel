"""Tests for import_blueprint_to_app (tools/postfab.py).

Contract:
- Calls intakeImportBlueprintToApp with the marker's blueprintId/appId.
- Result copy includes where-to-see-it: 'Workflows tab of <app>, saved as a
  draft'.
- Success and already_done carry a structured next_steps list ordering
  workflow publish before app Activate before app Publish, with the
  one-time API-key warning.
- Final gate offers 'Show me how to publish' (guidance), never a publish
  action with no backing tool.
- Idempotent via marker.workflowId; requires blueprint + app steps first.
  The already_done branch still re-issues the idempotent mutation so the
  backend heals missing app agent bindings (best-effort, never an error).
- Errors return the nothing-changed copy.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_import.py -q
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
    store = {"sess-1": {
        "stage": "blueprint_created", "appId": "app-9",
        "appName": "Acme Claims", "blueprintId": "bp-1",
    }}

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
    ex.return_value = {"intakeImportBlueprintToApp": {
        "workflowId": "wf-1", "name": "Acme Claims Process", "status": "DRAFT",
    }}
    monkeypatch.setattr(postfab.appsync_client, "execute", ex)
    return ex


def _contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions")
    for action in result["actions"]:
        assert all(ord(ch) < 0x2000 for ch in action["label"])


def test_import_success_says_where_to_see_it(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert result["ok"] is True
    assert "Workflows tab of 'Acme Claims'" in result["summary"]
    assert "draft" in result["summary"]
    variables = execute.call_args.args[1]
    assert variables["sessionId"] == "sess-1"
    assert variables["blueprintId"] == "bp-1"
    assert variables["appId"] == "app-9"
    _contract(result)


def test_marker_updated_with_workflow_id(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert result["workflow_id"] == "wf-1"
    assert marker_store["sess-1"]["stage"] == "workflow_imported"
    assert marker_store["sess-1"]["workflowId"] == "wf-1"


def test_idempotent_second_call_heals_via_backend_without_duplicating(execute, marker_store):
    # The already_done branch STILL calls the (idempotent) mutation: the
    # backend returns the existing workflow instead of duplicating it AND
    # re-ensures the app's agent bindings — this is what heals a live app
    # whose workflow was imported before bindings existed, when the user
    # re-triggers the import conversationally.
    first = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))
    second = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert execute.call_count == 2
    variables = execute.call_args.args[1]
    assert variables["blueprintId"] == "bp-1"
    assert variables["appId"] == "app-9"
    assert first["ok"] is True
    assert second["ok"] is True
    assert second["status"] == "already_done"
    assert "already" in second["summary"].lower()
    assert second["workflow_id"] == "wf-1"
    _contract(second)


def test_already_done_still_returns_when_heal_call_fails(execute, marker_store):
    # Healing is best-effort: the workflow IS imported, so a failing backend
    # call must not turn the already_done answer into an error.
    marker_store["sess-1"].update({"stage": "workflow_imported", "workflowId": "wf-1"})
    execute.side_effect = AppSyncError("raw internal FROBOZZ", retryable=True)

    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert result["ok"] is True
    assert result["status"] == "already_done"
    assert result["workflow_id"] == "wf-1"
    assert "FROBOZZ" not in json.dumps(result)
    _contract(result)


def test_requires_blueprint_first(execute, marker_store):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-9", "appName": "Acme Claims"}

    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert result["ok"] is False
    execute.assert_not_called()
    assert "blueprint" in result["consent_question"].lower()
    _contract(result)


def test_error_returns_nothing_changed_copy(execute, marker_store):
    execute.side_effect = AppSyncError("raw internal FROBOZZ", retryable=True)

    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert result["ok"] is False
    assert result["retryable"] is True
    assert "nothing has been changed" in result["summary"].lower()
    assert "FROBOZZ" not in json.dumps(result)
    assert marker_store["sess-1"].get("workflowId") is None
    _contract(result)


def _step_index(steps, needle):
    """Index of the first step containing needle (case-insensitive)."""
    for i, step in enumerate(steps):
        if needle in step.lower():
            return i
    raise AssertionError(f"no step contains {needle!r}: {steps}")


def test_success_carries_ordered_next_steps_to_published(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    steps = result["next_steps"]
    assert isinstance(steps, list) and all(isinstance(s, str) and s for s in steps)
    workflow_publish = _step_index(steps, "publish the workflow")
    app_activate = _step_index(steps, "activate")
    app_publish = _step_index(steps, "confirm publish")
    assert workflow_publish < app_activate < app_publish
    _contract(result)


def test_success_next_steps_warn_api_key_shown_only_once(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    joined = " ".join(result["next_steps"]).lower()
    assert "api key" in joined
    assert "only once" in joined


def test_final_gate_offers_publish_guidance_not_unbacked_publish(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    labels = [a["label"] for a in result["actions"]]
    assert "Show me how to publish" in labels
    show = next(a for a in result["actions"] if a["label"] == "Show me how to publish")
    assert show["value"] == "Show me the steps to publish the workflow and the app"
    serialized = json.dumps(result["actions"]).lower()
    assert "without reviewing" not in serialized


def test_already_done_carries_same_next_steps(execute, marker_store):
    first = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))
    second = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert second["status"] == "already_done"
    assert second["next_steps"] == first["next_steps"]
    _contract(second)


def test_summary_points_at_publish_steps_and_recap_mentions_endpoint_key(execute, marker_store):
    result = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    # keep the existing where-to-see-it sentence
    assert "Workflows tab of 'Acme Claims'" in result["summary"]
    assert "draft" in result["summary"]
    # one-sentence pointer at the publish path
    assert "steps to publish" in result["summary"].lower()
    recap = result["recap"].lower()
    assert "endpoint" in recap
    assert "api key" in recap
