"""Tests for registryApprovalStatus handling in check_fabrication_status + activate_agents.

The fabricator writes registryApprovalStatus='pending_approval' onto the
DynamoDB jobs row when the AgentCore Registry's SubmitRegistryRecordForApproval
returns PENDING_APPROVAL (manual-review mode).  The postfab tools must:
- Present pending_approval agents as 'built, awaiting approval on the Approvals
  page' (never 'failed', never plain 'built').
- Present approved/absent-flag agents as 'built and approved'.
- Refuse activation (via the existing consent/approval logic path) when any
  completed agent has pending_approval, directing the user to the Approvals page.
- Allow activation once all completed agents are approved (flag absent or
  explicitly 'approved').

Job row shape mirrors a real DynamoDB fabrication-jobs row (see
arbiter/fabricator/index.py::_write_fabrication_status):
  PK: orchestrationId  SK: agentUseId
  status: PENDING | PROCESSING | COMPLETED | FAILED
  updatedAt: ISO-8601 with microseconds, Z-suffixed
  agentName: human-readable name
  registryApprovalStatus: 'pending_approval' | absent (auto-approved)

Run with:
    PYTHONPATH=. pytest tests/test_postfab_approval_status.py -v --tb=short
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import request_context

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")
os.environ.setdefault("FABRICATION_JOBS_TABLE", "jobs-test")

import tools.postfab as postfab
from tools.appsync_client import AppSyncError


# ---------------------------------------------------------------------------
# Helpers — live-shape job rows
# ---------------------------------------------------------------------------

def _fresh_ts():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _job(name, status, registry_approval_status=None, updated_at=None):
    """Build a DynamoDB job row with the shape the fabricator writes."""
    row = {
        "orchestrationId": "sess-1",
        "agentUseId": name,
        "agentName": name,
        "status": status,
        "updatedAt": updated_at or _fresh_ts(),
    }
    if registry_approval_status is not None:
        row["registryApprovalStatus"] = registry_approval_status
    return row


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def marker_store(monkeypatch):
    store = {}

    def fake_get(sid):
        return dict(store.get(sid, {}))

    def fake_set(sid, **updates):
        merged = store.setdefault(sid, {})
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


@pytest.fixture
def execute(monkeypatch):
    ex = mock.MagicMock()
    monkeypatch.setattr(postfab.appsync_client, "execute", ex)
    monkeypatch.setattr(postfab, "_propose_app_name", lambda sid: "Acme Claims")
    return ex


def _run_status(jobs_table, items, marker_store):
    jobs_table.query.return_value = {"Items": items}
    return json.loads(postfab.check_fabrication_status())


# ===========================================================================
# check_fabrication_status — pending_approval
# ===========================================================================

class TestStatusPendingApproval:
    """COMPLETED + registryApprovalStatus='pending_approval'."""

    def test_all_completed_pending_approval_shows_awaiting_message(
        self, jobs_table, marker_store,
    ):
        items = [
            _job("AgentA", "COMPLETED", registry_approval_status="pending_approval"),
            _job("AgentB", "COMPLETED", registry_approval_status="pending_approval"),
        ]
        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "complete"
        assert result["ok"] is True
        assert "awaiting approval" in result["summary"]
        assert "Approvals page" in result["summary"]
        assert result["pending_approval"] == ["AgentA", "AgentB"]
        # Must NOT offer activation — needs approval first.
        labels = [a["label"] for a in result["actions"]]
        assert not any("Activate" in label for label in labels)

    def test_pending_approval_agent_state_reads_awaiting(
        self, jobs_table, marker_store,
    ):
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]
        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built, awaiting approval on the Approvals page"

    def test_approved_agent_state_reads_built_and_approved(
        self, jobs_table, marker_store,
    ):
        items = [_job("AgentA", "COMPLETED")]  # no registryApprovalStatus = auto-approved
        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built and approved"

    def test_mixed_approved_and_pending_partial_like(
        self, jobs_table, marker_store,
    ):
        """Two completed: one approved, one pending. Both are COMPLETED so
        status is 'complete', but the pending agent gates the activation."""
        items = [
            _job("AgentA", "COMPLETED"),  # auto-approved
            _job("AgentB", "COMPLETED", registry_approval_status="pending_approval"),
        ]
        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "complete"
        assert result["pending_approval"] == ["AgentB"]
        assert "awaiting approval" in result["summary"]
        assert "Approvals page" in result["summary"]

    def test_pending_approval_with_failed_sibling(
        self, jobs_table, marker_store,
    ):
        """Partial: one completed+pending_approval, one failed."""
        items = [
            _job("AgentA", "COMPLETED", registry_approval_status="pending_approval"),
            _job("AgentB", "FAILED"),
        ]
        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "partial"
        assert result["pending_approval"] == ["AgentA"]
        assert "awaiting approval" in result["summary"]
        assert "Approvals page" in result["summary"]

    def test_no_raw_enums_in_pending_approval_output(
        self, jobs_table, marker_store,
    ):
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]
        result = _run_status(jobs_table, items, marker_store)

        blob = json.dumps(result)
        for raw in ("PENDING_APPROVAL", "COMPLETED", "FAILED", "PROCESSING", "PENDING"):
            assert raw not in blob, f"raw enum {raw} leaked into tool output"

    def test_counts_include_pending_approval(
        self, jobs_table, marker_store,
    ):
        items = [
            _job("AgentA", "COMPLETED", registry_approval_status="pending_approval"),
            _job("AgentB", "COMPLETED"),
        ]
        result = _run_status(jobs_table, items, marker_store)

        assert result["counts"]["pending_approval"] == 1
        assert result["counts"]["built"] == 2


# ===========================================================================
# check_fabrication_status — approved (auto-approved / flag absent)
# ===========================================================================

class TestStatusApproved:
    """COMPLETED without pending_approval — normal 'built and approved' flow."""

    def test_all_approved_offers_activation(
        self, jobs_table, marker_store,
    ):
        items = [
            _job("AgentA", "COMPLETED"),
            _job("AgentB", "COMPLETED"),
        ]
        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "complete"
        labels = [a["label"] for a in result["actions"]]
        assert any("Activate" in label for label in labels)

    def test_agent_state_when_explicitly_approved(
        self, jobs_table, marker_store,
    ):
        """Explicit 'approved' value in registryApprovalStatus — rarely
        written but must still map to a clean state."""
        items = [_job("AgentA", "COMPLETED", registry_approval_status="approved")]
        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "approved" in states["AgentA"].lower()


# ===========================================================================
# activate_agents — pending_approval gate
# ===========================================================================

class TestActivateAgentsPendingApprovalGate:
    """activate_agents must refuse when any job row has pending_approval."""

    def test_refuses_activation_when_pending_approval(
        self, jobs_table, marker_store, execute,
    ):
        marker_store["sess-1"] = {"stage": "built"}
        jobs_table.query.return_value = {"Items": [
            _job("AgentA", "COMPLETED", registry_approval_status="pending_approval"),
        ]}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is False
        assert result["status"] == "pending_approval"
        assert "awaiting approval" in result["summary"]
        assert "Approvals page" in result["summary"]
        # Must NOT have called the activate mutation.
        execute.assert_not_called()

    def test_allows_activation_when_all_approved(
        self, jobs_table, marker_store, execute,
    ):
        marker_store["sess-1"] = {"stage": "built"}
        jobs_table.query.return_value = {"Items": [
            _job("AgentA", "COMPLETED"),  # auto-approved
        ]}
        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": ["AgentA"], "failed": [], "alreadyActive": [],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
        execute.assert_called_once()

    def test_gate_query_failure_does_not_block_activation(
        self, jobs_table, marker_store, execute,
    ):
        """Best-effort: if the jobs table query fails, activation proceeds."""
        marker_store["sess-1"] = {"stage": "built"}
        jobs_table.query.side_effect = RuntimeError("DynamoDB down")
        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": ["AgentA"], "failed": [], "alreadyActive": [],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
        execute.assert_called_once()

    def test_mixed_pending_and_approved_still_refuses(
        self, jobs_table, marker_store, execute,
    ):
        marker_store["sess-1"] = {"stage": "built"}
        jobs_table.query.return_value = {"Items": [
            _job("AgentA", "COMPLETED"),  # auto-approved
            _job("AgentB", "COMPLETED", registry_approval_status="pending_approval"),
        ]}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is False
        assert result["status"] == "pending_approval"
        assert "AgentB" in result["summary"]
        execute.assert_not_called()

    def test_no_fabrication_table_skips_gate(
        self, monkeypatch, marker_store, execute,
    ):
        """When FABRICATION_JOBS_TABLE is empty the gate is skipped."""
        marker_store["sess-1"] = {"stage": "built"}
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "")
        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": ["A"], "failed": [], "alreadyActive": [],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
