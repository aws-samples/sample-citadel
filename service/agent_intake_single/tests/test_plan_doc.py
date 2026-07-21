"""Tests for the living fabrication-plan document refresher (tools/plan_doc.py).

Contract:
- refresh_plan_document(session_id) regenerates ONLY the owned sections of
  {session_id}/planning/fabrication_plan.md from live state:
    * the per-agent status table (fabrication-jobs terminal statuses + the
      registry via _get_existing_agents), between agent-status markers —
      with a structural fallback for docs written before markers existed;
    * a '## Delivered Artifacts' section between artifact markers, appended
      at the end (activated agents count+names, app name+id, blueprint
      name+node count, workflow name+id, each stamped at first write).
- All other document prose is preserved byte-for-byte.
- Status wording uses human phrases ('Built', 'Active — ready to use'),
  never raw job/registry enums.
- Idempotent: a double run is byte-identical and skips the second S3 write.
- Best-effort: never raises, regardless of which dependency fails.
- Triggers: check_fabrication_status on the built transition, and every
  post-fabrication stage via the _record_stage_progress hook.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_plan_doc.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")

import tools.plan_doc as plan_doc
import tools.postfab as postfab
import tools.fabricate as fabricate

SESSION = "sess-1"
KEY = fabricate.PLAN_KEY.format(session_id=SESSION)

# Exact shape confirm_fabrication_plan wrote BEFORE markers existed (legacy
# docs already in the versioned bucket) — the structural-fallback path.
LEGACY_DOC = (
    "# Fabrication Plan\n\n"
    "| Agent | Action | Reason |\n"
    "|---|---|---|\n"
    "| AgentA | 🔨 Build | Not yet in factory — will be auto-fabricated |\n"
    "| AgentB | ♻️ Reuse | Already in factory (recordId=rec-b, state=active) |\n"
    "| AgentC | ⚠️ External | Needs proprietary hardware |\n"
    "\n## Agents to Build\n\n"
    "### AgentA\nDoes the intake triage.\n"
)

REGISTRY_ACTIVE = {
    "AgentA": {"name": "AgentA", "state": "active", "recordId": "rec-a", "description": "", "sourceProjectId": SESSION},
    "AgentB": {"name": "AgentB", "state": "active", "recordId": "rec-b", "description": "", "sourceProjectId": None},
}

FULL_MARKER = {
    "stage": "workflow_imported",
    "activation": {"activated": ["AgentA"], "alreadyActive": ["AgentB"], "failed": []},
    "appId": "app-9", "appName": "Acme Claims",
    "blueprintId": "bp-1", "nodeCount": 2,
    "workflowId": "wf-1",
}


class FakeEnv:
    def __init__(self):
        self.store = {}
        self.put_calls = []
        self.jobs = []
        self.registry = {}
        self.marker = {}


@pytest.fixture
def env(monkeypatch):
    """Fake S3/kb, fabrication-jobs table, registry, and marker."""
    fake = FakeEnv()

    monkeypatch.setattr(plan_doc, "SESSION_BUCKET", "test-bucket", raising=False)
    monkeypatch.setattr(plan_doc, "s3_get", lambda key: fake.store.get(key))

    def fake_put(key, body, *args, **kwargs):
        fake.store[key] = body
        fake.put_calls.append(key)

    monkeypatch.setattr(plan_doc, "s3_put", fake_put)

    table = mock.MagicMock()
    table.query.side_effect = lambda **kw: {"Items": list(fake.jobs)}
    ddb = mock.MagicMock()
    ddb.Table.return_value = table
    monkeypatch.setattr(plan_doc, "dynamodb", ddb)
    monkeypatch.setattr(plan_doc, "FABRICATION_JOBS_TABLE", "jobs-t")

    monkeypatch.setattr(plan_doc, "_get_existing_agents", lambda: dict(fake.registry))
    monkeypatch.setattr(plan_doc, "get_postfab_marker", lambda sid: dict(fake.marker))
    return fake


def _row_cells(doc, agent):
    for line in doc.split("\n"):
        if line.strip().startswith(f"| {agent} |"):
            return [c.strip() for c in line.strip().strip("|").split("|")]
    raise AssertionError(f"row for {agent} not found in doc:\n{doc}")


# --- status table regeneration --------------------------------------------------


def test_stale_reason_flips_to_built_when_job_completed(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert "Not yet in factory — will be auto-fabricated" not in doc
    assert _row_cells(doc, "AgentA")[2] == "Built"


def test_active_registry_agent_shows_active_ready_to_use(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.registry = dict(REGISTRY_ACTIVE)

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert _row_cells(doc, "AgentA")[2] == "Active — ready to use"
    # The reuse row loses its raw recordId/state reason too.
    assert _row_cells(doc, "AgentB")[2] == "Active — ready to use"
    assert "recordId=" not in doc


def test_failed_job_uses_human_phrase(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "FAILED"}]

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert _row_cells(doc, "AgentA")[2] == "Didn't finish building"
    for enum in ("COMPLETED", "FAILED", "PENDING", "PROCESSING"):
        assert enum not in doc


def test_in_flight_jobs_use_human_phrases(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [
        {"orchestrationId": SESSION, "agentUseId": "AgentA",
         "agentName": "AgentA", "status": "PROCESSING"},
    ]

    plan_doc.refresh_plan_document(SESSION)

    assert _row_cells(env.store[KEY], "AgentA")[2] == "Being built"


def test_no_live_signal_preserves_existing_cell(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    # AgentC is external: no job row, not in registry — cell untouched.
    assert _row_cells(env.store[KEY], "AgentC")[2] == "Needs proprietary hardware"


def test_action_cells_and_agent_names_preserved(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert _row_cells(doc, "AgentA")[1] == "🔨 Build"
    assert _row_cells(doc, "AgentB")[1] == "♻️ Reuse"
    assert _row_cells(doc, "AgentC")[1] == "⚠️ External"


def test_legacy_doc_gains_status_markers_for_future_runs(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert fabricate.PLAN_STATUS_BEGIN in doc
    assert fabricate.PLAN_STATUS_END in doc
    assert doc.index(fabricate.PLAN_STATUS_BEGIN) < doc.index("| AgentA |") < doc.index(fabricate.PLAN_STATUS_END)


# --- markers must be INVISIBLE in CommonMark (react-markdown has no rehype-raw) --
#
# Live defect: the owned-section markers were HTML comments, which
# react-markdown@10 + remarkGfm (no rehype-raw — XSS risk on LLM-authored
# docs) renders as LITERAL TEXT. The markers must use the link-reference-
# definition form `[//]: # (...)`, which CommonMark renders as nothing.
# Read-side accepts BOTH forms; writes always emit the new form, so existing
# docs self-migrate on their next refresh.

import re as _re

_INVISIBLE_MARKER = _re.compile(r"^\[//\]: # \(intake:[a-z-]+:(begin|end)\)$")

# Exact byte shapes docs written before the switch carry.
OLD_STATUS_BEGIN = "<!-- intake:agent-status:begin -->"
OLD_STATUS_END = "<!-- intake:agent-status:end -->"
OLD_ARTIFACTS_BEGIN = "<!-- intake:delivered-artifacts:begin -->"
OLD_ARTIFACTS_END = "<!-- intake:delivered-artifacts:end -->"

OLD_MARKER_DOC = (
    "# Fabrication Plan\n\n"
    f"{OLD_STATUS_BEGIN}\n"
    "| Agent | Action | Reason |\n"
    "|---|---|---|\n"
    "| AgentA | 🔨 Build | Not yet in factory — will be auto-fabricated |\n"
    f"{OLD_STATUS_END}\n"
    "\n## Agents to Build\n\n"
    "### AgentA\nDoes the intake triage.\n\n"
    f"{OLD_ARTIFACTS_BEGIN}\n"
    "## Delivered Artifacts\n"
    "\n"
    "- Agents activated: 1 ('AgentA') — recorded 2026-07-01 00:00 UTC\n"
    f"{OLD_ARTIFACTS_END}"
)


def _assert_markers_invisible(doc):
    lines = doc.split("\n")
    markers = [
        fabricate.PLAN_STATUS_BEGIN, fabricate.PLAN_STATUS_END,
        plan_doc.ARTIFACTS_BEGIN, plan_doc.ARTIFACTS_END,
    ]
    for marker in markers:
        # Link-reference-definition form — invisible in CommonMark.
        assert _INVISIBLE_MARKER.fullmatch(marker), marker
        assert marker in lines, f"{marker} not present as its own line"
        index = lines.index(marker)
        # A link reference definition absorbed into an adjacent paragraph or
        # list renders as literal text — every marker needs blank-line
        # separation from surrounding content.
        if index > 0:
            assert lines[index - 1].strip() == "", f"no blank line before {marker}"
        if index < len(lines) - 1:
            assert lines[index + 1].strip() == "", f"no blank line after {marker}"


def test_emitted_markers_use_invisible_link_reference_form(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.marker = dict(FULL_MARKER)

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert "<!--" not in doc
    _assert_markers_invisible(doc)


def test_old_marker_doc_migrates_in_one_refresh(env):
    env.store[KEY] = OLD_MARKER_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.marker = {"stage": "activated",
                  "activation": {"activated": ["AgentA"], "alreadyActive": [], "failed": []}}

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    # Every old HTML-comment marker is gone after ONE refresh...
    for old in (OLD_STATUS_BEGIN, OLD_STATUS_END, OLD_ARTIFACTS_BEGIN, OLD_ARTIFACTS_END):
        assert old not in doc
    assert "<!--" not in doc
    # ...replaced by the invisible form, owned content intact.
    _assert_markers_invisible(doc)
    assert _row_cells(doc, "AgentA")[2] == "Built"
    # The pre-existing artifact line keeps its first-written timestamp.
    assert "- Agents activated: 1 ('AgentA') — recorded 2026-07-01 00:00 UTC" in doc


def test_old_markers_migrate_even_when_content_is_unchanged(env):
    """Self-migration must not depend on a status flip: the visible-marker
    bug is itself the reason to rewrite."""
    env.store[KEY] = OLD_MARKER_DOC
    env.marker = {"stage": "activated",
                  "activation": {"activated": ["AgentA"], "alreadyActive": [], "failed": []}}
    # No jobs / registry — every status cell keeps its existing value.

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert OLD_STATUS_BEGIN not in doc
    assert OLD_ARTIFACTS_BEGIN not in doc
    _assert_markers_invisible(doc)
    # Owned content is preserved: same reason cell, same artifact timestamp.
    assert _row_cells(doc, "AgentA")[2] == "Not yet in factory — will be auto-fabricated"
    assert "recorded 2026-07-01 00:00 UTC" in doc


def test_migrated_doc_double_run_is_byte_identical(env):
    env.store[KEY] = OLD_MARKER_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.marker = {"stage": "activated",
                  "activation": {"activated": ["AgentA"], "alreadyActive": [], "failed": []}}

    plan_doc.refresh_plan_document(SESSION)
    migrated = env.store[KEY]
    writes = len(env.put_calls)

    plan_doc.refresh_plan_document(SESSION)

    assert env.store[KEY] == migrated
    assert len(env.put_calls) == writes


def test_confirm_plan_emits_invisible_markers_with_blank_separation(monkeypatch):
    captured = {}
    monkeypatch.setattr(fabricate, "s3_put", lambda key, body, *a, **k: captured.update({key: body}))
    monkeypatch.setattr(fabricate, "FABRICATOR_QUEUE_URL", "https://sqs/q")
    monkeypatch.setattr(fabricate, "_send_to_fabricator", mock.MagicMock())
    import tools.state as state
    monkeypatch.setattr(state, "_internal_update_progress", mock.MagicMock())

    plan = json.dumps([{"name": "AgentA", "action": "build", "reason": "new", "spec": "spec"}])
    fabricate.confirm_fabrication_plan(SESSION, plan)

    doc = captured[KEY]
    assert "<!--" not in doc
    lines = doc.split("\n")
    for marker in (fabricate.PLAN_STATUS_BEGIN, fabricate.PLAN_STATUS_END):
        assert _INVISIBLE_MARKER.fullmatch(marker)
        index = lines.index(marker)
        if index > 0:
            assert lines[index - 1].strip() == ""
        if index < len(lines) - 1:
            assert lines[index + 1].strip() == ""


# --- prose preservation ----------------------------------------------------------


def test_all_other_prose_preserved_exactly(env):
    prefix = "# Fabrication Plan\n\nHand-written preamble the user cares about.\n\n"
    table = (
        "| Agent | Action | Reason |\n"
        "|---|---|---|\n"
        "| AgentA | 🔨 Build | Not yet in factory — will be auto-fabricated |\n"
    )
    suffix = (
        "\nA custom paragraph between sections — must survive.\n"
        "\n## Agents to Build\n\n### AgentA\nSpec text, LLM-authored, unreproducible.\n"
    )
    env.store[KEY] = prefix + table + suffix
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert doc.startswith(prefix)
    assert suffix in doc


# --- Delivered Artifacts ---------------------------------------------------------


def test_artifacts_section_appended_from_marker(env):
    env.store[KEY] = LEGACY_DOC
    env.marker = dict(FULL_MARKER)

    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    assert "## Delivered Artifacts" in doc
    assert "Agents activated: 2" in doc
    assert "'AgentA'" in doc and "'AgentB'" in doc
    assert "'Acme Claims' (id: app-9)" in doc
    assert "'Acme Claims Process' (2 steps)" in doc
    assert "'Acme Claims Process' (id: wf-1)" in doc
    # Each artifact line is timestamped at write time.
    assert doc.count("— recorded ") == 4


def test_no_artifacts_section_before_anything_delivered(env):
    env.store[KEY] = LEGACY_DOC
    env.marker = {"stage": "built"}
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]

    plan_doc.refresh_plan_document(SESSION)

    assert "## Delivered Artifacts" not in env.store[KEY]


def test_artifacts_grow_incrementally_and_keep_existing_timestamps(env):
    env.store[KEY] = LEGACY_DOC
    env.marker = {"stage": "activated",
                  "activation": {"activated": ["AgentA"], "alreadyActive": [], "failed": []}}
    plan_doc.refresh_plan_document(SESSION)
    first = env.store[KEY]
    activated_line = next(l for l in first.split("\n") if "Agents activated" in l)

    env.marker = dict(FULL_MARKER,
                      activation={"activated": ["AgentA"], "alreadyActive": [], "failed": []})
    plan_doc.refresh_plan_document(SESSION)

    doc = env.store[KEY]
    # The earlier entry keeps its original line (timestamp preserved verbatim).
    assert activated_line in doc.split("\n")
    assert "'Acme Claims' (id: app-9)" in doc
    assert doc.count("## Delivered Artifacts") == 1


# --- idempotency -----------------------------------------------------------------


def test_double_run_is_byte_identical_and_skips_second_write(env):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.marker = dict(FULL_MARKER)

    plan_doc.refresh_plan_document(SESSION)
    first = env.store[KEY]
    writes = len(env.put_calls)

    plan_doc.refresh_plan_document(SESSION)

    assert env.store[KEY] == first
    assert len(env.put_calls) == writes  # unchanged content is not rewritten


def test_unchanged_doc_is_not_rewritten(env):
    env.store[KEY] = LEGACY_DOC
    # No jobs, no registry, no marker: nothing to change.

    plan_doc.refresh_plan_document(SESSION)

    assert env.put_calls == []
    assert env.store[KEY] == LEGACY_DOC


# --- best-effort -----------------------------------------------------------------


def test_missing_doc_is_a_noop(env):
    plan_doc.refresh_plan_document(SESSION)

    assert env.put_calls == []


def test_unset_session_bucket_is_a_noop_without_reads(env, monkeypatch):
    """Environments without SESSION_BUCKET wired must skip the refresh
    outright — no S3 read attempt (a real client call with an empty bucket
    name costs a network round trip per invocation)."""
    monkeypatch.setattr(plan_doc, "SESSION_BUCKET", "")
    reads = mock.MagicMock()
    monkeypatch.setattr(plan_doc, "s3_get", reads)

    plan_doc.refresh_plan_document(SESSION)

    reads.assert_not_called()
    assert env.put_calls == []


@pytest.mark.parametrize("break_dep", ["s3_get", "s3_put", "jobs", "registry", "marker"])
def test_best_effort_never_raises(env, monkeypatch, break_dep):
    env.store[KEY] = LEGACY_DOC
    env.jobs = [{"orchestrationId": SESSION, "agentUseId": "AgentA",
                 "agentName": "AgentA", "status": "COMPLETED"}]
    env.marker = dict(FULL_MARKER)

    def boom(*args, **kwargs):
        raise RuntimeError("dependency down")

    if break_dep == "s3_get":
        monkeypatch.setattr(plan_doc, "s3_get", boom)
    elif break_dep == "s3_put":
        monkeypatch.setattr(plan_doc, "s3_put", boom)
    elif break_dep == "jobs":
        ddb = mock.MagicMock()
        ddb.Table.side_effect = boom
        monkeypatch.setattr(plan_doc, "dynamodb", ddb)
    elif break_dep == "registry":
        monkeypatch.setattr(plan_doc, "_get_existing_agents", boom)
    elif break_dep == "marker":
        monkeypatch.setattr(plan_doc, "get_postfab_marker", boom)

    plan_doc.refresh_plan_document(SESSION)  # must not raise


def test_jobs_or_registry_failure_still_refreshes_artifacts(env, monkeypatch):
    """A broken jobs table degrades the status flip but never blocks the
    Delivered Artifacts update."""
    env.store[KEY] = LEGACY_DOC
    env.marker = dict(FULL_MARKER)
    ddb = mock.MagicMock()
    ddb.Table.side_effect = RuntimeError("jobs table down")
    monkeypatch.setattr(plan_doc, "dynamodb", ddb)

    plan_doc.refresh_plan_document(SESSION)

    assert "## Delivered Artifacts" in env.store[KEY]


# --- confirm_fabrication_plan writes the owned-section markers --------------------


def test_confirm_plan_wraps_status_table_in_markers(monkeypatch):
    captured = {}
    monkeypatch.setattr(fabricate, "s3_put", lambda key, body, *a, **k: captured.update({key: body}))
    monkeypatch.setattr(fabricate, "FABRICATOR_QUEUE_URL", "https://sqs/q")
    monkeypatch.setattr(fabricate, "_send_to_fabricator", mock.MagicMock())
    import tools.state as state
    monkeypatch.setattr(state, "_internal_update_progress", mock.MagicMock())

    plan = json.dumps([{"name": "AgentA", "action": "build", "reason": "new", "spec": "spec"}])
    fabricate.confirm_fabrication_plan(SESSION, plan)

    doc = captured[KEY]
    assert fabricate.PLAN_STATUS_BEGIN in doc
    assert fabricate.PLAN_STATUS_END in doc
    assert doc.index(fabricate.PLAN_STATUS_BEGIN) < doc.index("| AgentA |") < doc.index(fabricate.PLAN_STATUS_END)


# --- triggers ---------------------------------------------------------------------


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
def refresh_spy(monkeypatch):
    spy = mock.MagicMock()
    monkeypatch.setattr(postfab, "refresh_plan_document", spy)
    monkeypatch.setattr(postfab, "_internal_update_progress", mock.MagicMock())
    return spy


def _jobs_table(monkeypatch, items):
    table = mock.MagicMock()
    table.query.return_value = {"Items": items}
    ddb = mock.MagicMock()
    ddb.Table.return_value = table
    monkeypatch.setattr(postfab, "dynamodb", ddb)
    monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "jobs-t")


def test_built_detection_triggers_refresh(marker_store, execute, refresh_spy, monkeypatch):
    marker_store[SESSION] = {"stage": "fabrication_pending"}
    _jobs_table(monkeypatch, [
        {"agentName": "AgentA", "agentUseId": "AgentA", "status": "COMPLETED"},
    ])

    result = json.loads(postfab.check_fabrication_status(SESSION))

    assert result["status"] == "complete"
    refresh_spy.assert_called_once_with(SESSION)


def test_in_progress_does_not_trigger_refresh(marker_store, execute, refresh_spy, monkeypatch):
    marker_store[SESSION] = {"stage": "fabrication_pending"}
    _jobs_table(monkeypatch, [
        {"agentName": "AgentA", "agentUseId": "AgentA", "status": "PROCESSING"},
    ])

    result = json.loads(postfab.check_fabrication_status(SESSION))

    assert result["status"] == "in_progress"
    refresh_spy.assert_not_called()


def test_activation_success_triggers_refresh(marker_store, execute, refresh_spy):
    marker_store[SESSION] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": ["AgentA"], "failed": [], "alreadyActive": [], "matchedBy": "sessionId",
    }}

    result = json.loads(postfab.activate_agents(SESSION))

    assert result["ok"] is True
    refresh_spy.assert_called_once_with(SESSION)


def test_app_creation_triggers_refresh(marker_store, execute, refresh_spy, monkeypatch):
    marker_store[SESSION] = {"stage": "activated"}
    execute.return_value = {"intakeCreateApp": {"appId": "app-9", "name": "Acme"}}

    result = json.loads(postfab.create_agent_app(SESSION, confirmed_name="Acme"))

    assert result["status"] == "created"
    refresh_spy.assert_called_once_with(SESSION)


def test_blueprint_publish_triggers_refresh(marker_store, execute, refresh_spy, monkeypatch):
    marker_store[SESSION] = {"stage": "app_created", "appId": "app-9", "appName": "Acme"}
    monkeypatch.setattr(postfab, "s3_get", lambda key: "## Agent Definitions\nAgentA.")
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: {
        "AgentA": {"name": "AgentA", "state": "active", "recordId": "rec-a",
                   "description": "", "sourceProjectId": SESSION},
    })
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(
        return_value=json.dumps([{"agent": "AgentA", "depends_on": []}])))
    execute.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-1", "status": "PUBLISHED",
        "nodeCount": 1, "missing": None, "errors": None,
    }}

    result = json.loads(postfab.generate_process_blueprint(SESSION))

    assert result["status"] == "published"
    refresh_spy.assert_called_once_with(SESSION)


def test_blueprint_marker_records_node_count(marker_store, execute, refresh_spy, monkeypatch):
    """The artifacts section needs the node count; the marker must carry it."""
    marker_store[SESSION] = {"stage": "app_created", "appId": "app-9", "appName": "Acme"}
    monkeypatch.setattr(postfab, "s3_get", lambda key: "## Agent Definitions\nAgentA.")
    monkeypatch.setattr(postfab, "_get_existing_agents", lambda: {
        "AgentA": {"name": "AgentA", "state": "active", "recordId": "rec-a",
                   "description": "", "sourceProjectId": SESSION},
    })
    monkeypatch.setattr(postfab, "_llm", mock.MagicMock(
        return_value=json.dumps([{"agent": "AgentA", "depends_on": []}])))
    execute.return_value = {"intakeCreateBlueprint": {
        "ok": True, "blueprintId": "bp-1", "status": "PUBLISHED",
        "nodeCount": 1, "missing": None, "errors": None,
    }}

    postfab.generate_process_blueprint(SESSION)

    assert marker_store[SESSION]["nodeCount"] == 1


def test_import_success_triggers_refresh(marker_store, execute, refresh_spy):
    marker_store[SESSION] = {"stage": "blueprint_created", "appId": "app-9",
                             "appName": "Acme", "blueprintId": "bp-1"}
    execute.return_value = {"intakeImportBlueprintToApp": {
        "workflowId": "wf-1", "name": "Acme Process", "status": "DRAFT",
    }}

    result = json.loads(postfab.import_blueprint_to_app(SESSION))

    assert result["status"] == "imported"
    refresh_spy.assert_called_once_with(SESSION)


def test_refresh_failure_never_breaks_the_tool(marker_store, execute, refresh_spy):
    refresh_spy.side_effect = RuntimeError("bucket down")
    marker_store[SESSION] = {"stage": "built"}
    execute.return_value = {"intakeActivateProjectAgents": {
        "activated": ["AgentA"], "failed": [], "alreadyActive": [], "matchedBy": "sessionId",
    }}

    result = json.loads(postfab.activate_agents(SESSION))

    assert result["ok"] is True
    assert result["status"] == "activated"


def test_refresh_failure_never_breaks_status_check(marker_store, execute, refresh_spy, monkeypatch):
    refresh_spy.side_effect = RuntimeError("bucket down")
    marker_store[SESSION] = {"stage": "fabrication_pending"}
    _jobs_table(monkeypatch, [
        {"agentName": "AgentA", "agentUseId": "AgentA", "status": "COMPLETED"},
    ])

    result = json.loads(postfab.check_fabrication_status(SESSION))

    assert result["ok"] is True
    assert result["status"] == "complete"
