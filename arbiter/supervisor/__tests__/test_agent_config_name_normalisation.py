"""Tests for agent-name normalisation in supervisor/agent_config.py.

Incident: an active agent row whose projected ``config`` carried no ``name``
(an empty ``{}`` config, or one keyed differently by the registry
projection) made ``create_agent_specs`` raise ``KeyError: 'name'``, failing
every supervisor task. The loaders now guarantee every returned config has a
``name`` using a documented fallback chain:

    config['name'] -> item['agentId'] -> item['registryRecordId']
                   -> item['_canonicalRecordId']

and WARN when the fallback is used. A config with no identifier at all is
skipped with a WARN. ``create_agent_specs`` skips (WARN) any agent that cannot
form a valid tool spec instead of raising.
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

_SCHEMA = {"type": "object", "properties": {}}


def _fresh_agent_config():
    sys.modules.pop("agent_config", None)
    return importlib.import_module("agent_config")


def _row(config, **overrides) -> dict:
    item = {
        "agentId": "agent-1",
        "orgId": "Default",
        "state": "active",
        "config": config,
    }
    item.update(overrides)
    return item


def _nameless_config() -> dict:
    return {"description": "Does stuff", "schema": _SCHEMA}


def _load(ac, items, org_id="Default"):
    mock_table = MagicMock()
    mock_table.scan.return_value = {"Items": items}
    mock_resource = MagicMock()
    mock_resource.Table.return_value = mock_table
    with patch.object(ac, "dynamodb", mock_resource):
        return ac.load_config_from_dynamodb(org_id=org_id)


def _load_app_scoped(ac, agent_items, app_id="app-1"):
    """Run load_app_scoped_agents with one READY binding per agent item."""
    apps_table = MagicMock()
    apps_table.query.return_value = {
        "Items": [
            {"agentId": item["agentId"], "status": "READY"} for item in agent_items
        ]
    }
    agents_table = MagicMock()
    agents_table.get_item.side_effect = [{"Item": item} for item in agent_items]

    def _dispatch(table_name):
        return apps_table if table_name == ac.APPS_TABLE else agents_table

    mock_resource = MagicMock()
    mock_resource.Table.side_effect = _dispatch
    with patch.object(ac, "dynamodb", mock_resource):
        return ac.load_app_scoped_agents(app_id)


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


def _warns(out: str, action: str) -> list[dict]:
    return [line for line in _json_lines(out) if line.get("action") == action]


class TestLoadConfigNameFallback:
    def test_nameless_config_gets_agent_id_as_name(self):
        ac = _fresh_agent_config()
        result = _load(ac, [_row(_nameless_config(), agentId="agent-xyz")])
        assert [a["name"] for a in result["agents"]] == ["agent-xyz"]

    def test_nameless_config_does_not_crash_create_agent_specs(self):
        ac = _fresh_agent_config()
        result = _load(ac, [_row(_nameless_config(), agentId="agent-xyz")])
        specs = ac.create_agent_specs(result)
        assert specs[0]["toolSpec"]["name"] == "agent-xyz"

    def test_fallback_name_is_what_the_orchestrator_sees_in_the_agent_list(self):
        ac = _fresh_agent_config()
        items = [
            _row(
                {"name": "named-agent", "description": "d", "schema": _SCHEMA},
                agentId="agent-1",
            ),
            _row(_nameless_config(), agentId="agent-2"),
        ]
        specs = ac.create_agent_specs(_load(ac, items))
        assert [s["toolSpec"]["name"] for s in specs] == ["named-agent", "agent-2"]

    def test_config_name_wins_over_agent_id_without_warning(self, capsys):
        ac = _fresh_agent_config()
        cfg = {"name": "cfg-name", "description": "d", "schema": _SCHEMA}
        result = _load(ac, [_row(cfg, agentId="agent-1")])
        assert result["agents"][0]["name"] == "cfg-name"
        assert _warns(capsys.readouterr().out, "name_fallback") == []

    def test_blank_config_name_is_treated_as_missing(self):
        ac = _fresh_agent_config()
        cfg = {"name": "  ", "description": "d", "schema": _SCHEMA}
        result = _load(ac, [_row(cfg, agentId="agent-1")])
        assert result["agents"][0]["name"] == "agent-1"

    def test_falls_back_to_registry_record_id_when_agent_id_absent(self):
        ac = _fresh_agent_config()
        item = _row(_nameless_config(), registryRecordId="rec-77")
        del item["agentId"]
        result = _load(ac, [item])
        assert result["agents"][0]["name"] == "rec-77"

    def test_falls_back_to_canonical_record_id_last(self):
        ac = _fresh_agent_config()
        item = _row(_nameless_config(), _canonicalRecordId="canon-9")
        del item["agentId"]
        result = _load(ac, [item])
        assert result["agents"][0]["name"] == "canon-9"

    def test_fallback_emits_warn_naming_source_and_chosen_name(self, capsys):
        ac = _fresh_agent_config()
        _load(ac, [_row(_nameless_config(), agentId="agent-xyz")])
        warns = _warns(capsys.readouterr().out, "name_fallback")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["component"] == "SupervisorAgentConfig"
        assert warns[0]["agentId"] == "agent-xyz"
        assert warns[0]["source"] == "agentId"
        assert warns[0]["name"] == "agent-xyz"

    def test_config_with_no_identifier_at_all_is_skipped_with_warn(self, capsys):
        ac = _fresh_agent_config()
        item = _row(_nameless_config())
        del item["agentId"]
        good = _row(
            {"name": "good", "description": "d", "schema": _SCHEMA}, agentId="a-2"
        )
        result = _load(ac, [item, good])
        assert [a["name"] for a in result["agents"]] == ["good"]
        assert len(_warns(capsys.readouterr().out, "skip_unnamed_config")) == 1

    def test_normalised_name_survives_approval_field_stamping(self):
        ac = _fresh_agent_config()
        item = _row(
            _nameless_config(), agentId="agent-xyz", registryStatus="APPROVED"
        )
        agent = _load(ac, [item])["agents"][0]
        assert agent["name"] == "agent-xyz"
        assert agent["registryStatus"] == "APPROVED"

    def test_non_dict_config_is_skipped_as_malformed(self, capsys):
        ac = _fresh_agent_config()
        result = _load(ac, [_row('["not", "a", "dict"]'), _row(_nameless_config())])
        assert [a["name"] for a in result["agents"]] == ["agent-1"]
        assert len(_warns(capsys.readouterr().out, "skip_malformed_config")) == 1


class TestEmptyProjectedConfig:
    """Production shape: ``config`` is ``{}`` (only approval metadata is stamped)."""

    def test_empty_config_does_not_crash_the_supervisor_task(self):
        ac = _fresh_agent_config()
        good = _row(
            {"name": "good", "description": "d", "schema": _SCHEMA}, agentId="a-2"
        )
        result = _load(ac, [_row({}, agentId="mRrYn4PhKWoQ"), good])
        specs = ac.create_agent_specs(result)
        assert [s["toolSpec"]["name"] for s in specs] == ["good"]

    def test_create_agent_specs_warns_when_agent_cannot_form_a_tool_spec(self, capsys):
        ac = _fresh_agent_config()
        ac.create_agent_specs({"agents": [{"name": "stub"}]})
        warns = _warns(capsys.readouterr().out, "skip_unusable_agent_spec")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["name"] == "stub"
        assert sorted(warns[0]["missing"]) == ["description", "schema"]


class TestLoadAppScopedAgentsHardening:
    def test_ready_agent_without_config_is_skipped_not_raised(self):
        ac = _fresh_agent_config()
        stub = {"agentId": "stub-agent", "state": "active", "orgId": "Default"}
        good = _row(
            {"name": "good", "description": "d", "schema": _SCHEMA}, agentId="a-2"
        )
        result = _load_app_scoped(ac, [stub, good])
        assert [a["name"] for a in result["agents"]] == ["good"]

    def test_missing_config_emits_warn_with_identifying_fields(self, capsys):
        ac = _fresh_agent_config()
        stub = {
            "agentId": "stub-agent",
            "state": "active",
            "orgId": "Default",
            "_canonicalRecordId": "rec-stub",
        }
        _load_app_scoped(ac, [stub])
        warns = _warns(capsys.readouterr().out, "skip_missing_config")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["component"] == "SupervisorAgentConfig"
        assert warns[0]["agentId"] == "stub-agent"
        assert warns[0]["_canonicalRecordId"] == "rec-stub"

    def test_null_config_is_treated_as_missing(self):
        ac = _fresh_agent_config()
        result = _load_app_scoped(ac, [_row(None, agentId="null-cfg")])
        assert result == {"agents": []}

    def test_nameless_config_gets_fallback_name_and_warn(self, capsys):
        ac = _fresh_agent_config()
        result = _load_app_scoped(
            ac, [_row(_nameless_config(), agentId="agent-xyz")]
        )
        assert [a["name"] for a in result["agents"]] == ["agent-xyz"]
        assert len(_warns(capsys.readouterr().out, "name_fallback")) == 1
