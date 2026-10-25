"""Tests for string-config parsing in supervisor/agent_config.py.

Validates that live DynamoDB row shapes (config as JSON string) are
handled correctly — same fix as tools_config.py for PR #396.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")


def _fresh_agent_config():
    sys.modules.pop("agent_config", None)
    return importlib.import_module("agent_config")


class TestSupervisorStringConfigParsing:
    """PR-396 regression: live rows may store config as JSON string."""

    def test_string_config_parsed_into_dict(self):
        """Config stored as JSON string is parsed; create_agent_specs works."""
        ac = _fresh_agent_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "agentId": "agent-1",
                    "orgId": "Default",
                    "state": "active",
                    "config": '{"name": "my-agent", "description": "Does stuff", "schema": {"type": "object", "properties": {}}}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(ac, "dynamodb", mock_resource):
            result = ac.load_config_from_dynamodb(org_id="Default")

        assert len(result["agents"]) == 1
        assert isinstance(result["agents"][0], dict)
        assert result["agents"][0]["name"] == "my-agent"

        # Verify create_agent_specs doesn't TypeError
        specs = ac.create_agent_specs(result)
        assert len(specs) == 1
        assert specs[0]["toolSpec"]["name"] == "my-agent"

    def test_dict_config_still_works(self):
        """Config already a dict is passed through unchanged."""
        ac = _fresh_agent_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "agentId": "agent-2",
                    "orgId": "Default",
                    "state": "active",
                    "config": {"name": "dict-agent", "description": "Already a dict", "schema": {"type": "object"}},
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(ac, "dynamodb", mock_resource):
            result = ac.load_config_from_dynamodb(org_id="Default")

        assert len(result["agents"]) == 1
        assert result["agents"][0]["name"] == "dict-agent"

    def test_malformed_string_config_skipped_with_warn(self, capsys):
        """A non-JSON string config is skipped with a WARN log."""
        ac = _fresh_agent_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "agentId": "agent-bad",
                    "orgId": "Default",
                    "state": "active",
                    "config": "totally not json",
                },
                {
                    "agentId": "agent-good",
                    "orgId": "Default",
                    "state": "active",
                    "config": '{"name": "good-agent", "description": "OK", "schema": {"type": "object"}}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(ac, "dynamodb", mock_resource):
            result = ac.load_config_from_dynamodb(org_id="Default")

        assert len(result["agents"]) == 1
        assert result["agents"][0]["name"] == "good-agent"

        captured = capsys.readouterr()
        assert "skip_malformed_config" in captured.out
        assert "agent-bad" in captured.out

    def test_approval_fields_stamped_on_parsed_config(self):
        """registryStatus and createdAt are stamped even when config was a string."""
        ac = _fresh_agent_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "agentId": "agent-3",
                    "orgId": "Default",
                    "state": "active",
                    "registryStatus": "APPROVED",
                    "createdAt": "2024-01-01T00:00:00Z",
                    "config": '{"name": "stamped-agent", "description": "Test"}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(ac, "dynamodb", mock_resource):
            result = ac.load_config_from_dynamodb(org_id="Default")

        agent = result["agents"][0]
        assert agent["registryStatus"] == "APPROVED"
        assert agent["createdAt"] == "2024-01-01T00:00:00Z"
