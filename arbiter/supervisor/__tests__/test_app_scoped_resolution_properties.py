"""
Property-based tests for app-scoped agent resolution in arbiter/supervisor/agent_config.py

Feature: agent-apps-platform
Tests P22 (app-scoped agent filtering) and P23 (backward-compatible agent loading).
"""

import sys
import os
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agents-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

# Patch boto3 at module level before importing agent_config
_mock_dynamodb = MagicMock()
with patch("boto3.resource", return_value=_mock_dynamodb):
    import agent_config as _agent_config_mod
    _agent_config_mod.dynamodb = _mock_dynamodb
    from agent_config import load_app_scoped_agents, load_config_from_dynamodb


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

agent_id_st = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Nd"), whitelist_characters="-_"),
    min_size=1,
    max_size=20,
).filter(lambda s: s.strip() != "")

binding_status_st = st.sampled_from(["READY", "DESIGN"])
agent_state_st = st.sampled_from(["active", "inactive"])

binding_st = st.fixed_dictionaries({
    "agentId": agent_id_st,
    "status": binding_status_st,
}).map(lambda b: {
    "appId": "app-test",
    "groupId": "APP#app-test",
    "sortId": f"AGENT#{b['agentId']}",
    "agentId": b["agentId"],
    "status": b["status"],
    "addedAt": "2024-01-01T00:00:00Z",
})

agent_item_st = st.fixed_dictionaries({
    "agentId": agent_id_st,
    "state": agent_state_st,
}).map(lambda a: {
    "agentId": a["agentId"],
    "state": a["state"],
    "config": {
        "name": a["agentId"],
        "description": f"Agent {a['agentId']}",
        "schema": {"type": "object", "properties": {}},
    },
})


# ---------------------------------------------------------------------------
# P22: App-scoped agent filtering
# ---------------------------------------------------------------------------

class TestAppScopedAgentFiltering:
    """
    Feature: agent-apps-platform, Property 22: App-scoped agent filtering

    For any app with a mix of DESIGN and READY agent bindings, the Supervisor's
    app-scoped agent resolution should return only agents whose binding status
    is READY and whose agent config state is active.

    **Validates: Requirements 12.2**
    """

    def setup_method(self):
        _mock_dynamodb.reset_mock()
        _mock_dynamodb.Table.side_effect = None
        # Re-pin the mock so this file controls it regardless of import order
        _agent_config_mod.dynamodb = _mock_dynamodb

    @given(
        bindings=st.lists(
            st.fixed_dictionaries({
                "agentId": agent_id_st,
                "status": binding_status_st,
                "state": agent_state_st,
            }),
            min_size=0,
            max_size=8,
        )
    )
    @settings(max_examples=100)
    def test_only_ready_active_agents_returned(self, bindings):
        """Only READY bindings with active agent configs appear in the result.

        **Validates: Requirements 12.2**
        """
        # Deduplicate by agentId (keep last)
        seen = {}
        for b in bindings:
            seen[b["agentId"]] = b
        unique_bindings = list(seen.values())

        # Build mock binding items (as returned by apps table query)
        binding_items = [
            {
                "appId": "app-test",
                "groupId": "APP#app-test",
                "sortId": f"AGENT#{b['agentId']}",
                "agentId": b["agentId"],
                "status": b["status"],
                "addedAt": "2024-01-01T00:00:00Z",
            }
            for b in unique_bindings
        ]

        # Build mock agent items (as returned by agents table get_item)
        agent_items = {
            b["agentId"]: {
                "agentId": b["agentId"],
                "state": b["state"],
                "config": {
                    "name": b["agentId"],
                    "description": f"Agent {b['agentId']}",
                    "schema": {"type": "object", "properties": {}},
                },
            }
            for b in unique_bindings
        }

        # Expected: only bindings with status=READY AND state=active
        expected_agent_ids = {
            b["agentId"]
            for b in unique_bindings
            if b["status"] == "READY" and b["state"] == "active"
        }

        # Setup mocks
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {"Items": binding_items}

        mock_agents_table = MagicMock()

        def get_item_side_effect(Key):
            aid = Key["agentId"]
            if aid in agent_items:
                return {"Item": agent_items[aid]}
            return {}

        mock_agents_table.get_item.side_effect = get_item_side_effect

        _mock_dynamodb.Table.side_effect = lambda name: mock_apps_table if name == os.environ.get("APPS_TABLE") else mock_agents_table

        result = load_app_scoped_agents("app-test")

        returned_names = {a["name"] for a in result["agents"]}
        assert returned_names == expected_agent_ids


# ---------------------------------------------------------------------------
# P23: Backward-compatible agent loading
# ---------------------------------------------------------------------------

class TestBackwardCompatibleAgentLoading:
    """
    Feature: agent-apps-platform, Property 23: Backward-compatible agent loading

    For any task request without an appId field, the Supervisor should load all
    active agents from the config table using the existing load_config_from_dynamodb()
    function, producing the same result as before this feature.

    **Validates: Requirements 12.4**
    """

    def setup_method(self):
        _mock_dynamodb.reset_mock()
        _mock_dynamodb.Table.side_effect = None
        # Re-pin the mock so this file controls it regardless of import order
        _agent_config_mod.dynamodb = _mock_dynamodb

    @given(
        agents=st.lists(
            st.fixed_dictionaries({
                "agentId": agent_id_st,
                "state": agent_state_st,
                "name": st.text(min_size=1, max_size=20).filter(lambda s: s.strip() != ""),
            }),
            min_size=0,
            max_size=8,
        )
    )
    @settings(max_examples=100)
    def test_load_config_returns_only_active_agents(self, agents):
        """Requests without appId use existing load_config_from_dynamodb unchanged.

        **Validates: Requirements 12.4**
        """
        # Deduplicate by agentId
        seen = {}
        for a in agents:
            seen[a["agentId"]] = a
        unique_agents = list(seen.values())

        # Build DynamoDB items as returned by table.scan()
        db_items = [
            {
                "agentId": a["agentId"],
                "state": a["state"],
                "config": {
                    "name": a["name"],
                    "description": f"Agent {a['name']}",
                    "schema": {"type": "object", "properties": {}},
                },
            }
            for a in unique_agents
        ]

        expected_configs = [
            item["config"]
            for item in db_items
            if item["state"] == "active"
        ]

        mock_table = MagicMock()
        mock_table.scan.return_value = {"Items": db_items}
        _mock_dynamodb.Table.return_value = mock_table

        result = load_config_from_dynamodb()

        assert result == {"agents": expected_configs}
