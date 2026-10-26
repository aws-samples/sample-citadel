"""Tests for live registry status resolution in check_fabrication_status.

The fix replaces the write-once ``registryApprovalStatus`` snapshot on the
job row with a live query to the AgentCore Registry.  For COMPLETED jobs the
postfab tool now calls ``ListRegistryRecords(name=agentName)`` and derives
the human-readable state from the LIVE record status:

  DRAFT            -> 'built, not yet submitted for approval'
  PENDING_APPROVAL -> 'awaiting approval on the Approvals page'
  APPROVED         -> 'built and approved'
  REJECTED         -> 'built, but the approval was rejected'
  DEPRECATED       -> 'built, but has been deprecated'

Each test uses the botocore Stubber so kwargs are validated against the
real service model — no mocks that could drift from the API shape.

Job row fixture mirrors the LIVE row shape written by
``arbiter/fabricator/index.py::_write_fabrication_status``.

Run with:
    PYTHONPATH=. pytest tests/test_postfab_live_registry.py -v --tb=short
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from datetime import datetime, timezone
from unittest import mock

import boto3
import pytest
from botocore.stub import Stubber

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import request_context

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")
os.environ.setdefault("FABRICATION_JOBS_TABLE", "jobs-test")
os.environ.setdefault("REGISTRY_ID", "reg-test-1")

import tools.postfab as postfab


# ---------------------------------------------------------------------------
# Helpers — live-shape job rows
# ---------------------------------------------------------------------------

def _fresh_ts():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _job(
    name,
    status,
    registry_approval_status=None,
    updated_at=None,
    org_id="org-1",
):
    """Build a DynamoDB job row with the shape the fabricator writes.

    Keys match arbiter/fabricator/index.py::_write_fabrication_status:
    orchestrationId (PK), agentUseId (SK), status, agentName, updatedAt,
    orgId, registryApprovalStatus, registrationErrors, errorMessage.
    """
    row = {
        "orchestrationId": "sess-1",
        "agentUseId": name,
        "agentName": name,
        "status": status,
        "updatedAt": updated_at or _fresh_ts(),
        "orgId": org_id,
    }
    if registry_approval_status is not None:
        row["registryApprovalStatus"] = registry_approval_status
    return row


def _registry_record(name, status, record_id=None):
    """Build a registry record summary matching the ListRegistryRecords shape."""
    rid = record_id or f"rec-{name[:8].ljust(8, '0')}"
    return {
        "registryArn": f"arn:aws:bedrock-agentcore:us-west-2:123456:registry/reg-test-1",
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456:registry/reg-test-1/record/{rid}",
        "recordId": rid,
        "name": name,
        "description": f"Test agent {name}",
        "descriptorType": "CUSTOM",
        "recordVersion": "1",
        "status": status,
        "createdAt": datetime(2026, 10, 1, tzinfo=timezone.utc),
        "updatedAt": datetime(2026, 10, 25, tzinfo=timezone.utc),
    }


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
def registry_stubber(monkeypatch):
    """Provide a botocore Stubber for the registry client.

    Replaces the lazy singleton so every test gets a fresh client+stubber.
    """
    client = boto3.client(
        "bedrock-agentcore-control", region_name="ap-southeast-2",
    )
    monkeypatch.setattr(postfab, "_registry_client", client)
    monkeypatch.setattr(postfab, "REGISTRY_ID", "reg-test-1")
    stubber = Stubber(client)
    stubber.activate()
    yield stubber
    stubber.deactivate()


@pytest.fixture(autouse=True)
def _bind_session():
    """Bind a request context for every test (org-scoped lookups need it)."""
    request_context.bind_request({
        "session_id": "sess-1",
        "sessionAttributes": {"userId": "u1", "org": "org-1"},
    })


def _stub_list(stubber, agent_name, registry_status):
    """Stub a single ListRegistryRecords call returning one record."""
    stubber.add_response(
        "list_registry_records",
        {
            "registryRecords": [_registry_record(agent_name, registry_status)],
        },
        expected_params={
            "registryId": "reg-test-1",
            "name": agent_name,
            "maxResults": 10,
        },
    )


def _run_status(jobs_table, items, marker_store):
    jobs_table.query.return_value = {"Items": items}
    return json.loads(postfab.check_fabrication_status())


# ===========================================================================
# Live registry status: APPROVED
# ===========================================================================

class TestLiveStatusApproved:
    """Agent was pending_approval at fabrication time but has since been
    approved on the Approvals page — live status should say 'built and approved'."""

    def test_approved_overrides_stale_pending_snapshot(
        self, jobs_table, marker_store, registry_stubber,
    ):
        # Job row says pending_approval (stale snapshot)
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]
        # Registry says APPROVED (live truth)
        _stub_list(registry_stubber, "AgentA", "APPROVED")

        result = _run_status(jobs_table, items, marker_store)

        assert result["ok"] is True
        assert result["status"] == "complete"
        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built and approved"
        # Should NOT be in pending_approval list
        assert result["pending_approval"] == []
        # Should offer activation
        labels = [a["label"] for a in result["actions"]]
        assert any("Activate" in label for label in labels)

    def test_approved_agent_not_gated_on_activation(
        self, jobs_table, marker_store, registry_stubber, monkeypatch,
    ):
        """An agent whose registry record is now APPROVED should not be
        blocked by the activation gate."""
        marker_store["sess-1"] = {"stage": "built"}
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]

        # The activation gate queries the jobs table with pagination
        jobs_table.query.return_value = {"Items": items}

        # Stub for the activation gate's own live resolution
        _stub_list(registry_stubber, "AgentA", "APPROVED")

        execute = mock.MagicMock()
        execute.return_value = {"intakeActivateProjectAgents": {
            "activated": ["AgentA"], "failed": [], "alreadyActive": [],
            "matchedBy": "sessionId",
        }}
        monkeypatch.setattr(postfab.appsync_client, "execute", execute)
        monkeypatch.setattr(postfab, "_propose_app_name", lambda sid: "Test App")

        result = json.loads(postfab.activate_agents())

        assert result["ok"] is True
        execute.assert_called_once()


# ===========================================================================
# Live registry status: PENDING_APPROVAL
# ===========================================================================

class TestLiveStatusPendingApproval:
    """Agent is genuinely still pending approval in the registry."""

    def test_pending_approval_consistent_with_registry(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]
        _stub_list(registry_stubber, "AgentA", "PENDING_APPROVAL")

        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "awaiting approval" in states["AgentA"]
        assert result["pending_approval"] == ["AgentA"]


# ===========================================================================
# Live registry status: DRAFT
# ===========================================================================

class TestLiveStatusDraft:
    """Agent record was never submitted for approval — still in DRAFT."""

    def test_draft_shows_not_submitted(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "DRAFT")

        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "not yet submitted" in states["AgentA"]
        assert result["draft_agents"] == ["AgentA"]
        # Should NOT offer activation — draft agents can't be activated
        labels = [a["label"] for a in result["actions"]]
        assert not any("Activate" in label for label in labels)

    def test_draft_complete_section_mentions_registry(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "DRAFT")

        result = _run_status(jobs_table, items, marker_store)

        assert "not been submitted" in result["summary"]
        assert "registry" in result["summary"].lower()


# ===========================================================================
# Live registry status: REJECTED
# ===========================================================================

class TestLiveStatusRejected:
    """Agent's approval was rejected."""

    def test_rejected_shows_clear_message(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "REJECTED")

        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "rejected" in states["AgentA"]


