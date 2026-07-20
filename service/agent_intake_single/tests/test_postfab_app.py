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
    # Proposals are pre-sanitized to the registry-safe form ('Acme Claims'
    # would be rejected by the registry name constraint — spaces are illegal).
    assert result["proposed_name"] == "Acme-Claims"
    execute.assert_not_called()
    assert "Acme-Claims" in result["consent_question"]
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


def test_created_summary_surfaces_linked_agents(execute, marker_store, monkeypatch):
    # The backend binds the session's activated agents at creation; when the
    # result carries them, the copy tells the user how many were linked.
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Acme Claims"})
    execute.return_value = {"intakeCreateApp": {
        "appId": "app-9", "name": "My Custom App", "status": "DRAFT",
        "agentBindings": [{"agentId": "rec-a"}, {"agentId": "rec-b"}],
    }}

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My Custom App"))

    assert result["ok"] is True
    assert "linked 2 agents" in result["summary"]
    assert result["linked_agents"] == 2
    _contract(result)


def test_created_summary_singular_for_one_linked_agent(execute, marker_store, monkeypatch):
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Acme Claims"})
    execute.return_value = {"intakeCreateApp": {
        "appId": "app-9", "name": "My Custom App", "status": "DRAFT",
        "agentBindings": [{"agentId": "rec-a"}],
    }}

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My Custom App"))

    assert "linked 1 agent" in result["summary"]
    assert "linked 1 agents" not in result["summary"]
    assert result["linked_agents"] == 1


def test_created_summary_unchanged_when_no_bindings_returned(execute, marker_store, monkeypatch):
    # Older backend / zero session agents: the structured field is absent and
    # the copy stays exactly the established created sentence.
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Acme Claims"})
    execute.return_value = {"intakeCreateApp": {"appId": "app-9", "name": "My Custom App", "status": "DRAFT"}}

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My Custom App"))

    assert "linked" not in result["summary"]
    assert "linked_agents" not in result


def test_create_app_mutation_selects_agent_bindings(execute, marker_store):
    # The GraphQL document must request the bindings for the copy above —
    # pinned against the schema by the backend cross-layer contract test.
    assert "agentBindings" in postfab._CREATE_APP_MUTATION
    assert "agentId" in postfab._CREATE_APP_MUTATION


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


def test_timeout_returns_standard_failure_envelope_with_try_again(execute, marker_store, monkeypatch):
    """Client timeout on createApp (no auto-retry — the mutation is
    non-idempotent): the tool relays the standard failure envelope with the
    'Try again' consent. The server-side sourceProjectId idempotency guard
    makes a user-consented retry safe."""
    from tools.appsync_client import AppSyncTransportError

    _project_tables(monkeypatch, [], None)
    execute.side_effect = AppSyncTransportError(
        "Network error calling AppSync for intakeCreateApp: ReadTimeout",
        retryable=True, error_type="ReadTimeout", timed_out=True,
    )

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="My App"))

    assert result["ok"] is False
    assert result["retryable"] is True
    assert "nothing has been changed" in result["summary"].lower()
    labels = [a["label"] for a in result["actions"]]
    assert "Try again" in labels
    assert "Stop here" in labels
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
    # Registry-safe pre-sanitized proposal (see the naming tests below).
    assert result["proposed_name"] == "Acme-Claims"
    # Pagination proof: the second scan continues from LastEvaluatedKey.
    assert conv_table.scan.call_count == 2
    second_kwargs = conv_table.scan.call_args_list[1].kwargs
    assert second_kwargs["ExclusiveStartKey"] == {"projectId": "other", "timestamp": "t1"}
    # The project lookup used the page-2 linked projectId, not the session id.
    proj_table.get_item.assert_called_once_with(Key={"id": "proj-1"})


def test_proposal_presanitizes_project_name_to_registry_safe_form(execute, marker_store, monkeypatch):
    """The registry rejects names with spaces (^[a-zA-Z0-9][a-zA-Z0-9_\\-./]*$),
    so the consent gate must show the registry-safe name that will actually
    be created — not the raw project name."""
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Test - Ingest"})

    result = json.loads(postfab.create_agent_app(session_id="sess-1"))

    assert result["status"] == "proposal"
    assert result["proposed_name"] == "Test-Ingest"
    assert "Test-Ingest" in result["consent_question"]
    assert "Test - Ingest" not in result["consent_question"]
    execute.assert_not_called()
    _contract(result)


def test_proposal_dated_fallback_is_registry_safe(execute, marker_store, monkeypatch):
    """The dated fallback ('Intake Request YYYY-MM-DD') carried spaces too —
    the proposal must always satisfy the registry name constraint."""
    import re

    _project_tables(monkeypatch, [], None)

    result = json.loads(postfab.create_agent_app(session_id="sess-1"))

    assert result["status"] == "proposal"
    assert re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$", result["proposed_name"])
    _contract(result)


def test_marker_and_copy_store_server_returned_name_not_input(execute, marker_store, monkeypatch):
    """The server sanitizes the name it actually creates; the marker and the
    conversational copy must echo the RETURNED name, never the raw input."""
    _project_tables(monkeypatch, [{"projectId": "proj-1"}], {"name": "Test - Ingest"})
    execute.return_value = {
        "intakeCreateApp": {"appId": "app-9", "name": "Test-Ingest", "status": "DRAFT"}
    }

    result = json.loads(postfab.create_agent_app(session_id="sess-1", confirmed_name="Test - Ingest"))

    assert result["ok"] is True
    assert marker_store["sess-1"]["appName"] == "Test-Ingest"
    assert result["app_name"] == "Test-Ingest"
    assert "Created the app 'Test-Ingest'" in result["summary"]
    assert "Test - Ingest" not in result["summary"]
    _contract(result)
