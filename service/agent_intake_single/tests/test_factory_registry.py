"""Tests for registry-backed factory-agent discovery (Bug A).

Fabricated agents are written to the AgentCore Registry (via the arbiter's
store_agent_config_registry), NOT to AGENT_CONFIG_TABLE. So _get_existing_agents
must read the registry; otherwise list_factory_agents / plan_fabrication never
see fabricated ap-*-agent-v1 agents.

Contract under test:
  - _get_existing_agents returns a dict keyed by registry record NAME, each
    value carrying name/state/recordId/description/sourceProjectId.
  - State is derived from the registry record status (APPROVED-family -> active,
    DRAFT/CREATING -> draft, otherwise inactive).
  - Tool records (no `manifest` in custom metadata) are excluded.
  - When REGISTRY_ID is unset OR the list call raises, it logs and returns {}
    without raising.
  - list_factory_agents renders the registry-backed agents.

Run with:
    PYTHONPATH=. pytest tests/test_factory_registry.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab


def _client(records, details):
    """Build a mock bedrock-agentcore-control client.

    Pinned to the REAL ListRegistryRecords response shape: summaries are
    returned under the "registryRecords" key (live-verified; the backend's
    registry-service.ts consumes the same key), NOT "records".

    Args:
        records: summary dicts returned by list_registry_records.
        details: {recordId: full record dict} returned by get_registry_record.
    """
    client = mock.MagicMock()
    client.list_registry_records.return_value = {"registryRecords": records, "nextToken": None}

    def _get(registryId, recordId):  # noqa: N803 — boto3 kwarg names
        return details[recordId]

    client.get_registry_record.side_effect = _get
    return client


def _agent_detail(name, record_id, status, description, source_project_id=None):
    meta = {"manifest": {"name": name}}
    if source_project_id is not None:
        meta["sourceProjectId"] = source_project_id
    return {
        "name": name,
        "recordId": record_id,
        "status": status,
        "description": description,
        "descriptors": {"custom": {"inlineContent": json.dumps(meta)}},
    }


def test_get_existing_agents_returns_registry_backed_dict(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [{"name": "ap-billing-agent-v1", "recordId": "rec1", "status": "DRAFT"}]
    details = {
        "rec1": _agent_detail(
            "ap-billing-agent-v1", "rec1", "APPROVED", "Billing agent", "proj-9"
        )
    }
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records, details))

    result = fab._get_existing_agents()

    assert "ap-billing-agent-v1" in result
    entry = result["ap-billing-agent-v1"]
    assert entry["name"] == "ap-billing-agent-v1"
    assert entry["recordId"] == "rec1"
    assert entry["state"] == "active"  # APPROVED (from the detail) -> active
    assert entry["description"] == "Billing agent"
    assert entry["sourceProjectId"] == "proj-9"


def test_get_existing_agents_maps_draft_state(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [{"name": "ap-draft-agent-v1", "recordId": "rd", "status": "DRAFT"}]
    details = {"rd": _agent_detail("ap-draft-agent-v1", "rd", "DRAFT", "Draft agent")}
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records, details))

    result = fab._get_existing_agents()

    assert result["ap-draft-agent-v1"]["state"] == "draft"
    assert result["ap-draft-agent-v1"]["sourceProjectId"] is None


def test_get_existing_agents_empty_when_registry_id_unset(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "")
    client = mock.MagicMock()
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    assert fab._get_existing_agents() == {}
    client.list_registry_records.assert_not_called()


def test_get_existing_agents_empty_when_list_raises(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    client = mock.MagicMock()
    client.list_registry_records.side_effect = Exception("registry down")
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    # Must degrade gracefully — never raise.
    assert fab._get_existing_agents() == {}


def test_get_existing_agents_skips_tool_records(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [
        {"name": "ap-agent-v1", "recordId": "a", "status": "APPROVED"},
        {"name": "some-tool", "recordId": "t", "status": "APPROVED"},
    ]
    details = {
        "a": _agent_detail("ap-agent-v1", "a", "APPROVED", "An agent"),
        # Tool record: custom metadata has no `manifest` discriminator.
        "t": {
            "name": "some-tool",
            "recordId": "t",
            "status": "APPROVED",
            "description": "A tool",
            "descriptors": {"custom": {"inlineContent": json.dumps({"config": {}})}},
        },
    }
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records, details))

    result = fab._get_existing_agents()

    assert "ap-agent-v1" in result
    assert "some-tool" not in result


def test_get_existing_agents_paginates(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    client = mock.MagicMock()
    page1 = {"registryRecords": [{"name": "a1", "recordId": "r1", "status": "APPROVED"}], "nextToken": "tok"}
    page2 = {"registryRecords": [{"name": "a2", "recordId": "r2", "status": "APPROVED"}], "nextToken": None}
    client.list_registry_records.side_effect = [page1, page2]
    details = {
        "r1": _agent_detail("a1", "r1", "APPROVED", "first"),
        "r2": _agent_detail("a2", "r2", "APPROVED", "second"),
    }
    client.get_registry_record.side_effect = lambda registryId, recordId: details[recordId]  # noqa: N803
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert set(result) == {"a1", "a2"}
    assert client.list_registry_records.call_count == 2


def test_list_factory_agents_renders_registry_agents(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [{"name": "ap-billing-agent-v1", "recordId": "rec1", "status": "DRAFT"}]
    details = {"rec1": _agent_detail("ap-billing-agent-v1", "rec1", "DRAFT", "Billing agent")}
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records, details))

    out = fab.list_factory_agents()

    assert "ap-billing-agent-v1" in out
    assert "Billing agent" in out
    assert "draft" in out


def test_list_factory_agents_empty_message(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "")
    out = fab.list_factory_agents()
    assert "No agents" in out


def test_get_existing_agents_tolerates_legacy_records_key(monkeypatch):
    """Fallback: older/local API stubs returned summaries under "records".

    The primary key is "registryRecords" (the real API shape); when absent,
    the legacy "records" key must still be honored so nothing regresses.
    """
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    client = mock.MagicMock()
    client.list_registry_records.return_value = {
        "records": [{"name": "ap-legacy-agent-v1", "recordId": "rl", "status": "APPROVED"}],
        "nextToken": None,
    }
    details = {"rl": _agent_detail("ap-legacy-agent-v1", "rl", "APPROVED", "Legacy agent")}
    client.get_registry_record.side_effect = lambda registryId, recordId: details[recordId]  # noqa: N803
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert "ap-legacy-agent-v1" in result
    assert result["ap-legacy-agent-v1"]["recordId"] == "rl"
