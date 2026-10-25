"""Tests for org-scope filtering on _get_existing_agents (C23 fix).

Scanner C23: _get_existing_agents() listed the whole registry and both
printed and bound other tenants' agents.  The fix reads the session org from
request_context, extracts orgId from each summary's descriptors.custom.data,
and drops records whose orgId doesn't match (keeping system records where
orgId is '').

Contract under test:
  - Own-org records are returned.
  - Other-org records are EXCLUDED — never surface in the prompt or become
    bindable.
  - System records (orgId '') are always visible.
  - A session without org_id fails closed (returns {}).

Run with:
    PYTHONPATH=. pytest tests/test_registry_org_scope.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import request_context
import tools.fabricate as fab


def _summary(name: str, record_id: str, org_id: str = "", status: str = "APPROVED",
             description: str = "") -> dict:
    """Build a registry summary dict with optional org_id in custom descriptor."""
    s: dict = {
        "name": name,
        "recordId": record_id,
        "status": status,
        "description": description or f"{name} agent",
    }
    # Embed orgId in descriptors.custom.data, mirroring the real API shape
    # stamped by arbiter/fabricator store_agent_config_registry.
    s["descriptors"] = {
        "custom": {
            "data": json.dumps({"orgId": org_id}),
        },
    }
    return s


def _client(records: list[dict]):
    client = mock.MagicMock()
    client.list_registry_records.return_value = {
        "registryRecords": records,
        "nextToken": None,
    }
    return client


# ── Two-org negative: other org's agents absent ────────────────────────

class TestCrossTenantExclusion:
    """Other org's agents must never appear in the result."""

    def test_other_org_agents_excluded(self, monkeypatch):
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        # Session is bound to org-1 (conftest default)
        records = [
            _summary("own-agent", "r1", org_id="org-1"),
            _summary("other-agent", "r2", org_id="org-other"),
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert "own-agent" in result
        assert "other-agent" not in result

    def test_plan_fabrication_does_not_reuse_other_org_agent(self, monkeypatch):
        """plan_fabrication must classify a same-named agent from another org
        as 'build' (not 'reuse'), since _get_existing_agents filters it out."""
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            _summary("SharedName", "r1", org_id="org-other"),
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        # Stub the LLM extraction to return an agent named SharedName
        monkeypatch.setattr(fab, "_extract_agents", lambda td2, session_id="": [
            {"name": "SharedName", "spec": "spec-a", "requires_external": False},
        ])
        monkeypatch.setattr(fab, "s3_get", lambda key: "fake td2 content")

        result = json.loads(fab.plan_fabrication())

        assert len(result) == 1
        assert result[0]["action"] == "build"
        assert result[0]["name"] == "SharedName"

    def test_list_factory_agents_hides_other_org(self, monkeypatch):
        """list_factory_agents renders only own-org + system agents."""
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            _summary("own-agent", "r1", org_id="org-1"),
            _summary("other-agent", "r2", org_id="org-other"),
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        out = fab.list_factory_agents()

        assert "own-agent" in out
        assert "other-agent" not in out

    def test_many_orgs_only_own_visible(self, monkeypatch):
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            _summary(f"agent-tenant{i}", f"r{i}", org_id=f"tenant-{i}")
            for i in range(10)
        ]
        # Add one for our org (org-1)
        records.append(_summary("my-agent", "rmine", org_id="org-1"))
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert "my-agent" in result
        assert len(result) == 1


# ── System agent visible ───────────────────────────────────────────────

class TestSystemRecordsVisible:
    """Records with orgId '' (system/shared) are visible to every tenant."""

    def test_system_record_visible(self, monkeypatch):
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            _summary("system-agent", "rs", org_id=""),
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert "system-agent" in result

    def test_system_and_own_org_both_visible(self, monkeypatch):
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            _summary("system-agent", "rs", org_id=""),
            _summary("own-agent", "ro", org_id="org-1"),
            _summary("other-agent", "rx", org_id="org-other"),
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert set(result.keys()) == {"system-agent", "own-agent"}

    def test_record_without_descriptors_excluded(self, monkeypatch):
        """When the list summary omits descriptors entirely, orgId resolves
        to None — the record is EXCLUDED (not treated as system).  Live-
        verified: ListRegistryRecords summaries omit descriptors."""
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [
            {"name": "no-desc-agent", "recordId": "rnd", "status": "APPROVED",
             "description": "Agent without descriptors"},
        ]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert "no-desc-agent" not in result


# ── Session without org fails closed ───────────────────────────────────

class TestFailClosed:
    """A session missing org_id must return {} — never expose unscoped data."""

    def test_empty_org_returns_empty(self, monkeypatch):
        # Re-bind with no org
        request_context.bind_request({
            "session_id": "sess-no-org",
            "sessionAttributes": {"userId": "user-1", "org": ""},
        })
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [_summary("any-agent", "r1", org_id="org-1")]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert result == {}

    def test_no_org_attribute_returns_empty(self, monkeypatch):
        request_context.bind_request({
            "session_id": "sess-no-org-attr",
            "sessionAttributes": {"userId": "user-1"},
        })
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")
        records = [_summary("any-agent", "r1", org_id="org-1")]
        monkeypatch.setattr(fab, "_get_registry_client", lambda: _client(records))

        result = fab._get_existing_agents()

        assert result == {}

    def test_outside_request_scope_returns_empty(self, monkeypatch):
        request_context.clear()
        monkeypatch.setattr(fab, "REGISTRY_ID", "reg-1")

        result = fab._get_existing_agents()

        assert result == {}


# ── _extract_org_from_summary unit tests ───────────────────────────────

class TestExtractOrgFromSummary:
    def test_normal_extraction(self):
        summary = _summary("a", "r", org_id="org-42")
        assert fab._extract_org_from_summary(summary) == "org-42"

    def test_missing_descriptors(self):
        assert fab._extract_org_from_summary({"name": "a"}) is None

    def test_empty_data(self):
        summary = {"descriptors": {"custom": {"data": ""}}}
        assert fab._extract_org_from_summary(summary) is None

    def test_malformed_json(self):
        summary = {"descriptors": {"custom": {"data": "not-json"}}}
        assert fab._extract_org_from_summary(summary) is None

    def test_no_orgId_key_in_data(self):
        summary = {"descriptors": {"custom": {"data": json.dumps({"other": "val"})}}}
        assert fab._extract_org_from_summary(summary) == ""

    def test_system_record_explicit_empty_org(self):
        """A descriptor with explicit orgId '' is system — returns ''."""
        summary = _summary("sys", "rs", org_id="")
        assert fab._extract_org_from_summary(summary) == ""
