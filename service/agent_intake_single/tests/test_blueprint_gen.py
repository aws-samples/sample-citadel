"""Tests for generate_process_blueprint (tools/postfab.py).

Contract:
- Composes a canonical-envelope WorkflowDefinition from td_2.md +
  fabrication_plan.md via the LLM, with REAL registry recordIds as agentIds.
- Envelope: version/id/name/createdAt/updatedAt + nodes(id, agentId,
  position, configuration) + edges(id, source, target, sourceHandle 'output',
  targetHandle 'input'); positions follow x=100+300*depth, y=200+250*lane.
- Unresolvable/external agents are excluded and surfaced.
- intakeCreateBlueprint result: PUBLISHED -> marker update + import consent;
  AGENTS_SYNCING -> retryable + approved waiting copy; VALIDATION_FAILED ->
  non-retryable plain copy.
- Idempotent via marker.blueprintId; requires the app step first.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_blueprint_gen.py -q
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

TD2 = "## Agent Definitions\nAgentA does intake. AgentB does triage after AgentA."
PLAN = "| AgentA | build | new |\n| AgentB | build | new |"

REGISTRY = {
    "AgentA": {"name": "AgentA", "state": "active", "recordId": "rec-a", "description": "", "sourceProjectId": "sess-1"},
    "AgentB": {"name": "AgentB", "state": "active", "recordId": "rec-b", "description": "", "sourceProjectId": "sess-1"},
}


@pytest.fixture
def marker_store(monkeypatch):
    store = {"sess-1": {"stage": "app_created", "appId": "app-9", "appName": "Acme Claims"}}

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
def deps(monkeypatch):
    """Stub S3 docs, registry, and LLM; capture the appsync call."""
    ex = mock.MagicMock()
    ex.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-1", "status": "PUBLISHED",
        "nodeCount": 2, "missing": None, "errors": None,
    }}
    monkeypatch.setattr(postfab.appsync_client, "execute", ex)
    monkeypatch.setattr(postfab, "s3_get", lambda key: TD2 if "td_2" in key else PLAN)
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: dict(REGISTRY))
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(return_value=json.dumps([
        {"agent": "AgentA", "depends_on": []},
        {"agent": "AgentB", "depends_on": ["AgentA"]},
        {"agent": "ExternalX", "depends_on": ["AgentB"]},
    ])))
    return ex


def _contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions")
    for action in result["actions"]:
        assert all(ord(ch) < 0x2000 for ch in action["label"])


def _captured_definition(execute):
    variables = execute.call_args.args[1]
    return json.loads(variables["definition"])


def test_envelope_is_canonical(deps, marker_store):
    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is True
    definition = _captured_definition(deps)
    assert definition["version"] == "1.0.0"
    assert definition["id"]
    assert definition["name"]
    assert "T" in definition["createdAt"] and "T" in definition["updatedAt"]
    assert len(definition["nodes"]) == 2
    for node in definition["nodes"]:
        assert node["id"] == node["agentId"]
        assert node["agentId"] in ("rec-a", "rec-b")
        assert set(node["position"].keys()) == {"x", "y"}
        assert node["configuration"] == {}
    assert len(definition["edges"]) == 1
    edge = definition["edges"][0]
    assert edge["id"]
    assert edge["source"] == "rec-a" and edge["target"] == "rec-b"
    assert edge["sourceHandle"] == "output"
    assert edge["targetHandle"] == "input"


def test_nodes_never_use_placeholders_or_names(deps, marker_store):
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(deps)
    for node in definition["nodes"]:
        assert not node["agentId"].startswith("placeholder-")
        assert node["agentId"] not in ("AgentA", "AgentB", "ExternalX")


def test_positions_follow_layout_rule(deps, marker_store):
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(deps)
    by_id = {n["id"]: n["position"] for n in definition["nodes"]}
    assert by_id["rec-a"] == {"x": 100, "y": 200}      # depth 0, lane 0
    assert by_id["rec-b"] == {"x": 400, "y": 200}      # depth 1, lane 0


def test_unresolved_agents_excluded_and_surfaced(deps, marker_store):
    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert "ExternalX" in result["excluded"]
    assert "ExternalX" in result["summary"]


def test_published_updates_marker_and_asks_import(deps, marker_store):
    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["status"] == "published"
    assert result["blueprint_id"] == "bp-1"
    assert marker_store["sess-1"]["stage"] == "blueprint_created"
    assert marker_store["sess-1"]["blueprintId"] == "bp-1"
    assert "Acme Claims" in result["consent_question"]
    _contract(result)


def test_agents_syncing_is_retryable_with_approved_copy(deps, marker_store):
    deps.return_value = {"intakeCreateBlueprint": {
        "ok": False, "blueprintId": None, "status": "AGENTS_SYNCING",
        "nodeCount": None, "missing": ["rec-b"], "errors": None,
    }}

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    assert result["retryable"] is True
    assert "still being set up" in result["summary"]
    assert "AGENTS_SYNCING" not in result["summary"]
    assert marker_store["sess-1"].get("blueprintId") is None
    labels = [a["label"] for a in result["actions"]]
    assert "Try again" in labels
    _contract(result)


def test_validation_failed_nonretryable(deps, marker_store):
    deps.return_value = {"intakeCreateBlueprint": {
        "ok": False, "blueprintId": None, "status": "VALIDATION_FAILED",
        "nodeCount": None, "missing": None, "errors": ["cycle detected"],
    }}

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    assert result["retryable"] is False
    assert marker_store["sess-1"].get("blueprintId") is None
    _contract(result)


def test_requires_app_first(deps, marker_store):
    marker_store["sess-1"] = {"stage": "activated"}

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    assert result["status"] == "app_required"
    deps.assert_not_called()
    _contract(result)


def test_missing_td2_fails_plainly(deps, marker_store, monkeypatch):
    monkeypatch.setattr(postfab, "s3_get", lambda key: None)

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    deps.assert_not_called()
    _contract(result)


def test_cycle_falls_back_to_linear_chain(deps, marker_store, monkeypatch):
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(return_value=json.dumps([
        {"agent": "AgentA", "depends_on": ["AgentB"]},
        {"agent": "AgentB", "depends_on": ["AgentA"]},
    ])))

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is True
    definition = _captured_definition(deps)
    assert len(definition["nodes"]) == 2
    assert len(definition["edges"]) == 1  # acyclic linear chain
    edge = definition["edges"][0]
    assert edge["source"] != edge["target"]


def test_llm_garbage_fails_plainly_without_mutation(deps, marker_store, monkeypatch):
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(return_value="not json at all"))

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    deps.assert_not_called()
    _contract(result)


def test_idempotent_when_blueprint_already_published(deps, marker_store):
    marker_store["sess-1"].update({"stage": "blueprint_created", "blueprintId": "bp-1"})

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    deps.assert_not_called()
    assert result["status"] == "already_done"
    _contract(result)
