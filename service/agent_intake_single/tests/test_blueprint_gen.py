"""Tests for generate_process_blueprint (tools/postfab.py).

Contract:
- Composes a canonical-envelope WorkflowDefinition from td_2.md +
  fabrication_plan.md via the LLM, with REAL registry recordIds as agentIds.
- Envelope: version/id/name/createdAt/updatedAt + nodes(id, agentId, name,
  position, configuration) + edges(id, source, target, sourceHandle 'output',
  targetHandle 'input'); positions follow x=100+300*depth, y=200+250*lane.
  Node ``name`` is the human-readable step/agent name so the canvas never
  falls back to showing raw registry recordIds.
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
        assert isinstance(node["name"], str) and node["name"]
    assert len(definition["edges"]) == 1
    edge = definition["edges"][0]
    assert edge["id"]
    assert edge["source"] == "rec-a" and edge["target"] == "rec-b"
    assert edge["sourceHandle"] == "output"
    assert edge["targetHandle"] == "input"


def test_nodes_carry_display_names_from_step_mapping(deps, marker_store):
    """Defect: nodes shipped only id=agentId=recordId, so the canvas label
    chain (agentConfig.name || config.name || agentId) surfaced raw registry
    recordIds on catalog miss. Each node must carry the human-readable
    step/agent name used to compose the workflow."""
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(deps)
    names_by_id = {n["id"]: n["name"] for n in definition["nodes"]}
    assert names_by_id == {"rec-a": "AgentA", "rec-b": "AgentB"}


# --- node names are HUMAN design-doc labels, never snake_case registry ids ------
#
# Live defect: fabricated agents register under snake_case names
# ('invoice_intake_classifier_agent'), and the envelope carried those
# verbatim — the canvas showed raw snake_case ids as step labels. The node
# name must be the Title Case step label the design documents show, falling
# back to a humanized form (underscores -> spaces, Title Case) when no
# design label matches.

SNAKE_TD2 = (
    "## Agent Definitions\n"
    "### Invoice Intake Classifier Agent\nClassifies incoming invoices.\n"
    "### Payment Matching Agent\nMatches payments to invoices.\n"
)
SNAKE_PLAN = (
    "| Agent | Action | Status |\n"
    "|---|---|---|\n"
    "| Invoice Intake Classifier Agent | Build | Built |\n"
    "| Payment Matching Agent | Build | Built |\n"
)
SNAKE_REGISTRY = {
    "invoice_intake_classifier_agent": {
        "name": "invoice_intake_classifier_agent", "state": "active",
        "recordId": "rec-a", "description": "", "sourceProjectId": "sess-1",
    },
    "payment_matching_agent": {
        "name": "payment_matching_agent", "state": "active",
        "recordId": "rec-b", "description": "", "sourceProjectId": "sess-1",
    },
    "unmapped_reporting_agent": {
        "name": "unmapped_reporting_agent", "state": "active",
        "recordId": "rec-c", "description": "", "sourceProjectId": "sess-1",
    },
}


@pytest.fixture
def snake_deps(monkeypatch):
    ex = mock.MagicMock()
    ex.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-1", "status": "PUBLISHED",
        "nodeCount": 3, "missing": None, "errors": None,
    }}
    monkeypatch.setattr(postfab.appsync_client, "execute", ex)
    monkeypatch.setattr(postfab, "s3_get",
                        lambda key: SNAKE_TD2 if "td_2" in key else SNAKE_PLAN)
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: dict(SNAKE_REGISTRY))
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(return_value=json.dumps([
        {"agent": "invoice_intake_classifier_agent", "depends_on": []},
        {"agent": "payment_matching_agent",
         "depends_on": ["invoice_intake_classifier_agent"]},
        {"agent": "unmapped_reporting_agent",
         "depends_on": ["payment_matching_agent"]},
    ])))
    return ex


def test_node_names_are_design_doc_labels_not_snake_ids(snake_deps, marker_store):
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(snake_deps)
    names_by_id = {n["id"]: n["name"] for n in definition["nodes"]}
    assert names_by_id["rec-a"] == "Invoice Intake Classifier Agent"
    assert names_by_id["rec-b"] == "Payment Matching Agent"


def test_node_name_fallback_humanizes_snake_case(snake_deps, marker_store):
    """No design label matches 'unmapped_reporting_agent' — the fallback
    humanizes the registry name: underscores -> spaces, Title Case."""
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(snake_deps)
    names_by_id = {n["id"]: n["name"] for n in definition["nodes"]}
    assert names_by_id["rec-c"] == "Unmapped Reporting Agent"


def test_node_names_never_contain_underscores(snake_deps, marker_store):
    postfab.generate_process_blueprint(session_id="sess-1")

    definition = _captured_definition(snake_deps)
    for node in definition["nodes"]:
        assert "_" not in node["name"]
        assert " " in node["name"]  # multi-word labels carry real spaces
        # Title Case: every word leads with an uppercase letter.
        assert all(w[:1].isupper() for w in node["name"].split() if w[:1].isalpha())


def test_steps_payload_uses_the_same_human_labels(snake_deps, marker_store):
    """The 'Show me the steps first' path reads result['steps'] — raw
    snake_case ids must never reach the conversation (copy rules)."""
    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["steps"] == [
        "Invoice Intake Classifier Agent",
        "Payment Matching Agent",
        "Unmapped Reporting Agent",
    ]


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


# --- regenerate consent (already_done must not return the old blueprint forever) --


def test_already_done_offers_regenerate_action(deps, marker_store):
    marker_store["sess-1"].update({"stage": "blueprint_created", "blueprintId": "bp-1"})

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    deps.assert_not_called()
    labels = [a["label"] for a in result["actions"]]
    assert "Regenerate the blueprint" in labels
    regen = next(a for a in result["actions"] if a["label"] == "Regenerate the blueprint")
    assert regen["value"] == "Yes, regenerate the blueprint"
    _contract(result)


def test_regenerate_publishes_a_fresh_blueprint_and_reopens_import_gate(deps, marker_store):
    marker_store["sess-1"].update({
        "stage": "workflow_imported", "blueprintId": "bp-old", "workflowId": "wf-old",
    })
    deps.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-2", "status": "PUBLISHED",
        "nodeCount": 2, "missing": None, "errors": None,
    }}

    result = json.loads(
        postfab.generate_process_blueprint(session_id="sess-1", regenerate=True)
    )

    deps.assert_called_once()
    assert result["ok"] is True
    assert result["status"] == "published"
    assert result["blueprint_id"] == "bp-2"
    # Marker points at the NEW blueprint and the stage re-opens the import
    # gate (blueprint_created semantics) so the new blueprint imports as a
    # fresh workflow — the backend's already-imported detection keys on the
    # blueprint definition id, which is freshly generated here.
    assert marker_store["sess-1"]["blueprintId"] == "bp-2"
    assert marker_store["sess-1"]["stage"] == "blueprint_created"
    assert "Acme Claims" in result["consent_question"]
    _contract(result)


def test_regenerate_mentions_old_workflow_remains_until_removed(deps, marker_store):
    marker_store["sess-1"].update({
        "stage": "workflow_imported", "blueprintId": "bp-old", "workflowId": "wf-old",
    })
    deps.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-2", "status": "PUBLISHED",
        "nodeCount": 2, "missing": None, "errors": None,
    }}

    result = json.loads(
        postfab.generate_process_blueprint(session_id="sess-1", regenerate=True)
    )

    # Copy rules: mention the previously imported workflow stays in the app
    # until the user removes it — without leaking raw ids.
    assert "workflow already in 'Acme Claims'" in result["summary"]
    assert "wf-old" not in result["summary"]
    assert "bp-old" not in result["summary"]
    _contract(result)


def test_regenerate_without_prior_import_does_not_mention_old_workflow(deps, marker_store):
    marker_store["sess-1"].update({"stage": "blueprint_created", "blueprintId": "bp-old"})
    deps.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-2", "status": "PUBLISHED",
        "nodeCount": 2, "missing": None, "errors": None,
    }}

    result = json.loads(
        postfab.generate_process_blueprint(session_id="sess-1", regenerate=True)
    )

    assert result["status"] == "published"
    assert "workflow already in" not in result["summary"]
    _contract(result)


def test_regenerate_flag_ignored_when_nothing_published_yet(deps, marker_store):
    """regenerate=True on a fresh session is just a normal generation —
    never an error."""
    result = json.loads(
        postfab.generate_process_blueprint(session_id="sess-1", regenerate=True)
    )

    deps.assert_called_once()
    assert result["status"] == "published"
    assert marker_store["sess-1"]["blueprintId"] == "bp-1"


def test_no_agents_result_offers_retry_actions_and_stands_alone(deps, marker_store, monkeypatch):
    """Structural guard against in-turn self-retry: the no_agents result must
    carry Try again / Stop here actions like every other failure (the button
    IS the retry), and its copy must stand alone as a complete reply."""
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: {})

    result = json.loads(postfab.generate_process_blueprint(session_id="sess-1"))

    assert result["ok"] is False
    assert result["status"] == "no_agents"
    deps.assert_not_called()
    _contract(result)
    labels = [a["label"] for a in result["actions"]]
    assert "Try again" in labels
    assert "Stop here" in labels
    # Copy stands alone: a complete sentence with the nothing-changed
    # reassurance, so a single reply reads cleanly without glued narration.
    assert result["summary"].rstrip().endswith(".")
    assert "Nothing has been changed" in result["summary"]
