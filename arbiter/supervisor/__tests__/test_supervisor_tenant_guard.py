"""Tenant isolation test: supervisor catalogue must not include another org's agents.

Validates the PR1 change in ``load_config_from_dynamodb(org_id=...)``:
org-B agents MUST be excluded when the execution's org is org-A.
System records (orgId='') MUST still be included when allow_system=True.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agents-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

_mock_dynamodb = MagicMock()
with patch("boto3.resource", return_value=_mock_dynamodb):
    import agent_config as _agent_config_mod

    _agent_config_mod.dynamodb = _mock_dynamodb
    from agent_config import load_config_from_dynamodb


def _make_item(agent_id, org_id, state="active"):
    return {
        "agentId": agent_id,
        "state": state,
        "orgId": org_id,
        "config": {
            "name": agent_id,
            "orgId": org_id,
            "description": f"Agent {agent_id}",
            "schema": {"type": "object", "properties": {}},
        },
    }


class TestSupervisorTwoOrgNegative:
    """C4 regression: supervisor catalogue excludes other org's agents."""

    def setup_method(self):
        _mock_dynamodb.reset_mock()
        _mock_dynamodb.Table.return_value = MagicMock()
        _agent_config_mod.dynamodb = _mock_dynamodb

    def test_excludes_other_org(self):
        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                _make_item("org-a-agent", "org-a"),
                _make_item("org-b-agent", "org-b"),
            ]
        }
        _mock_dynamodb.Table.return_value = mock_table

        result = load_config_from_dynamodb(org_id="org-a")
        names = [a["name"] for a in result["agents"]]
        assert "org-a-agent" in names
        assert "org-b-agent" not in names

    def test_includes_system_agent(self):
        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                _make_item("org-a-agent", "org-a"),
                _make_item("system-echo", ""),
            ]
        }
        _mock_dynamodb.Table.return_value = mock_table

        result = load_config_from_dynamodb(org_id="org-a")
        names = [a["name"] for a in result["agents"]]
        assert "org-a-agent" in names
        assert "system-echo" in names

    def test_no_filter_when_org_id_none(self):
        """When org_id is None (legacy path), all agents are returned."""
        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                _make_item("org-a-agent", "org-a"),
                _make_item("org-b-agent", "org-b"),
            ]
        }
        _mock_dynamodb.Table.return_value = mock_table

        result = load_config_from_dynamodb(org_id=None)
        names = [a["name"] for a in result["agents"]]
        assert "org-a-agent" in names
        assert "org-b-agent" in names
