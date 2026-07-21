"""Tests for registry-backed factory-agent discovery.

Fabricated agents are written to the AgentCore Registry (via the arbiter's
store_agent_config_registry), NOT to AGENT_CONFIG_TABLE. So _get_existing_agents
must read the registry; otherwise list_factory_agents / plan_fabrication never
see fabricated ap-*-agent-v1 agents.

Contract under test (post registry-N+1 fix — live incident: 340 records ×
sequential GetRegistryRecord with retries blew the 30s tool budget):
  - _get_existing_agents builds its catalog from LIST-PAGE SUMMARIES ONLY and
    NEVER issues per-record GetRegistryRecord calls. Its consumers
    (plan_fabrication reuse-matching, list_factory_agents, postfab
    _compose_steps, plan_doc) consume only name/state/recordId/description —
    all present on summaries; nothing reads inlineContent-derived fields.
  - Returns a dict keyed by registry record NAME, each value carrying
    name/state/recordId/description.
  - State is derived from the SUMMARY status (APPROVED-family -> active,
    DRAFT/CREATING -> draft, otherwise inactive).
  - When REGISTRY_ID is unset OR the list call raises, it logs and returns {}
    without raising.
  - list_factory_agents renders the registry-backed agents.

Run with:
    PYTHONPATH=. pytest tests/test_factory_registry.py -q
from the service/agent_intake_single directory.
"""
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab


def _client(records):
    """Build a mock bedrock-agentcore-control client.

    Pinned to the REAL ListRegistryRecords response shape: summaries are
    returned under the "registryRecords" key (live-verified; the backend's
    registry-service.ts consumes the same key), NOT "records".
    """
    client = mock.MagicMock()
    client.list_registry_records.return_value = {"registryRecords": records, "nextToken": None}
    return client


def test_get_existing_agents_returns_summary_backed_dict(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [
        {"name": "ap-billing-agent-v1", "recordId": "rec1", "status": "APPROVED", "description": "Billing agent"}
    ]
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

    result = fab._get_existing_agents()

    assert "ap-billing-agent-v1" in result
    entry = result["ap-billing-agent-v1"]
    assert entry == {
        "name": "ap-billing-agent-v1",
        "recordId": "rec1",
        "state": "active",  # APPROVED (from the summary) -> active
        "description": "Billing agent",
    }


def test_get_existing_agents_never_issues_per_record_gets(monkeypatch):
    """The N+1 regression guard: summaries suffice for every consumer, so a
    340-record registry must produce exactly ONE list call per page and ZERO
    GetRegistryRecord calls."""
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [
        {"name": f"ap-agent-{i}-v1", "recordId": f"r{i}", "status": "APPROVED", "description": f"Agent {i}"}
        for i in range(340)
    ]
    client = _client(records)
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert len(result) == 340
    client.get_registry_record.assert_not_called()
    assert client.list_registry_records.call_count == 1


def test_get_existing_agents_maps_draft_state(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [{"name": "ap-draft-agent-v1", "recordId": "rd", "status": "DRAFT", "description": "Draft agent"}]
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

    result = fab._get_existing_agents()

    assert result["ap-draft-agent-v1"]["state"] == "draft"


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


def test_get_existing_agents_includes_unclassifiable_records_without_gets(monkeypatch):
    """Documented tradeoff of the N+1 fix: agent-vs-tool classification lives
    in the record's inlineContent (the `manifest` discriminator), which only a
    per-record GET can see. Summaries cannot distinguish, and no consumer
    matches anything but exact designed-agent names — so records sharing the
    registry are INCLUDED rather than paying 340 sequential GETs (which blew
    the live 30s budget)."""
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [
        {"name": "ap-agent-v1", "recordId": "a", "status": "APPROVED", "description": "An agent"},
        {"name": "some-tool", "recordId": "t", "status": "APPROVED", "description": "A tool"},
    ]
    client = _client(records)
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert "ap-agent-v1" in result
    assert "some-tool" in result
    client.get_registry_record.assert_not_called()


def test_get_existing_agents_paginates(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    client = mock.MagicMock()
    page1 = {"registryRecords": [{"name": "a1", "recordId": "r1", "status": "APPROVED", "description": "first"}], "nextToken": "tok"}
    page2 = {"registryRecords": [{"name": "a2", "recordId": "r2", "status": "APPROVED", "description": "second"}], "nextToken": None}
    client.list_registry_records.side_effect = [page1, page2]
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert set(result) == {"a1", "a2"}
    assert client.list_registry_records.call_count == 2
    client.get_registry_record.assert_not_called()


def test_list_factory_agents_renders_registry_agents(monkeypatch):
    monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
    records = [{"name": "ap-billing-agent-v1", "recordId": "rec1", "status": "DRAFT", "description": "Billing agent"}]
    monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

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
        "records": [{"name": "ap-legacy-agent-v1", "recordId": "rl", "status": "APPROVED", "description": "Legacy agent"}],
        "nextToken": None,
    }
    monkeypatch.setattr(fab, "_get_registry_client", lambda: client)

    result = fab._get_existing_agents()

    assert "ap-legacy-agent-v1" in result
    assert result["ap-legacy-agent-v1"]["recordId"] == "rl"
