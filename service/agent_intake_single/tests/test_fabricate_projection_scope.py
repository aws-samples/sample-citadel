"""Tests for _get_existing_agents projection-based org-scoping.

Contract:
- When AGENT_CONFIG_TABLE is set and non-empty, _get_existing_agents reads
  org-scoped agents from the DynamoDB agents cache (projection table) rather
  than issuing per-record GetRegistryRecord detail reads.
- Projection rows carry: agentId, name, orgId, citadelKind, registryStatus,
  description. The function filters citadelKind=="agent", orgId in {session_org, ""},
  registryStatus in {APPROVED, PENDING_APPROVAL}.
- When the projection table is unavailable/empty, falls back to bounded
  sequential GetRegistryRecord detail reads (capped at _DETAIL_READ_CAP).
- Two-org negative: agents from other orgs are never returned.

Run with:
    .venv-arbiter-test/bin/python -m pytest \
        service/agent_intake_single/tests/test_fabricate_projection_scope.py -q
from the repo root.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import request_context

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab


# ---------------------------------------------------------------------------
# Live-shape projection rows (mirrors registry-sync buildAgentProjectionRow)
# ---------------------------------------------------------------------------

def _projection_row(
    agent_id: str,
    name: str,
    org_id: str,
    status: str = "APPROVED",
    kind: str = "agent",
    description: str = "",
) -> dict:
    """Build a live-shape agents cache projection row."""
    return {
        "agentId": agent_id,
        "name": name,
        "orgId": org_id,
        "citadelKind": kind,
        "registryStatus": status,
        "registryRecordId": agent_id,
        "description": description or f"desc for {name}",
        "state": "active",
        "projectionVersion": 3,
        "projectedAt": "2026-10-25T12:00:00.000Z",
    }


# Five fabricated agents matching the "Default" org (live fixture).
LIVE_DEFAULT_AGENTS = [
    _projection_row("rec001", "data-ingest-agent", "Default", "APPROVED"),
    _projection_row("rec002", "data-transform-agent", "Default", "APPROVED"),
    _projection_row("rec003", "report-gen-agent", "Default", "PENDING_APPROVAL"),
    _projection_row("rec004", "alert-monitor-agent", "Default", "APPROVED"),
    _projection_row("rec005", "escalation-router-agent", "Default", "APPROVED"),
]

OTHER_ORG_AGENT = _projection_row("rec010", "other-org-agent", "AcmeCorp", "APPROVED")
SYSTEM_AGENT = _projection_row("rec020", "system-shared-agent", "", "APPROVED")
TOOL_ROW = _projection_row("rec030", "some-tool", "Default", "APPROVED", kind="tool")
DRAFT_AGENT = _projection_row("rec040", "draft-agent", "Default", "DRAFT")
REJECTED_AGENT = _projection_row("rec050", "rejected-agent", "Default", "REJECTED")
NO_ORG_AGENT = {
    "agentId": "rec060", "name": "no-org-agent", "citadelKind": "agent",
    "registryStatus": "APPROVED", "description": "missing orgId",
}


def _bind_session(org_id: str = "Default"):
    """Bind a fake session so request_context.current_session() works."""
    request_context.bind_request({
        "session_id": "test-sess-proj",
        "sessionAttributes": {"userId": "user-1", "org": org_id},
    })


@pytest.fixture(autouse=True)
def _cleanup_session():
    yield
    request_context.clear()


@pytest.fixture
def projection_env(monkeypatch):
    """Set up the test env: AGENT_CONFIG_TABLE present, registry available."""
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-test-123")
    monkeypatch.setattr(fab, "AGENT_CONFIG_TABLE", "citadel-agents-test")
    mock_ddb = mock.MagicMock()
    monkeypatch.setattr(fab, "dynamodb", mock_ddb)
    mock_client = mock.MagicMock()
    monkeypatch.setattr(fab, "_get_registry_client", lambda: mock_client)
    return mock_ddb, mock_client


# -----------------------------------------------------------------------
# Path (A): projection table present and populated
# -----------------------------------------------------------------------

class TestProjectionPath:
    def test_returns_own_org_agents_from_projection(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": LIVE_DEFAULT_AGENTS + [SYSTEM_AGENT]}

        result = fab._get_existing_agents()

        assert len(result) == 6  # 5 Default + 1 system
        assert "data-ingest-agent" in result
        assert "system-shared-agent" in result
        mock_ddb.Table.assert_called_with("citadel-agents-test")

    def test_excludes_other_org_agents(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {
            "Items": LIVE_DEFAULT_AGENTS + [OTHER_ORG_AGENT, SYSTEM_AGENT],
        }

        result = fab._get_existing_agents()

        assert "other-org-agent" not in result
        assert "data-ingest-agent" in result

    def test_excludes_tool_rows(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": [TOOL_ROW] + LIVE_DEFAULT_AGENTS}

        result = fab._get_existing_agents()

        assert "some-tool" not in result

    def test_excludes_draft_and_rejected_statuses(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {
            "Items": LIVE_DEFAULT_AGENTS + [DRAFT_AGENT, REJECTED_AGENT],
        }

        result = fab._get_existing_agents()

        assert "draft-agent" not in result
        assert "rejected-agent" not in result

    def test_excludes_records_with_no_orgId(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": [NO_ORG_AGENT]}

        result = fab._get_existing_agents()

        assert "no-org-agent" not in result

    def test_pending_approval_included(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": LIVE_DEFAULT_AGENTS}

        result = fab._get_existing_agents()

        assert "report-gen-agent" in result
        assert result["report-gen-agent"]["state"] == "active"

    def test_result_shape(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": [LIVE_DEFAULT_AGENTS[0]]}

        result = fab._get_existing_agents()

        agent = result["data-ingest-agent"]
        assert agent["name"] == "data-ingest-agent"
        assert agent["recordId"] == "rec001"
        assert agent["state"] == "active"
        assert "description" in agent

    def test_does_not_call_registry_when_projection_succeeds(self, projection_env):
        mock_ddb, mock_client = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": LIVE_DEFAULT_AGENTS}

        fab._get_existing_agents()

        mock_client.list_registry_records.assert_not_called()
        mock_client.get_registry_record.assert_not_called()

    def test_two_org_negative(self, projection_env):
        """Agents for OrgA must not appear when session is OrgB."""
        mock_ddb, _ = projection_env
        _bind_session("OrgB")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {
            "Items": LIVE_DEFAULT_AGENTS + [OTHER_ORG_AGENT, SYSTEM_AGENT],
        }

        result = fab._get_existing_agents()

        # Only system agent visible; Default and AcmeCorp both excluded
        assert len(result) == 1
        assert "system-shared-agent" in result


# -----------------------------------------------------------------------
# Path (C) fallback: projection table empty → detail reads
# -----------------------------------------------------------------------

class TestDetailReadFallback:
    def test_falls_back_to_detail_reads_when_projection_empty(self, projection_env, monkeypatch):
        mock_ddb, mock_client = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": []}
        # Patch time.sleep to speed up tests
        monkeypatch.setattr(fab.time, "sleep", lambda _: None)

        # Summaries without descriptors (the live shape)
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                {"name": "agent-x", "recordId": "rx1", "status": "APPROVED"},
                {"name": "agent-y", "recordId": "rx2", "status": "APPROVED"},
            ],
        }
        # Detail reads return descriptors with org
        def mock_get_detail(**kwargs):
            rid = kwargs["recordId"]
            org = "Default" if rid == "rx1" else "OtherOrg"
            return {
                "name": kwargs.get("name", ""),
                "recordId": rid,
                "descriptors": {
                    "custom": {
                        "data": json.dumps({"orgId": org}),
                    },
                },
            }
        mock_client.get_registry_record.side_effect = mock_get_detail

        result = fab._get_existing_agents()

        assert "agent-x" in result
        assert "agent-y" not in result  # OtherOrg excluded
        assert mock_client.get_registry_record.call_count == 2

    def test_falls_back_when_projection_table_unset(self, projection_env, monkeypatch):
        mock_ddb, mock_client = projection_env
        _bind_session("Default")
        monkeypatch.setattr(fab, "AGENT_CONFIG_TABLE", "")
        monkeypatch.setattr(fab.time, "sleep", lambda _: None)

        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                {"name": "agent-z", "recordId": "rz1", "status": "APPROVED"},
            ],
        }
        mock_client.get_registry_record.return_value = {
            "recordId": "rz1",
            "descriptors": {
                "custom": {"data": json.dumps({"orgId": "Default"})},
            },
        }

        result = fab._get_existing_agents()

        assert "agent-z" in result

    def test_detail_reads_capped(self, projection_env, monkeypatch):
        mock_ddb, mock_client = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.return_value = {"Items": []}
        monkeypatch.setattr(fab.time, "sleep", lambda _: None)

        # 100 summaries but cap is 60
        summaries = [
            {"name": f"agent-{i}", "recordId": f"r{i}", "status": "APPROVED"}
            for i in range(100)
        ]
        mock_client.list_registry_records.return_value = {"registryRecords": summaries}
        mock_client.get_registry_record.return_value = {
            "recordId": "dummy",
            "descriptors": {"custom": {"data": json.dumps({"orgId": "Default"})}},
        }

        fab._get_existing_agents()

        assert mock_client.get_registry_record.call_count == fab._DETAIL_READ_CAP


# -----------------------------------------------------------------------
# Edge cases / fail-closed behaviour
# -----------------------------------------------------------------------

class TestFailClosed:
    def test_no_session_org_raises_at_bind(self, projection_env):
        from request_context import MissingOrgError
        with pytest.raises(MissingOrgError):
            _bind_session("")  # empty org

    def test_no_request_scope_returns_empty(self, projection_env):
        mock_ddb, _ = projection_env
        request_context.clear()

        result = fab._get_existing_agents()

        assert result == {}

    def test_no_registry_id_returns_empty(self, projection_env):
        mock_ddb, _ = projection_env
        _bind_session("Default")
        fab.REGISTRY_ID = ""

        result = fab._get_existing_agents()

        assert result == {}
        fab.REGISTRY_ID = "reg-test-123"  # restore

    def test_projection_scan_error_falls_back(self, projection_env, monkeypatch):
        mock_ddb, mock_client = projection_env
        _bind_session("Default")
        table = mock.MagicMock()
        mock_ddb.Table.return_value = table
        table.scan.side_effect = Exception("DynamoDB unavailable")
        monkeypatch.setattr(fab.time, "sleep", lambda _: None)

        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                {"name": "fallback-agent", "recordId": "rfb1", "status": "APPROVED"},
            ],
        }
        mock_client.get_registry_record.return_value = {
            "recordId": "rfb1",
            "descriptors": {"custom": {"data": json.dumps({"orgId": "Default"})}},
        }

        result = fab._get_existing_agents()

        assert "fallback-agent" in result
