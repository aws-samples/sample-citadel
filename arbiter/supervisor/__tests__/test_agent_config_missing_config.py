"""Tests for active agent rows that carry no ``config`` attribute.

Incident: active stub rows (name-keyed projection rows with only
``_canonicalRecordId``/``agentId``/``orgId``/``registryRecordId``/
``registryStatus``/``state``/``statusUpdatedAt``) made
``load_config_from_dynamodb`` raise ``KeyError: 'config'``, failing every
supervisor task. Such rows must be skipped with a WARN, not crash the scan.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")


def _fresh_agent_config():
    sys.modules.pop("agent_config", None)
    return importlib.import_module("agent_config")


def _stub_row(agent_id: str) -> dict:
    return {
        "_canonicalRecordId": f"rec-{agent_id}",
        "agentId": agent_id,
        "orgId": "Default",
        "registryRecordId": f"rec-{agent_id}",
        "registryStatus": "APPROVED",
        "state": "active",
        "statusUpdatedAt": "2026-11-25T00:00:00Z",
    }


def _good_row(agent_id: str, name: str) -> dict:
    return {
        "agentId": agent_id,
        "orgId": "Default",
        "state": "active",
        "config": {"name": name, "description": "ok", "schema": {"type": "object"}},
    }


def _load(ac, items, org_id="Default"):
    mock_table = MagicMock()
    mock_table.scan.return_value = {"Items": items}
    mock_resource = MagicMock()
    mock_resource.Table.return_value = mock_table
    with patch.object(ac, "dynamodb", mock_resource):
        return ac.load_config_from_dynamodb(org_id=org_id)


def _json_lines(out: str) -> list[dict]:
    lines = []
    for raw in out.splitlines():
        raw = raw.strip()
        if raw.startswith("{"):
            try:
                lines.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return lines


class TestActiveRowWithoutConfig:
    def test_active_item_without_config_does_not_raise(self):
        ac = _fresh_agent_config()
        result = _load(ac, [_stub_row("demo-echo-agent")])
        assert result == {"agents": []}

    def test_other_agents_still_load_when_stub_rows_present(self):
        ac = _fresh_agent_config()
        items = [
            _stub_row("demo-echo-agent"),
            _good_row("agent-1", "good-agent"),
            _stub_row("fabricator"),
        ]
        result = _load(ac, items)
        assert [a["name"] for a in result["agents"]] == ["good-agent"]

    def test_missing_config_emits_warn_with_identifying_fields(self, capsys):
        ac = _fresh_agent_config()
        _load(ac, [_stub_row("demo-router-agent")])

        warns = [
            line
            for line in _json_lines(capsys.readouterr().out)
            if line.get("action") == "skip_missing_config"
        ]
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["component"] == "SupervisorAgentConfig"
        assert warns[0]["agentId"] == "demo-router-agent"
        assert warns[0]["orgId"] == "Default"
        assert warns[0]["_canonicalRecordId"] == "rec-demo-router-agent"

    def test_summary_info_line_counts_skipped_items(self, capsys):
        ac = _fresh_agent_config()
        items = [
            _stub_row("demo-echo-agent"),
            _stub_row("smoke-idempotency-agent"),
            _good_row("agent-1", "good-agent"),
        ]
        _load(ac, items)

        summaries = [
            line
            for line in _json_lines(capsys.readouterr().out)
            if line.get("action") == "skipped_unusable_configs"
        ]
        assert len(summaries) == 1
        assert summaries[0]["level"] == "INFO"
        assert summaries[0]["skippedMissingConfig"] == 2

    def test_inactive_stub_row_is_not_counted_or_warned(self, capsys):
        ac = _fresh_agent_config()
        inactive = _stub_row("old-agent")
        inactive["state"] = "inactive"
        _load(ac, [inactive, _good_row("agent-1", "good-agent")])

        out = capsys.readouterr().out
        assert "skip_missing_config" not in out
        assert "skipped_unusable_configs" not in out

    def test_null_config_is_treated_as_missing(self, capsys):
        ac = _fresh_agent_config()
        row = _stub_row("null-config-agent")
        row["config"] = None
        result = _load(ac, [row, _good_row("agent-1", "good-agent")])

        assert [a["name"] for a in result["agents"]] == ["good-agent"]
        assert "skip_missing_config" in capsys.readouterr().out
