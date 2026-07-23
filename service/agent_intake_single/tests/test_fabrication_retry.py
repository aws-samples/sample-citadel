"""Tests for retry_failed_fabrication (tools/fabricate.py).

Contract (per the fabrication-retry diagnosis):
- Gates on the TARGETED jobs' OWN state: FAILED rows and stalled rows
  (non-terminal with updatedAt older than STALE_ACTIVE_SECONDS) are
  eligible; COMPLETED and fresh in-flight rows are never re-queued.
  Sibling states never block a retry — jobs are independent.
- Re-queue reuses _send_to_fabricator: one SQS message per target, and the
  row is durably reset to a fresh waiting state, so an immediate second
  retry is a no-op per agentUseId (idempotent).
- Specs are recovered from the saved fabrication plan in S3
  ('## Agents to Build' -> '### <name>' sections).
- Conversational contract: summary + consent_question + actions; raw status
  enums never reach the output.

Fixtures mirror the REAL citadel-fabrication-jobs rows from the live
evidence (orchestration 6a5e4870…), including the orphaned ArbiterAgent
PROCESSING row whose updatedAt never moved after the Lambda timeout kill.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_fabrication_retry.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab

RAW_ENUMS = ("PENDING", "PROCESSING", "COMPLETED", "FAILED")

# Days older than STALE_ACTIVE_SECONDS; real byte shape (microseconds, Z).
STALE_TS = "2026-07-19T04:31:03.885692Z"

_BEDROCK_ERR = (
    "An error occurred (internalServerException) when calling the "
    "ConverseStream operation: The system encountered an unexpected error "
    "during processing. Try your request again."
)

PLAN_MD = """# Fabrication Plan

