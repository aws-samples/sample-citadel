"""Tests for the post-fabrication Build-segment milestone map.

The project header's Build segment reads the project record's nested
``progress.implementation``. The milestone map is:

    fabrication confirm ..... 10   (fabricate.confirm_fabrication_plan)
    fabrication in-flight ... 10-60 (fabricator events, scaled per agent)
    agents activated ........ 70   (postfab.activate_agents)
    app created ............. 80   (postfab.create_agent_app)
    blueprint created ....... 85   (postfab.generate_process_blueprint)
    workflow imported ....... 90   (postfab.import_blueprint_to_app)
    app published ........... 100  (backend publishApp -> intake event)

Each successful post-fab tool step records its milestone through
``_internal_update_progress`` (session state + UI event + monotonic project
update). Milestones are best-effort: a progress failure never breaks the
user-facing tool result. Idempotent re-runs (already_done) and failures do
NOT re-emit.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_milestones.py -q
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
    store = {}

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


@pytest.fixture
def progress_spy(monkeypatch):
    spy = mock.MagicMock()
    monkeypatch.setattr(postfab, "_internal_update_progress", spy)
    return spy


def _project_tables(monkeypatch):
    conv_table = mock.MagicMock()
    conv_table.scan.return_value = {"Items": []}
    proj_table = mock.MagicMock()
    proj_table.get_item.return_value = {}
    ddb = mock.MagicMock()
    ddb.Table.side_effect = lambda name: conv_table if name == "conv-t" else proj_table
    monkeypatch.setattr(postfab, "dynamodb", ddb)
    monkeypatch.setattr(postfab, "CONVERSATIONS_TABLE", "conv-t")
    monkeypatch.setattr(postfab, "PROJECTS_TABLE", "proj-t")


# --- activate_agents -> 70 ----------------------------------------------------


def test_activation_success_records_milestone_70(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": ["a1", "a2"], "failed": [], "alreadyActive": [], "matchedBy": "sessionId",
    }}

    result = json.loads(postfab.activate_agents("sess-1"))

    assert result["ok"] is True
    progress_spy.assert_called_once()
    args = progress_spy.call_args.args
    assert args[0] == "sess-1"
    assert args[1] == "implementation"
    assert args[2] == 70


def test_activation_partial_success_still_records_70(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": ["a1"], "failed": ["a2"], "alreadyActive": [], "matchedBy": "sessionId",
    }}

    postfab.activate_agents("sess-1")

    assert progress_spy.call_args.args[2] == 70


def test_activation_already_done_does_not_reemit(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {
        "stage": "activated",
        "activation": {"activated": ["a1"], "failed": [], "alreadyActive": []},
    }

    result = json.loads(postfab.activate_agents("sess-1"))

    assert result["status"] == "already_done"
    progress_spy.assert_not_called()
    execute.assert_not_called()


def test_activation_zero_matched_does_not_record(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": [], "failed": [], "alreadyActive": [], "matchedBy": None,
    }}

    result = json.loads(postfab.activate_agents("sess-1"))

    assert result["status"] == "zero_matched"
    progress_spy.assert_not_called()


def test_activation_error_does_not_record(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "built"}
    execute.side_effect = AppSyncError("boom", retryable=True, error_type="Internal")

    result = json.loads(postfab.activate_agents("sess-1"))

    assert result["ok"] is False
    progress_spy.assert_not_called()


def test_activation_milestone_failure_never_breaks_the_tool(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": ["a1"], "failed": [], "alreadyActive": [], "matchedBy": "sessionId",
    }}
    progress_spy.side_effect = RuntimeError("progress table down")

    result = json.loads(postfab.activate_agents("sess-1"))

    assert result["ok"] is True
    assert result["status"] == "activated"


# --- create_agent_app -> 80 ---------------------------------------------------


def test_app_creation_records_milestone_80(marker_store, execute, progress_spy, monkeypatch):
    _project_tables(monkeypatch)
    marker_store["sess-1"] = {"stage": "activated"}
    execute.return_value = {"intakeCreateApp": {
        "appId": "app-9", "name": "Acme Claims", "status": "DRAFT",
    }}

    result = json.loads(postfab.create_agent_app("sess-1", confirmed_name="Acme Claims"))

    assert result["status"] == "created"
    progress_spy.assert_called_once()
    assert progress_spy.call_args.args[:3] == ("sess-1", "implementation", 80)


def test_app_proposal_does_not_record(marker_store, execute, progress_spy, monkeypatch):
    _project_tables(monkeypatch)
    marker_store["sess-1"] = {"stage": "activated"}

    result = json.loads(postfab.create_agent_app("sess-1"))

    assert result["status"] == "proposal"
    progress_spy.assert_not_called()


def test_app_already_done_does_not_reemit(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-9", "appName": "Acme"}

    result = json.loads(postfab.create_agent_app("sess-1", confirmed_name="Acme"))

    assert result["status"] == "already_done"
    progress_spy.assert_not_called()


# --- generate_process_blueprint -> 85 ------------------------------------------

TD2 = "## Agent Definitions\nAgentA does intake. AgentB does triage after AgentA."
PLAN = "| AgentA | build | new |\n| AgentB | build | new |"
REGISTRY = {
    "AgentA": {"name": "AgentA", "state": "active", "recordId": "rec-a", "description": "", "sourceProjectId": "sess-1"},
    "AgentB": {"name": "AgentB", "state": "active", "recordId": "rec-b", "description": "", "sourceProjectId": "sess-1"},
}


@pytest.fixture
def blueprint_deps(monkeypatch):
    monkeypatch.setattr(postfab, "s3_get", lambda key: TD2 if "td_2" in key else PLAN)
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: dict(REGISTRY))
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(return_value=json.dumps([
        {"agent": "AgentA", "depends_on": []},
        {"agent": "AgentB", "depends_on": ["AgentA"]},
    ])))


def test_blueprint_published_records_milestone_85(marker_store, execute, progress_spy, blueprint_deps):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-9", "appName": "Acme"}
    execute.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-1", "status": "PUBLISHED",
        "nodeCount": 2, "missing": None, "errors": None,
    }}

    result = json.loads(postfab.generate_process_blueprint("sess-1"))

    assert result["status"] == "published"
    progress_spy.assert_called_once()
    assert progress_spy.call_args.args[:3] == ("sess-1", "implementation", 85)


def test_blueprint_syncing_does_not_record(marker_store, execute, progress_spy, blueprint_deps):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-9", "appName": "Acme"}
    execute.return_value = {"intakeCreateBlueprint": {
        "ok": False, "blueprintId": None, "status": "AGENTS_SYNCING",
        "nodeCount": None, "missing": ["rec-a"], "errors": [],
    }}

    result = json.loads(postfab.generate_process_blueprint("sess-1"))

    assert result["status"] == "agents_syncing"
    progress_spy.assert_not_called()


# --- import_blueprint_to_app -> 90 ---------------------------------------------


def test_import_success_records_milestone_90(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {
        "stage": "blueprint_created", "appId": "app-9",
        "appName": "Acme", "blueprintId": "bp-1",
    }
    execute.return_value = {"intakeImportBlueprintToApp": {
        "workflowId": "wf-1", "name": "Acme Process", "status": "DRAFT",
    }}

    result = json.loads(postfab.import_blueprint_to_app("sess-1"))

    assert result["status"] == "imported"
    progress_spy.assert_called_once()
    assert progress_spy.call_args.args[:3] == ("sess-1", "implementation", 90)


def test_import_already_done_does_not_reemit(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {
        "stage": "workflow_imported", "appId": "app-9",
        "appName": "Acme", "blueprintId": "bp-1", "workflowId": "wf-1",
    }

    result = json.loads(postfab.import_blueprint_to_app("sess-1"))

    assert result["status"] == "already_done"
    progress_spy.assert_not_called()


def test_import_error_does_not_record(marker_store, execute, progress_spy):
    marker_store["sess-1"] = {
        "stage": "blueprint_created", "appId": "app-9",
        "appName": "Acme", "blueprintId": "bp-1",
    }
    execute.side_effect = AppSyncError("boom", retryable=False, error_type="Internal")

    result = json.loads(postfab.import_blueprint_to_app("sess-1"))

    assert result["ok"] is False
    progress_spy.assert_not_called()


# --- fabrication confirm -> 10 (early-Build value, not 100) ---------------------


def test_confirm_fabrication_plan_sets_implementation_to_10(monkeypatch):
    """confirm_fabrication_plan previously wrote implementation=100 at queue
    time, completing the Build segment before a single agent was built (and
    the Phase 7 prompt's progress=0 then regressed it). The confirm milestone
    is the START of the fabrication window: 10."""
    import tools.fabricate as fabricate
    import tools.state as state

    spy = mock.MagicMock()
    monkeypatch.setattr(state, "_internal_update_progress", spy)
    monkeypatch.setattr(fabricate, "s3_put", mock.MagicMock())
    monkeypatch.setattr(fabricate, "FABRICATOR_QUEUE_URL", "https://sqs/q")
    monkeypatch.setattr(fabricate, "_send_to_fabricator", mock.MagicMock())

    plan = json.dumps([{"name": "AgentA", "action": "build", "reason": "new", "spec": "spec"}])
    fabricate.confirm_fabrication_plan("sess-1", plan)

    spy.assert_called_once()
    kwargs = spy.call_args.kwargs
    args = spy.call_args.args
    progress = kwargs.get("progress", args[2] if len(args) > 2 else None)
    phase = kwargs.get("phase", args[1] if len(args) > 1 else None)
    assert phase == "implementation"
    assert progress == 10
