"""Tests for the DRAFT-agent activation path (fix/intake-submits-draft-agents).

Bug: after fabrication, registry records that stayed DRAFT (due to throttling
during the fabrication submit) were presented with 'submit from the registry UI'
— but no such UI exists. The activate_agents tool calls the mutation that DOES
submit DRAFT records for approval.

These tests validate:
1. check_fabrication_status: DRAFT agents recommend 'Activate agents' (never
   'registry UI').
2. activate_agents: the result distinguishes 'submitted_for_approval' from
   'activated' when the mutation returns agents in the new `submitted` list.
3. User-facing text after activation with manual review: tells the user how
   many were submitted and to check the Approvals page.

Run with:
    PYTHONPATH=. pytest tests/test_postfab_draft_activation.py -v --tb=short
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
os.environ.setdefault("REGISTRY_ID", "reg-test-1")

import tools.postfab as postfab
from tools.appsync_client import AppSyncError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _job_row(name, status="COMPLETED", registry_status=None, record_id=None):
    """Fabrication job row — mirrors arbiter/fabricator/index.py shape."""
    row = {
        "orchestrationId": "sess-1",
        "agentName": name,
        "status": status,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if registry_status:
        row["registryApprovalStatus"] = registry_status
    if record_id:
        row["registryRecordId"] = record_id
    return row


@pytest.fixture
def marker_store(monkeypatch):
    store = {"sess-1": {"stage": "built"}}

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
    monkeypatch.setattr(postfab, "_propose_app_name", lambda sid: "Test App")
    return ex


@pytest.fixture
def fake_dynamo(monkeypatch):
    """Stub the DynamoDB query for fabrication jobs."""
    items = []

    def _query(**kwargs):
        return {"Items": items, "Count": len(items)}

    table_mock = mock.MagicMock()
    table_mock.query = _query

    def _table(name):
        return table_mock

    resource_mock = mock.MagicMock()
    resource_mock.Table = _table
    monkeypatch.setattr(postfab, "dynamodb", resource_mock)
    return items


# ---------------------------------------------------------------------------
# Test 1: check_fabrication_status — DRAFT agents recommend activate_agents
# ---------------------------------------------------------------------------

class TestCheckFabStatusDraftRecommendsActivation:
    """DRAFT agents should say 'will be submitted when you activate' and
    recommend the Activate action — never 'submit from the registry UI'."""

    def test_draft_agents_say_activate_not_registry_ui(
        self, monkeypatch, fake_dynamo, marker_store
    ):
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "jobs-test")
        fake_dynamo.extend([
            _job_row("AgentA"),
            _job_row("AgentB"),
        ])
        # Simulate live registry lookup returning DRAFT for both agents
        monkeypatch.setattr(
            postfab, "_resolve_live_statuses",
            lambda items: {"AgentA": "DRAFT", "AgentB": "DRAFT"},
        )

        result = json.loads(postfab.check_fabrication_status())

        # Must NOT contain "registry UI" or "agent registry" submit language
        full_text = json.dumps(result)
        assert "registry UI" not in full_text, (
            "DRAFT agents must not tell user to submit from registry UI"
        )
        assert "from the agent registry" not in full_text, (
            "DRAFT agents must not tell user to submit from agent registry"
        )

        # Must recommend activation
        assert "activate" in result["summary"].lower() or "activate" in result["consent_question"].lower(), (
            "DRAFT agents should recommend activation"
        )

        # Must have an Activate action button
        labels = [a["label"].lower() for a in result["actions"]]
        assert any("activate" in label for label in labels), (
            "Must have an Activate action for DRAFT agents"
        )

    def test_partial_draft_with_approved_recommends_activate(
        self, monkeypatch, fake_dynamo, marker_store
    ):
        """Mix of DRAFT and APPROVED agents: still recommends activation."""
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "jobs-test")
        fake_dynamo.extend([
            _job_row("AgentA"),
            _job_row("AgentB"),
        ])
        monkeypatch.setattr(
            postfab, "_resolve_live_statuses",
            lambda items: {"AgentA": "DRAFT", "AgentB": "APPROVED"},
        )

        result = json.loads(postfab.check_fabrication_status())
        full_text = json.dumps(result)
        assert "registry UI" not in full_text
        assert "from the agent registry" not in full_text


# ---------------------------------------------------------------------------
# Test 2: activate_agents — distinguishes submitted_for_approval
# ---------------------------------------------------------------------------

class TestActivateAgentsSubmittedForApproval:
    """When the mutation returns agents in the `submitted` list (PENDING_APPROVAL),
    the tool must report them as submitted-for-approval, not activated."""

    def test_submitted_agents_reported_distinctly(
        self, execute, marker_store, monkeypatch
    ):
        """Two agents submitted for approval -> summary says 'submitted'
        and recommends the Approvals page."""
        # Stub the pending-approval gate check to not block
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "")

        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": [],
            "failed": [],
            "alreadyActive": [],
            "submitted": ["AgentA", "AgentB"],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
        # Must mention 'submitted' not 'activated' for these agents
        assert "submitted" in result["summary"].lower(), (
            "Agents in PENDING_APPROVAL must be described as 'submitted'"
        )
        # Must mention the Approvals page
        assert "approvals page" in result["summary"].lower() or \
            "approvals page" in result["consent_question"].lower(), (
            "Must tell user to check the Approvals page"
        )

    def test_mixed_activated_and_submitted(
        self, execute, marker_store, monkeypatch
    ):
        """Mix of auto-approved and manual-review agents."""
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "")

        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": ["AgentA"],
            "failed": [],
            "alreadyActive": [],
            "submitted": ["AgentB"],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
        # Must mention both: one activated, one submitted
        summary_lower = result["summary"].lower()
        assert "submitted" in summary_lower, (
            "Must mention submitted agents"
        )

    def test_all_submitted_tells_user_to_approve_then_activate_again(
        self, execute, marker_store, monkeypatch
    ):
        """All agents submitted (none auto-approved): user-facing text says
        'approve them on the Approvals page, then run Activate agents again'."""
        monkeypatch.setattr(postfab, "FABRICATION_JOBS_TABLE", "")

        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": [],
            "failed": [],
            "alreadyActive": [],
            "submitted": ["AgentA", "AgentB"],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        # The text must guide users to the Approvals page and back
        full_text = json.dumps(result).lower()
        assert "approvals page" in full_text, (
            "Must mention the Approvals page"
        )
        assert "activate" in full_text, (
            "Must tell user to come back and activate again"
        )


# ---------------------------------------------------------------------------
# Test 3: check_fabrication_status — DRAFT no longer blocks activation gate
# ---------------------------------------------------------------------------

class TestDraftAgentsDoNotBlockActivationGate:
    """DRAFT agents were previously excluded from the activatable set in the
    activation gate. Since activate_agents now submits them, DRAFT agents
    must NOT trigger the pending-approval gate block."""

    def test_draft_agents_do_not_trigger_pending_approval_gate(
        self, execute, marker_store, monkeypatch
    ):
        """When all completed agents are DRAFT, activate_agents must NOT
        refuse with 'awaiting approval' — it should proceed to submit them."""
        # Set up the DynamoDB query to return DRAFT agents
        items = [_job_row("AgentA", record_id="rec-1"), _job_row("AgentB", record_id="rec-2")]

        table_mock = mock.MagicMock()
        table_mock.query.return_value = {"Items": items}
        resource_mock = mock.MagicMock()
        resource_mock.Table.return_value = table_mock
        monkeypatch.setattr(postfab, "dynamodb", resource_mock)

        monkeypatch.setattr(
            postfab, "_resolve_live_statuses",
            lambda items: {"AgentA": "DRAFT", "AgentB": "DRAFT"},
        )

        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": [],
            "failed": [],
            "alreadyActive": [],
            "submitted": ["AgentA", "AgentB"],
            "matchedBy": "sessionId",
        }}

        result = json.loads(postfab.activate_agents())

        # Must NOT have status 'pending_approval' (gate block)
        assert result["status"] != "pending_approval", (
            "DRAFT agents should not trigger the pending-approval gate"
        )
        # The mutation must be called (gate did not block)
        execute.assert_called_once()
