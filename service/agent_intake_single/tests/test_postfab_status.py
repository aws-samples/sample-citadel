"""Tests for check_fabrication_status (tools/postfab.py) + postfab marker helpers.

Contract:
- Queries FABRICATION_JOBS_TABLE by orchestrationId = session_id.
- Aggregates counts + per-agent states; NEVER surfaces raw enums
  (PROCESSING -> 'being built', etc.).
- Conversational summary follows the approved copy: pull-only framing
  ("check back with me"), never a push promise ("I'll let you know").
- Marker (SESSION_MEMORY_TABLE s_key='intake:postfab') advances
  fabrication_pending -> built, and never regresses a later stage.
- Every return carries a consent question + emoji-free actions.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_status.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")
os.environ.setdefault("FABRICATION_JOBS_TABLE", "jobs-test")

import tools.postfab as postfab
import tools.state as state

RAW_ENUMS = ("PENDING", "PROCESSING", "COMPLETED", "FAILED")

# Days older than the stale-active threshold; real byte shape (microseconds,
# Z-suffixed) mirrors what the fabricator's status writer produces.
STALE_TS = "2026-07-19T04:31:03.885692Z"


def _fresh_ts():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _job(name, status, updated_at=None):
    return {"orchestrationId": "sess-1", "agentUseId": name, "agentName": name,
            "status": status, "updatedAt": updated_at or _fresh_ts()}


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
def jobs_table(monkeypatch):
    table = mock.MagicMock()
    ddb = mock.MagicMock()
    ddb.Table.return_value = table
    monkeypatch.setattr(postfab, "dynamodb", ddb)
    monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "jobs-test")
    return table


def _run(jobs_table, items, marker_store):
    jobs_table.query.return_value = {"Items": items}
    return json.loads(postfab.check_fabrication_status(session_id="sess-1"))


def _assert_conversational_contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions"), "every return must carry actions"
    for action in result["actions"]:
        assert action["label"] and action["value"]
        assert all(ord(ch) < 0x2000 for ch in action["label"]), \
            f"emoji/non-ascii in action label: {action['label']!r}"


def _assert_no_raw_enums(result):
    blob = json.dumps(result)
    for enum in RAW_ENUMS:
        assert enum not in blob, f"raw enum {enum} leaked into tool output"


def test_in_progress_translates_enums_and_invites_pull(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "PROCESSING"), _job("C", "PENDING")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "in_progress"
    assert result["all_terminal"] is False
    assert result["total"] == 3
    assert "Still building" in result["summary"]
    assert "check back" in result["summary"].lower()
    assert "being built" in json.dumps(result)
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_in_progress_never_promises_push(jobs_table, marker_store):
    items = [_job("A", "PROCESSING")]
    result = _run(jobs_table, items, marker_store)

    assert "i'll let you know" not in result["summary"].lower()
    assert "i will let you know" not in result["summary"].lower()


def test_complete_offers_activation_with_consent(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "COMPLETED")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "complete"
    assert result["all_terminal"] is True
    assert result["all_succeeded"] is True
    assert "built successfully" in result["summary"]
    assert "activate" in result["consent_question"].lower()
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_partial_reports_failed_and_offers_partial_activation(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "FAILED"), _job("C", "COMPLETED")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "partial"
    assert result["any_failed"] is True
    assert "B" in result["failed"]
    assert "didn't finish" in result["summary"]
    assert "2" in result["consent_question"]  # activate the 2 that are ready
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_all_failed_does_not_offer_activation(jobs_table, marker_store):
    items = [_job("A", "FAILED"), _job("B", "FAILED")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "all_failed"
    assert "activate" not in result["consent_question"].lower()
    _assert_conversational_contract(result)


def test_no_rows_returns_none_status(jobs_table, marker_store):
    result = _run(jobs_table, [], marker_store)

    assert result["status"] == "none"
    _assert_conversational_contract(result)


def test_table_unset_returns_unavailable(monkeypatch, marker_store):
    monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "")
    result = json.loads(postfab.check_fabrication_status(session_id="sess-1"))

    assert result["status"] == "unavailable"
    _assert_conversational_contract(result)


def test_query_uses_orchestration_id_key(jobs_table, marker_store):
    _run(jobs_table, [_job("A", "COMPLETED")], marker_store)

    kwargs = jobs_table.query.call_args.kwargs
    key_expr = kwargs["KeyConditionExpression"]
    assert key_expr.get_expression()["values"][0].name == "orchestrationId"


def test_marker_advances_to_built_when_terminal(jobs_table, marker_store):
    _run(jobs_table, [_job("A", "COMPLETED")], marker_store)
    assert marker_store["sess-1"]["stage"] == "built"


def test_marker_set_pending_while_building(jobs_table, marker_store):
    _run(jobs_table, [_job("A", "PROCESSING")], marker_store)
    assert marker_store["sess-1"]["stage"] == "fabrication_pending"


def test_marker_not_regressed_from_later_stage(jobs_table, marker_store):
    marker_store["sess-1"] = {"stage": "app_created", "appId": "app-1"}
    _run(jobs_table, [_job("A", "COMPLETED")], marker_store)

    assert marker_store["sess-1"]["stage"] == "app_created"


# --- stale-PROCESSING classification -----------------------------------------
#
# Live-evidence shape (orchestration 6a5e4870…): a fabricator Lambda timeout
# kill never writes a terminal status, so a PROCESSING row's updatedAt stops
# moving. Such an orphaned row must gate like a failure (never deadlock the
# flow) and be surfaced distinctly as stalled.


def _live_like_items():
    return [
        _job("IngestionAgent", "COMPLETED"),
        _job("NodeReconAgent", "COMPLETED"),
        _job("RegistryReconAgent", "COMPLETED"),
        _job("ArbiterAgent", "PROCESSING", updated_at=STALE_TS),
        _job("SettlementMatchAgent", "FAILED"),
        _job("VarianceTriageAgent", "FAILED"),
    ]


def test_stale_sibling_does_not_block_gating_and_reports_stalled(jobs_table, marker_store):
    result = _run(jobs_table, _live_like_items(), marker_store)

    assert result["status"] == "partial"
    assert result["all_terminal"] is True
    assert result["stalled"] == ["ArbiterAgent"]
    assert "stalled" in result["summary"]
    assert "SettlementMatchAgent" in result["failed"]
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_stale_row_state_reads_stalled_not_being_built(jobs_table, marker_store):
    result = _run(jobs_table, _live_like_items(), marker_store)

    states = {a["name"]: a["state"] for a in result["agents"]}
    assert states["ArbiterAgent"] == "stalled"


def test_partial_with_failed_or_stalled_offers_retry_action(jobs_table, marker_store):
    result = _run(jobs_table, _live_like_items(), marker_store)

    labels = " | ".join(a["label"] for a in result["actions"])
    assert "Retry" in labels


def test_fresh_processing_sibling_still_gates_in_progress(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "PROCESSING"),
             _job("C", "FAILED")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "in_progress"
    assert result["stalled"] == []
    assert result["all_terminal"] is False


def test_in_progress_with_failed_offers_retry_while_sibling_builds(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "PROCESSING"),
             _job("C", "FAILED")]
    result = _run(jobs_table, items, marker_store)

    labels = " | ".join(a["label"] for a in result["actions"])
    assert "Retry" in labels
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_in_progress_without_failures_has_no_retry_action(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"), _job("B", "PROCESSING")]
    result = _run(jobs_table, items, marker_store)

    labels = " | ".join(a["label"] for a in result["actions"])
    assert "Retry" not in labels


def test_missing_updated_at_is_treated_as_fresh(jobs_table, marker_store):
    items = [{"orchestrationId": "sess-1", "agentUseId": "A",
              "agentName": "A", "status": "PROCESSING"}]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "in_progress"
    assert result["stalled"] == []


def test_unparseable_updated_at_is_treated_as_fresh(jobs_table, marker_store):
    items = [_job("A", "PROCESSING", updated_at="not-a-timestamp")]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "in_progress"
    assert result["stalled"] == []


def test_stale_only_reports_stalled_and_offers_retry(jobs_table, marker_store):
    items = [_job("ArbiterAgent", "PROCESSING", updated_at=STALE_TS)]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "all_failed"
    assert result["stalled"] == ["ArbiterAgent"]
    assert "stalled" in result["summary"]
    labels = " | ".join(a["label"] for a in result["actions"])
    assert "Retry" in labels
    _assert_no_raw_enums(result)


def test_stale_never_counts_as_all_succeeded(jobs_table, marker_store):
    items = [_job("A", "COMPLETED"),
             _job("ArbiterAgent", "PROCESSING", updated_at=STALE_TS)]
    result = _run(jobs_table, items, marker_store)

    assert result["status"] == "partial"
    assert result["all_succeeded"] is False


# --- marker helpers (tools/state.py) -----------------------------------------


def test_get_postfab_marker_returns_empty_when_absent(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {}
    monkeypatch.setattr(state, "_table", lambda: table)

    assert state.get_postfab_marker("s1") == {}


def test_get_postfab_marker_corrupt_json_returns_empty(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {"Item": {"marker": "{not json"}}
    monkeypatch.setattr(state, "_table", lambda: table)

    assert state.get_postfab_marker("s1") == {}


def test_set_postfab_marker_merges_and_persists(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {"Item": {"marker": json.dumps({"stage": "built", "appId": None})}}
    monkeypatch.setattr(state, "_table", lambda: table)
    monkeypatch.setattr(state, "_invalidate_agent_cache", lambda sid: None)

    merged = state.set_postfab_marker("s1", stage="activated", activation={"activated": ["A"]})

    assert merged["stage"] == "activated"
    assert merged["activation"] == {"activated": ["A"]}
    assert merged["updatedAt"]
    item = table.put_item.call_args.kwargs["Item"]
    assert item["p_key"] == "s1"
    assert item["s_key"] == "intake:postfab"
    stored = json.loads(item["marker"])
    assert stored["stage"] == "activated"


def test_set_postfab_marker_invalidates_agent_cache(monkeypatch):
    table = mock.MagicMock()
    table.get_item.return_value = {}
    monkeypatch.setattr(state, "_table", lambda: table)
    calls = []
    monkeypatch.setattr(state, "_invalidate_agent_cache", lambda sid: calls.append(sid))

    state.set_postfab_marker("s1", stage="built")

    assert calls == ["s1"]
