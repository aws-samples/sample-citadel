"""Tests for import_blueprint_to_app (tools/postfab.py).

Contract:
- Calls intakeImportBlueprintToApp with the marker's blueprintId/appId.
- Result copy includes where-to-see-it: 'Workflows tab of <app>, saved as a
  draft'.
- Idempotent via marker.workflowId; requires blueprint + app steps first.
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


def test_idempotent_second_call_makes_no_mutation(execute, marker_store):
    first = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))
    second = json.loads(postfab.import_blueprint_to_app(session_id="sess-1"))

    assert execute.call_count == 1
    assert second["status"] == "already_done"
    assert "already" in second["summary"].lower()
    _contract(second)


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
