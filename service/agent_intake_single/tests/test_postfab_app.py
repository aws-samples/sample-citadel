"""Tests for create_agent_app (tools/postfab.py).

Contract (propose-then-create):
- Without confirmed_name: returns the PROPOSAL string only — NO mutation.
  Name proposed from project linkage (conversations -> projectId ->
  projects.name), falling back to a dated intake name.
- With confirmed_name: calls intakeCreateApp and updates the marker.
- Idempotent via marker.appId; errors return the nothing-changed copy.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_app.py -q
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
    store = {"sess-1": {"stage": "activated"}}

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
    return ex


def _project_tables(monkeypatch, conv_items, project_item):
    conv_table = mock.MagicMock()
    conv_table.scan.return_value = {"Items": conv_items}
    proj_table = mock.MagicMock()
    proj_table.get_item.return_value = {"Item": project_item} if project_item else {}
    ddb = mock.MagicMock()
    ddb.Table.side_effect = lambda name: conv_table if name == "conv-t" else proj_table
    monkeypatch.setattr(postfab, "dynamodb", ddb)
    monkeypatch.setattr(postfab, "CONVERSATIONS_TABLE", "conv-t")
    monkeypatch.setattr(postfab, "PROJECTS_TABLE", "proj-t")


def _contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions")
    for action in result["actions"]:
        assert all(ord(ch) < 0x2000 for ch in action["label"])


def test_no_confirmed_name_returns_proposal_without_mutation(execute, marker_store, monkeypatch):
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Acme Claims"})

    result = json.loads(postfab.create_agent_app(session_id="sess-1"))

    assert result["status"] == "proposal"
    assert result["proposed_name"] == "Acme Claims"
    execute.assert_not_called()
    assert "Acme Claims" in result["consent_question"]
    assert marker_store["sess-1"].get("appId") is None
    _contract(result)


def test_proposal_falls_back_to_dated_name(execute, marker_store, monkeypatch):
    _project_tables(monkeypatch, [], None)

    result = json.loads(postfab.create_agent_app(session_id="sess-1"))

    assert result["status"] == "proposal"
    assert result["proposed_name"].startswith("Intake")
    execute.assert_not_called()
    _contract(result)


def test_confirmed_name_creates_app_and_updates_marker(execute, marker_store, monkeypatch):
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Acme Claims"})
    execute.return_value = {"intakeCreateApp": {"appId": "app-9", "name": "My Custom App", "status": "DRAFT"}}

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My Custom App"))

    assert result["ok"] is True
    assert result["app_id"] == "app-9"
    assert "Created the app 'My Custom App'" in result["summary"]
    assert "Apps list" in result["summary"]
    assert "blueprint" in result["consent_question"].lower()
    assert marker_store["sess-1"]["stage"] == "app_created"
    assert marker_store["sess-1"]["appId"] == "app-9"
    assert marker_store["sess-1"]["appName"] == "My Custom App"
    variables = execute.call_args.args[1]
    assert variables["sessionId"] == "sess-1"
    assert variables["name"] == "My Custom App"
    _contract(result)


def test_idempotent_when_app_already_created(execute, marker_store):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-9", "appName": "Acme Claims"}

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="Acme Claims"))

    execute.assert_not_called()
    assert result["status"] == "already_done"
    assert "Acme Claims" in result["summary"]
    _contract(result)


def test_error_returns_nothing_changed_copy(execute, marker_store, monkeypatch):
    _project_tables(monkeypatch, [], None)
    execute.side_effect = AppSyncError("internal PLUGH", retryable=False)

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My App"))

    assert result["ok"] is False
    assert result["retryable"] is False
    assert "nothing has been changed" in result["summary"].lower()
    assert "PLUGH" not in json.dumps(result)
    assert marker_store["sess-1"].get("appId") is None
    _contract(result)


def test_proposal_finds_linked_row_beyond_first_scan_page(execute, marker_store, monkeypatch):
    """Scan's Limit caps items EVALUATED pre-filter, so the linked row is
    routinely beyond page 1 once the conversations table grows. The lookup
    must follow LastEvaluatedKey until the row is found."""
    conv_table = mock.MagicMock()
    conv_table.scan.side_effect = [
        {"Items": [], "LastEvaluatedKey": {"projectId": "other", "timestamp": "t1"}},
        {"Items": [{"projectId": "proj-1"}]},
    ]
    proj_table = mock.MagicMock()
    proj_table.get_item.return_value = {"Item": {"name": "Acme Claims"}}
    ddb = mock.MagicMock()
    ddb.Table.side_effect = lambda name: conv_table if name == "conv-t" else proj_table
    monkeypatch.setattr(postfab, "dynamodb", ddb)
    monkeypatch.setattr(postfab, "CONVERSATIONS_TABLE", "conv-t")
    monkeypatch.setattr(postfab, "PROJECTS_TABLE", "proj-t")

    result = json.loads(postfab.create_agent_app(session_id="sess-1"))

    assert result["status"] == "proposal"
    assert result["proposed_name"] == "Acme Claims"
    # Pagination proof: the second scan continues from LastEvaluatedKey.
    assert conv_table.scan.call_count == 2
    second_kwargs = conv_table.scan.call_args_list[1].kwargs
    assert second_kwargs["ExclusiveStartKey"] == {"projectId": "other", "timestamp": "t1"}
    # The project lookup used the page-2 linked projectId, not the session id.
    proj_table.get_item.assert_called_once_with(Key={"id": "proj-1"})