# ===========================================================================
# Live registry status: DEPRECATED
# ===========================================================================

class TestLiveStatusDeprecated:
    """Agent's record has been deprecated."""

    def test_deprecated_shows_clear_message(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "DEPRECATED")

        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "deprecated" in states["AgentA"]


# ===========================================================================
# Fallback: registry unreachable
# ===========================================================================

class TestRegistryFallback:
    """When the registry is unreachable, fall back to job row snapshot."""

    def test_registry_error_falls_back_to_snapshot(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED", registry_approval_status="pending_approval")]
        # Stub an error
        registry_stubber.add_client_error(
            "list_registry_records",
            service_error_code="InternalServerException",
        )

        result = _run_status(jobs_table, items, marker_store)

        # Should fall back to snapshot: pending_approval
        states = {a["name"]: a["state"] for a in result["agents"]}
        assert "awaiting approval" in states["AgentA"]
        assert result["pending_approval"] == ["AgentA"]

    def test_registry_unset_falls_back_to_snapshot(
        self, jobs_table, marker_store, monkeypatch,
    ):
        monkeypatch.setattr(postfab, "REGISTRY_ID", "")
        items = [_job("AgentA", "COMPLETED")]

        result = _run_status(jobs_table, items, marker_store)

        # No REGISTRY_ID -> assume auto-approved (legacy behavior)
        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built and approved"


# ===========================================================================
# Mixed statuses
# ===========================================================================

class TestMixedLiveStatuses:
    """Multiple agents with different live registry statuses."""

    def test_one_approved_one_pending(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [
            _job("AgentA", "COMPLETED", registry_approval_status="pending_approval"),
            _job("AgentB", "COMPLETED", registry_approval_status="pending_approval"),
        ]
        # A is now approved, B is still pending
        _stub_list(registry_stubber, "AgentA", "APPROVED")
        _stub_list(registry_stubber, "AgentB", "PENDING_APPROVAL")

        result = _run_status(jobs_table, items, marker_store)

        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built and approved"
        assert "awaiting approval" in states["AgentB"]
        assert result["pending_approval"] == ["AgentB"]

    def test_approved_and_failed_sibling(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [
            _job("AgentA", "COMPLETED"),
            _job("AgentB", "FAILED"),
        ]
        _stub_list(registry_stubber, "AgentA", "APPROVED")

        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "partial"
        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "built and approved"

    def test_draft_and_approved_together(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [
            _job("AgentA", "COMPLETED"),
            _job("AgentB", "COMPLETED"),
        ]
        _stub_list(registry_stubber, "AgentA", "DRAFT")
        _stub_list(registry_stubber, "AgentB", "APPROVED")

        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "complete"
        assert result["draft_agents"] == ["AgentA"]
        assert result["pending_approval"] == []
        # Should not offer activation because AgentA is still DRAFT
        assert "not been submitted" in result["summary"]


# ===========================================================================
# Bounded lookups
# ===========================================================================

class TestBoundedLookups:
    """Registry lookups are bounded to _MAX_REGISTRY_LOOKUPS (5)."""

    def test_only_first_five_agents_resolved(
        self, jobs_table, marker_store, registry_stubber,
    ):
        names = [f"Agent{i}" for i in range(7)]
        items = [_job(n, "COMPLETED") for n in names]
        # Stub only the first 5
        for n in names[:5]:
            _stub_list(registry_stubber, n, "APPROVED")

        result = _run_status(jobs_table, items, marker_store)

        # First 5 should have live status; last 2 fall back to snapshot
        states = {a["name"]: a["state"] for a in result["agents"]}
        for n in names[:5]:
            assert states[n] == "built and approved"
        # Last 2 get snapshot fallback (no registryApprovalStatus = auto-approved)
        for n in names[5:]:
            assert states[n] == "built and approved"


# ===========================================================================
# No raw enums
# ===========================================================================

class TestNoRawEnums:
    """Raw registry enums must never reach the conversation."""

    def test_no_raw_enums_in_approved_output(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "APPROVED")

        result = _run_status(jobs_table, items, marker_store)

        blob = json.dumps(result)
        for raw in ("PENDING_APPROVAL", "COMPLETED", "FAILED", "PROCESSING",
                     "PENDING", "DRAFT", "REJECTED", "DEPRECATED"):
            assert raw not in blob, f"raw enum {raw} leaked into tool output"

    def test_no_raw_enums_in_draft_output(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "DRAFT")

        result = _run_status(jobs_table, items, marker_store)

        blob = json.dumps(result)
        for raw in ("PENDING_APPROVAL", "COMPLETED", "FAILED", "PROCESSING",
                     "PENDING", "DRAFT", "REJECTED", "DEPRECATED"):
            assert raw not in blob, f"raw enum {raw} leaked into tool output"

    def test_no_raw_enums_in_pending_output(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "COMPLETED")]
        _stub_list(registry_stubber, "AgentA", "PENDING_APPROVAL")

        result = _run_status(jobs_table, items, marker_store)

        blob = json.dumps(result)
        for raw in ("PENDING_APPROVAL", "COMPLETED", "FAILED", "PROCESSING",
                     "PENDING", "DRAFT", "REJECTED", "DEPRECATED"):
            assert raw not in blob, f"raw enum {raw} leaked into tool output"


# ===========================================================================
# FAILED jobs unchanged
# ===========================================================================

class TestFailedJobsUnchanged:
    """FAILED jobs should NOT trigger registry lookups."""

    def test_failed_job_not_queried(
        self, jobs_table, marker_store, registry_stubber,
    ):
        items = [_job("AgentA", "FAILED")]
        # No stubs added — if a registry call is made it will raise

        result = _run_status(jobs_table, items, marker_store)

        assert result["status"] == "all_failed"
        states = {a["name"]: a["state"] for a in result["agents"]}
        assert states["AgentA"] == "didn't finish"
