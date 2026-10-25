"""Tests for string-config parsing in tools_config.load_config_from_dynamodb.

Validates that live DynamoDB row shapes (config as JSON string, orgId at
item level) are handled correctly — the regression from PR #390/#391.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-table")


def _fresh_tools_config():
    sys.modules.pop("tools_config", None)
    return importlib.import_module("tools_config")


class TestStringConfigParsing:
    """PR-396 regression: live rows store config as JSON string."""

    def test_string_config_parsed_into_dict(self):
        """Config stored as JSON string is parsed; create_tool_desc works."""
        tc = _fresh_tools_config()

        # Mirror LIVE DynamoDB row shape: config is a JSON STRING, orgId at item level
        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "tool-1",
                    "orgId": "Default",
                    "state": "active",
                    "config": '{"name": "my-tool", "description": "Does stuff", "schema": {"type": "object"}}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        assert len(result["tools"]) == 1
        assert isinstance(result["tools"][0], dict)
        assert result["tools"][0]["name"] == "my-tool"

        # Verify create_tool_desc doesn't TypeError
        descs = tc.create_tool_desc(result)
        assert len(descs) == 1
        assert "my-tool" in descs[0]

    def test_dict_config_still_works(self):
        """Config already a dict (test fixtures) is passed through."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "tool-2",
                    "orgId": "Default",
                    "state": "active",
                    "config": {"name": "dict-tool", "description": "Already a dict", "schema": {"type": "object"}},
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "dict-tool"

    def test_malformed_string_config_skipped_with_warn(self, capsys):
        """A non-JSON string config is skipped with a WARN log."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "tool-bad",
                    "orgId": "Default",
                    "state": "active",
                    "config": "not valid json {{{",
                },
                {
                    "toolId": "tool-good",
                    "orgId": "Default",
                    "state": "active",
                    "config": '{"name": "good-tool", "description": "OK", "schema": {"type": "object"}}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        # Only the valid tool should be loaded
        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "good-tool"

        # Verify WARN log for the malformed config
        captured = capsys.readouterr()
        assert "skip_malformed_config" in captured.out
        assert "tool-bad" in captured.out

    def test_org_filtering_uses_item_level_orgid(self):
        """Org filtering uses the item-level orgId, not inside config."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "tool-a",
                    "orgId": "org-A",
                    "state": "active",
                    "config": '{"name": "tool-a", "description": "A tool", "schema": {"type": "object"}}',
                },
                {
                    "toolId": "tool-b",
                    "orgId": "org-B",
                    "state": "active",
                    "config": '{"name": "tool-b", "description": "B tool", "schema": {"type": "object"}}',
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"):
            result = tc.load_config_from_dynamodb(org_id="org-A")

        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "tool-a"
