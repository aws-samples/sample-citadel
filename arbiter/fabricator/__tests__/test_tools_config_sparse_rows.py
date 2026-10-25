"""Tests for sparse-row tolerance and deduplication in tools_config.

PR-397: projection rows written by registry-sync may carry a sparse config
(only {name}) or a full config ({name, description, schema, filename, version}).
The fabricator catalogue must skip sparse rows with a WARN and prefer the most
complete config when a tool name appears in both legacy and projection rows.
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


class TestSparseRowTolerance:
    """Projection rows with incomplete config are skipped, not crashed on."""

    def test_sparse_string_config_skipped_with_warn(self, capsys):
        """A projection row whose config is JSON but only {name} is skipped."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "proj-sparse",
                    "orgId": "Default",
                    "state": "active",
                    "config": '{"name": "sparse-tool"}',
                    "citadelKind": "tool",
                    "projectionVersion": 1,
                },
                {
                    "toolId": "proj-full",
                    "orgId": "Default",
                    "state": "active",
                    "config": json.dumps({
                        "name": "full-tool",
                        "description": "A complete tool",
                        "schema": {"type": "object", "properties": {}},
                    }),
                    "citadelKind": "tool",
                    "projectionVersion": 1,
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"), \
             patch.object(tc, "_emit_sparse_metric"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        # Only the full tool should be loaded
        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "full-tool"

        # Verify WARN log for the sparse config
        captured = capsys.readouterr()
        assert "skip_sparse_config" in captured.out
        assert "proj-sparse" in captured.out

    def test_full_projection_string_config_used(self):
        """A projection row with full config (JSON string) is loaded."""
        tc = _fresh_tools_config()

        full_config = {
            "name": "crm-lookup",
            "description": "Look up CRM records",
            "schema": {"type": "object", "properties": {"id": {"type": "string"}}},
            "filename": "crm_lookup.py",
            "version": "2.0.0",
        }

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "proj-crm",
                    "orgId": "Default",
                    "state": "active",
                    "config": json.dumps(full_config),
                    "citadelKind": "tool",
                    "projectionVersion": 1,
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"), \
             patch.object(tc, "_emit_sparse_metric"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        assert len(result["tools"]) == 1
        tool = result["tools"][0]
        assert tool["name"] == "crm-lookup"
        assert tool["description"] == "Look up CRM records"
        assert tool["schema"] == full_config["schema"]
        assert tool["filename"] == "crm_lookup.py"
        assert tool["version"] == "2.0.0"

        # Verify create_tool_specs doesn't crash
        specs = tc.create_tool_specs(result)
        assert len(specs) == 1
        assert specs[0]["toolSpec"]["name"] == "crm-lookup"

    def test_legacy_map_row_loaded(self):
        """A legacy row with config as a DynamoDB MAP (dict) works."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "legacy-tool",
                    "orgId": "Default",
                    "state": "active",
                    "config": {
                        "name": "legacy-tool",
                        "description": "A legacy tool",
                        "schema": {"type": "object"},
                        "filename": "legacy.py",
                        "version": "1.0.0",
                    },
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"), \
             patch.object(tc, "_emit_sparse_metric"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "legacy-tool"

    def test_dedupe_prefers_most_complete_config(self):
        """When same tool name appears as legacy + projection, the most complete wins."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                # Legacy row (MAP) — has all fields
                {
                    "toolId": "my-tool-legacy",
                    "orgId": "Default",
                    "state": "active",
                    "config": {
                        "name": "my-tool",
                        "description": "Legacy desc",
                        "schema": {"type": "object"},
                        "filename": "tool.py",
                        "version": "1.0.0",
                    },
                },
                # Projection row (STRING) — also has all fields but more
                {
                    "toolId": "rec_my_tool_01",
                    "orgId": "Default",
                    "state": "active",
                    "config": json.dumps({
                        "name": "my-tool",
                        "description": "Updated projection desc",
                        "schema": {"type": "object", "properties": {"x": {"type": "string"}}},
                        "filename": "tool_v2.py",
                        "version": "2.0.0",
                        "extraField": "bonus",
                    }),
                    "citadelKind": "tool",
                    "projectionVersion": 1,
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"), \
             patch.object(tc, "_emit_sparse_metric"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        # Only one entry for "my-tool" — the projection row wins (more fields)
        assert len(result["tools"]) == 1
        assert result["tools"][0]["version"] == "2.0.0"
        assert result["tools"][0]["description"] == "Updated projection desc"

    def test_create_tool_specs_safe_defaults(self):
        """create_tool_specs uses .get() and never raises KeyError."""
        tc = _fresh_tools_config()

        # Tool with all fields
        config = {
            "tools": [
                {"name": "a", "description": "desc-a", "schema": {"type": "object"}},
            ]
        }
        specs = tc.create_tool_specs(config)
        assert len(specs) == 1
        assert specs[0]["toolSpec"]["name"] == "a"

    def test_create_tool_specs_skips_nameless(self):
        """create_tool_specs skips tools without a name."""
        tc = _fresh_tools_config()

        config = {"tools": [{"description": "no name", "schema": {}}]}
        specs = tc.create_tool_specs(config)
        assert len(specs) == 0

    def test_create_tool_desc_safe_defaults(self):
        """create_tool_desc uses .get() and never raises KeyError."""
        tc = _fresh_tools_config()

        config = {
            "tools": [
                {"name": "b", "description": "desc-b"},
            ]
        }
        descs = tc.create_tool_desc(config)
        assert len(descs) == 1
        assert "b" in descs[0]

    def test_create_tool_specs_accepts_inputschema_alias(self):
        """create_tool_specs accepts inputSchema as an alias for schema."""
        tc = _fresh_tools_config()

        config = {
            "tools": [
                {"name": "c", "description": "desc-c", "inputSchema": {"type": "string"}},
            ]
        }
        specs = tc.create_tool_specs(config)
        assert len(specs) == 1
        assert specs[0]["toolSpec"]["inputSchema"]["json"] == {"type": "string"}

    def test_missing_config_key_skipped(self, capsys):
        """An item with no 'config' key at all is skipped with WARN."""
        tc = _fresh_tools_config()

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "toolId": "no-config",
                    "orgId": "Default",
                    "state": "active",
                    # no 'config' key at all
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch.object(tc, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc, "CONFIG_TABLE", "fake-tool-table"), \
             patch.object(tc, "_emit_sparse_metric"):
            result = tc.load_config_from_dynamodb(org_id="Default")

        assert len(result["tools"]) == 0
        captured = capsys.readouterr()
        assert "skip_missing_config" in captured.out
