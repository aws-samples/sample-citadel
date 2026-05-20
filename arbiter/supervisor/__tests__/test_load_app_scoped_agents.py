"""
Unit tests for load_app_scoped_agents in arbiter/supervisor/agent_config.py

Tests the app-scoped agent resolution logic using boto3 mocks.
Validates: Requirements 12.1, 12.2, 12.3, 12.5, 12.6
"""

import sys
import os
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agents-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

# Patch boto3 at module level before importing agent_config
_mock_dynamodb = MagicMock()
with patch("boto3.resource", return_value=_mock_dynamodb):
    import agent_config as _agent_config_mod
    _agent_config_mod.dynamodb = _mock_dynamodb
    from agent_config import load_app_scoped_agents


def _make_binding(agent_id, status="READY", **overrides):
    item = {
        "appId": "app-1",
        "groupId": "APP#app-1",
        "sortId": f"AGENT#{agent_id}",
        "agentId": agent_id,
        "status": status,
        "addedAt": "2024-01-01T00:00:00Z",
    }
    item.update(overrides)
    return item


def _make_agent_item(agent_id, state="active", name=None, description=None):
    return {
        "agentId": agent_id,
        "state": state,
        "config": {
            "name": name or agent_id,
            "description": description or f"Agent {agent_id}",
            "schema": {"type": "object", "properties": {}},
        },
    }


def _table_dispatch(apps_mock, agents_mock):
    """Return a side_effect function that dispatches Table() calls by name."""
    def _dispatch(table_name):
        if table_name == os.environ.get("APPS_TABLE"):
            return apps_mock
        return agents_mock
    return _dispatch


class TestLoadAppScopedAgents:
    """Unit tests for load_app_scoped_agents."""

    def setup_method(self):
        _mock_dynamodb.reset_mock()
        _mock_dynamodb.Table.side_effect = None
        _mock_dynamodb.Table.return_value = MagicMock()
        # Re-pin the mock so this file controls it regardless of import order
        _agent_config_mod.dynamodb = _mock_dynamodb

    def test_returns_empty_when_no_ready_bindings(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding("agent-1", status="DESIGN"),
                _make_binding("agent-2", status="DESIGN"),
            ]
        }
        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, MagicMock())

        result = load_app_scoped_agents("app-1")
        assert result == {"agents": []}

    def test_returns_empty_when_no_bindings_at_all(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {"Items": []}
        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, MagicMock())

        result = load_app_scoped_agents("app-1")
        assert result == {"agents": []}

    def test_filters_to_ready_bindings_only(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding("agent-1", status="READY"),
                _make_binding("agent-2", status="DESIGN"),
                _make_binding("agent-3", status="READY"),
            ]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.side_effect = [
            {"Item": _make_agent_item("agent-1")},
            {"Item": _make_agent_item("agent-3")},
        ]

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert len(result["agents"]) == 2
        assert result["agents"][0]["name"] == "agent-1"
        assert result["agents"][1]["name"] == "agent-3"

    def test_skips_inactive_agents(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding("agent-1", status="READY"),
                _make_binding("agent-2", status="READY"),
            ]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.side_effect = [
            {"Item": _make_agent_item("agent-1", state="active")},
            {"Item": _make_agent_item("agent-2", state="inactive")},
        ]

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert len(result["agents"]) == 1
        assert result["agents"][0]["name"] == "agent-1"

    def test_skips_missing_agents(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding("agent-1", status="READY"),
                _make_binding("agent-missing", status="READY"),
            ]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.side_effect = [
            {"Item": _make_agent_item("agent-1")},
            {},  # No Item key — agent not found
        ]

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert len(result["agents"]) == 1
        assert result["agents"][0]["name"] == "agent-1"

    def test_applies_system_prompt_addition(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding(
                    "agent-1",
                    status="READY",
                    systemPromptAddition="Always respond in JSON format.",
                ),
            ]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.return_value = {
            "Item": _make_agent_item("agent-1", description="Base description")
        }

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert len(result["agents"]) == 1
        assert "Base description" in result["agents"][0]["description"]
        assert "Always respond in JSON format." in result["agents"][0]["description"]

    def test_applies_model_override(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [
                _make_binding(
                    "agent-1",
                    status="READY",
                    modelOverride="us.anthropic.claude-haiku-3",
                ),
            ]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.return_value = {
            "Item": _make_agent_item("agent-1")
        }

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert len(result["agents"]) == 1
        assert result["agents"][0]["modelOverride"] == "us.anthropic.claude-haiku-3"

    def test_queries_group_index_correctly(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {"Items": []}
        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, MagicMock())

        load_app_scoped_agents("my-app-123")

        mock_apps_table.query.assert_called_once()
        call_kwargs = mock_apps_table.query.call_args[1]
        assert call_kwargs["IndexName"] == "GroupIndex"
        assert ":gid" in call_kwargs["ExpressionAttributeValues"]
        assert call_kwargs["ExpressionAttributeValues"][":gid"] == "APP#my-app-123"
        assert ":prefix" in call_kwargs["ExpressionAttributeValues"]
        assert call_kwargs["ExpressionAttributeValues"][":prefix"] == "AGENT#"

    def test_no_override_fields_when_not_specified(self):
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {
            "Items": [_make_binding("agent-1", status="READY")]
        }

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.return_value = {
            "Item": _make_agent_item("agent-1", description="Original desc")
        }

        _mock_dynamodb.Table.side_effect = _table_dispatch(mock_apps_table, mock_agents_table)

        result = load_app_scoped_agents("app-1")
        assert result["agents"][0]["description"] == "Original desc"
        assert "modelOverride" not in result["agents"][0]