[//]: # (intake:agent-status:begin)

| Agent | Action | Reason |
|---|---|---|
| SettlementMatchAgent | Build | Not yet in factory |

[//]: # (intake:agent-status:end)

## Agents to Build

### IngestionAgent
spec: ingestion agent

### ArbiterAgent
spec: arbiter agent

### SettlementMatchAgent
spec: settlement match agent

### VarianceTriageAgent
spec: variance triage agent
"""


def _fresh_ts():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _row(name, status, updated_at=None, **extra):
    row = {
        "orchestrationId": "sess-1", "agentUseId": name, "agentName": name,
        "status": status, "requestType": "agent-creation",
        "requestedBy": "intake", "submittedAt": "2026-07-23T04:30:51.085Z",
        "updatedAt": updated_at or _fresh_ts(), "ttl": 1785386547,
    }
    row.update(extra)
    return row


def _live_rows(arbiter_updated_at=STALE_TS):
    return [
        _row("IngestionAgent", "COMPLETED"),
        _row("NodeReconAgent", "COMPLETED"),
        _row("RegistryReconAgent", "COMPLETED"),
        _row("ArbiterAgent", "PROCESSING", updated_at=arbiter_updated_at),
        _row("SettlementMatchAgent", "FAILED", errorMessage=_BEDROCK_ERR),
        _row("VarianceTriageAgent", "FAILED", errorMessage=_BEDROCK_ERR),
    ]


@pytest.fixture
def jobs_table(monkeypatch):
    table = mock.MagicMock()
    ddb = mock.MagicMock()
    ddb.Table.return_value = table
    monkeypatch.setattr(fab, "dynamodb", ddb)
    monkeypatch.setattr(fab, "sqs", mock.MagicMock())
    monkeypatch.setattr(fab, "FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", "jobs-test")
    monkeypatch.setattr(fab, "s3_get", lambda key: PLAN_MD)
    return table


def _call(jobs_table, rows, agent_names=""):
    jobs_table.query.return_value = {"Items": rows}
    return json.loads(
        fab.retry_failed_fabrication(session_id="sess-1", agent_names=agent_names)
    )


def _sent_names():
    return [json.loads(c.kwargs["MessageBody"])["agent_use_id"]
            for c in fab.sqs.send_message.call_args_list]


def _assert_conversational_contract(result):
    assert result.get("summary")
    assert result.get("consent_question")
    assert result.get("actions")
    for action in result["actions"]:
        assert action["label"] and action["value"]


def _assert_no_raw_enums(result):
    blob = json.dumps(result)
    for enum in RAW_ENUMS:
        assert enum not in blob, f"raw enum {enum} leaked into tool output"


def test_retries_failed_targets_while_sibling_processing_fresh(jobs_table):
    rows = _live_rows(arbiter_updated_at=_fresh_ts())
    result = _call(jobs_table, rows)

    assert result["ok"] is True
    assert result["status"] == "retried"
    assert sorted(_sent_names()) == ["SettlementMatchAgent", "VarianceTriageAgent"]
    assert sorted(result["retried"]) == ["SettlementMatchAgent", "VarianceTriageAgent"]
    _assert_no_raw_enums(result)
    _assert_conversational_contract(result)


def test_retry_resets_target_rows_to_waiting(jobs_table):
    rows = _live_rows(arbiter_updated_at=_fresh_ts())
    _call(jobs_table, rows)

    items = [c.kwargs["Item"] for c in jobs_table.put_item.call_args_list]
    assert {i["agentUseId"] for i in items} == {"SettlementMatchAgent", "VarianceTriageAgent"}
    assert all(i["status"] == "PENDING" for i in items)


def test_stale_sibling_is_eligible_and_reported_stalled(jobs_table):
    result = _call(jobs_table, _live_rows())

    assert result["ok"] is True
    assert sorted(_sent_names()) == ["ArbiterAgent", "SettlementMatchAgent", "VarianceTriageAgent"]
    assert "ArbiterAgent" in result["retried"]
    assert result["stalled"] == ["ArbiterAgent"]
    assert "stalled" in result["summary"]


def test_retry_messages_carry_recovered_spec_and_coarse_indices(jobs_table):
    _call(jobs_table, _live_rows())

    bodies = [json.loads(c.kwargs["MessageBody"])
              for c in fab.sqs.send_message.call_args_list]
    by_name = {b["agent_use_id"]: b for b in bodies}
    assert "spec: settlement match agent" in by_name["SettlementMatchAgent"]["agent_input"]["taskDetails"]
    assert all(b["total_agents"] == 3 for b in bodies)
    assert sorted(b["agent_index"] for b in bodies) == [0, 1, 2]


def test_completed_target_is_never_requeued(jobs_table):
    result = _call(jobs_table, _live_rows(), agent_names="IngestionAgent")

    assert fab.sqs.send_message.call_count == 0
    assert result["status"] == "nothing_to_retry"
    assert "already built" in result["summary"]
    _assert_no_raw_enums(result)


def test_fresh_processing_target_is_refused_per_job(jobs_table):
    rows = _live_rows(arbiter_updated_at=_fresh_ts())
    result = _call(jobs_table, rows, agent_names="ArbiterAgent")

    assert fab.sqs.send_message.call_count == 0
    assert result["status"] == "nothing_to_retry"
    assert "still being built" in result["summary"]


def test_mixed_request_retries_eligible_and_reports_skipped(jobs_table):
    rows = _live_rows(arbiter_updated_at=_fresh_ts())
    result = _call(jobs_table, rows,
                   agent_names="SettlementMatchAgent, IngestionAgent")

    assert _sent_names() == ["SettlementMatchAgent"]
    assert result["status"] == "retried"
    assert "already built" in result["summary"]
    assert [s["name"] for s in result["skipped"]] == ["IngestionAgent"]


def test_double_retry_is_idempotent_per_agent(jobs_table):
    first = _call(jobs_table, _live_rows())
    assert len(first["retried"]) == 3
    fab.sqs.send_message.reset_mock()
    jobs_table.put_item.reset_mock()

    # After the first retry the targets sit as fresh waiting rows.
    rows_after = [
        _row("IngestionAgent", "COMPLETED"),
        _row("NodeReconAgent", "COMPLETED"),
        _row("RegistryReconAgent", "COMPLETED"),
        _row("ArbiterAgent", "PENDING"),
        _row("SettlementMatchAgent", "PENDING"),
        _row("VarianceTriageAgent", "PENDING"),
    ]
    second = _call(jobs_table, rows_after)

    assert fab.sqs.send_message.call_count == 0
    assert jobs_table.put_item.call_count == 0
    assert second["ok"] is True
    assert second["status"] == "nothing_to_retry"


def test_unknown_requested_name_is_reported_plainly(jobs_table):
    result = _call(jobs_table, _live_rows(), agent_names="NopeAgent")

    assert fab.sqs.send_message.call_count == 0
    assert result["status"] == "nothing_to_retry"
    assert "isn't part of this build" in result["summary"]


def test_spec_missing_from_plan_is_graceful_and_sends_nothing(jobs_table, monkeypatch):
    monkeypatch.setattr(fab, "s3_get", lambda key: "# Fabrication Plan\n")
    result = _call(jobs_table, [_row("SettlementMatchAgent", "FAILED",
                                     errorMessage=_BEDROCK_ERR)])

    assert fab.sqs.send_message.call_count == 0
    assert result["ok"] is False
    assert result["status"] == "plan_missing"
    _assert_conversational_contract(result)


def test_queue_url_unset_returns_unavailable(jobs_table, monkeypatch):
    monkeypatch.setattr(fab, "FABRICATOR_QUEUE_URL", "")
    result = _call(jobs_table, _live_rows())

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert fab.sqs.send_message.call_count == 0


def test_no_rows_returns_none_status(jobs_table):
    result = _call(jobs_table, [])

    assert result["status"] == "none"
    assert fab.sqs.send_message.call_count == 0


def test_query_failure_returns_unavailable(jobs_table):
    jobs_table.query.side_effect = Exception("ddb down")
    result = json.loads(fab.retry_failed_fabrication(session_id="sess-1"))

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert fab.sqs.send_message.call_count == 0
