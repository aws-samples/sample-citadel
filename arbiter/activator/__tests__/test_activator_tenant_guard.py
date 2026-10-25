"""Activator tenant-isolation tests (scanner H1 step 2).

Validates:
  1. Missing orgId on event → 403 TENANT_GUARD_MISSING_ORG, no DDB write.
  2. Empty-string orgId → same as missing.
  3. Org mismatch (event org ≠ agent record org) → 403 TENANT_GUARD_ORG_MISMATCH,
     no DDB write.
  4. Matching org proceeds to activate/suspend.
  5. Agent not found after orgId check → 404.
"""

from __future__ import annotations

import logging
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-activator-table")

import index as activator  # noqa: E402


@pytest.fixture(autouse=True)
def _reset():
    activator.__reset_clients_for_test()
    yield
    activator.__reset_clients_for_test()


def _event(agent_id="agent-1", action="activate", actor="alice", org_id=None,
           *, include_org_key=True):
    """Build an EventBridge event dict.  If org_id is None AND
    include_org_key is False, the orgId key is omitted entirely."""
    detail = {
        "agentId": agent_id,
        "action": action,
        "actor": actor,
        "correlationId": "cid-test",
    }
    if include_org_key:
        detail["orgId"] = org_id if org_id is not None else ""
    return {"detail": detail}


def _mock_table(agent_id="agent-1", org_id="org-a"):
    """Table that returns one agent row on get_item."""
    tbl = MagicMock()
    tbl.get_item.return_value = {
        "Item": {"agentId": agent_id, "orgId": org_id, "state": "draft"},
    }
    tbl.update_item.return_value = {}
    return tbl


# ---------------------------------------------------------------------------
# 1. Missing orgId → 403
# ---------------------------------------------------------------------------
class TestMissingOrgId:
    def test_no_orgId_key_returns_403(self, caplog):
        """Event with no orgId key at all → 403 structured error."""
        with caplog.at_level(logging.ERROR):
            result = activator.handler(_event(include_org_key=False))
        assert result["statusCode"] == 403
        assert result["error"] == "TENANT_GUARD_MISSING_ORG"
        assert any("orgId" in r.message or "org" in r.message.lower()
                    for r in caplog.records)

    def test_empty_orgId_returns_403(self):
        """Event with orgId='' → 403."""
        result = activator.handler(_event(org_id=""))
        assert result["statusCode"] == 403
        assert result["error"] == "TENANT_GUARD_MISSING_ORG"

    def test_missing_orgId_does_not_write(self):
        """No DDB update_item when orgId is missing."""
        tbl = _mock_table()
        with patch.object(activator, "_get_table", return_value=tbl):
            activator.handler(_event(org_id=""))
        tbl.update_item.assert_not_called()
        tbl.get_item.assert_not_called()


# ---------------------------------------------------------------------------
# 2. Org mismatch → 403 (two-org negative)
# ---------------------------------------------------------------------------
class TestOrgMismatch:
    def test_event_org_differs_from_agent_org(self):
        """Event org=org-B, agent orgId=org-A → 403 TENANT_GUARD_ORG_MISMATCH."""
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            result = activator.handler(_event(org_id="org-b"))
        assert result["statusCode"] == 403
        assert result["error"] == "TENANT_GUARD_ORG_MISMATCH"

    def test_org_mismatch_no_ddb_write(self):
        """update_item must NOT be called when the org check fails."""
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            activator.handler(_event(org_id="org-b"))
        tbl.update_item.assert_not_called()

    def test_org_mismatch_on_suspend(self):
        """Suspend action also fails on mismatch."""
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            result = activator.handler(_event(action="suspend", org_id="org-b"))
        assert result["statusCode"] == 403
        assert result["error"] == "TENANT_GUARD_ORG_MISMATCH"
        tbl.update_item.assert_not_called()


# ---------------------------------------------------------------------------
# 3. Matching org proceeds
# ---------------------------------------------------------------------------
class TestMatchingOrg:
    def test_activate_with_matching_org(self):
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            result = activator.handler(_event(org_id="org-a"))
        assert result["statusCode"] == 200
        assert result["state"] == "active"
        tbl.update_item.assert_called_once()

    def test_suspend_with_matching_org(self):
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            result = activator.handler(_event(action="suspend", org_id="org-a"))
        assert result["statusCode"] == 200
        assert result["state"] == "suspended"
        tbl.update_item.assert_called_once()


# ---------------------------------------------------------------------------
# 4. Agent not found (after orgId check passes) → 404
# ---------------------------------------------------------------------------
class TestAgentNotFound:
    def test_get_item_returns_none(self):
        """If the agent row doesn't exist at all, 404 before org check."""
        tbl = MagicMock()
        tbl.get_item.return_value = {}  # no Item key
        with patch.object(activator, "_get_table", return_value=tbl):
            result = activator.handler(_event(org_id="org-a"))
        assert result["statusCode"] == 404
        tbl.update_item.assert_not_called()


# ---------------------------------------------------------------------------
# 5. Actor presence (optional validation — actor defaults to 'unknown')
# ---------------------------------------------------------------------------
class TestActorPresence:
    def test_missing_actor_defaults_to_unknown(self):
        """Handler defaults actor to 'unknown' when omitted."""
        tbl = _mock_table("agent-1", "org-a")
        with patch.object(activator, "_get_table", return_value=tbl):
            event = {"detail": {
                "agentId": "agent-1", "action": "activate",
                "orgId": "org-a",
            }}
            result = activator.handler(event)
        assert result["statusCode"] == 200
