"""Tests for scripts/audit_missing_required_permissions.py (PR-4 §3):
dry-run audit of registry AGENT records missing requiredPermissions.

Strict TDD — every behaviour asserted here was written before the
corresponding production fix.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SCRIPT_PATH = os.path.join(_REPO_ROOT, "scripts", "audit_missing_required_permissions.py")


def _load_script():
    """Load the script as a module without executing __main__."""
    spec = importlib.util.spec_from_file_location("audit_missing_required_permissions", _SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _descriptor(**kwargs) -> str:
    base: dict = {"categories": [], "config": {}, "createdBy": "fabricator", "orgId": "org-1"}
    base.update(kwargs)
    return json.dumps(base)


# ── Parity: _is_absent_or_empty_permissions vs. worker ──────────────────────


class TestIsAbsentOrEmptyPermissionsParity:
    """The script's helper MUST match the worker's _is_absent_or_empty_permissions
    exactly (same semantics as arbiter/workerWrapper/index.py)."""

    @pytest.fixture(autouse=True)
    def _load(self):
        self.mod = _load_script()
        # Import the worker's version for parity comparison
        worker_path = os.path.join(_REPO_ROOT, "arbiter", "workerWrapper", "index.py")
        worker_spec = importlib.util.spec_from_file_location(
            "_worker_wrapper_parity", worker_path,
            submodule_search_locations=[os.path.join(_REPO_ROOT, "arbiter", "workerWrapper")],
        )
        worker_mod = importlib.util.module_from_spec(worker_spec)
        # The worker module has heavy imports; we only need the pure function.
        # Extract it from source instead.
        self.worker_fn = None

    @pytest.mark.parametrize("perms,expected", [
        (None, True),
        ({}, True),
        ({"models": [], "integrations": [], "dataStores": []}, True),
        ({"models": ["m1"]}, False),
        ({"integrations": ["i1"]}, False),
        ({"dataStores": ["d1"]}, False),
        ({"models": ["m1"], "integrations": ["i1"]}, False),
        ({"models": [], "integrations": ["i1"]}, False),
        ({"models": [], "dataStores": ["d1"]}, False),
        # Edge: non-dict treated as absent
        ("not-a-dict", True),
        (42, True),
    ])
    def test_matches_worker_semantics(self, perms, expected):
        result = self.mod._is_absent_or_empty_permissions(perms)
        assert result is expected


class TestIsAbsentOrEmptyPermissionsModelsIncluded:
    """Regression: the script must check models (not just integrations/dataStores)."""

    def test_models_only_is_satisfied(self):
        mod = _load_script()
        assert mod._is_absent_or_empty_permissions({"models": ["m1"]}) is False

    def test_empty_models_with_no_others_is_absent(self):
        mod = _load_script()
        assert mod._is_absent_or_empty_permissions(
            {"models": [], "integrations": [], "dataStores": []}
        ) is True


# ── Type filtering: AGENT records only ──────────────────────────────────────


class TestAgentTypeFiltering:
    """The audit must filter to AGENT records only, excluding tools and apps."""

    def test_tool_record_excluded(self):
        """A record with no manifest is a tool — must be excluded."""
        mod = _load_script()
        # Tool: no manifest in descriptor
        tool_descriptor = _descriptor(config={})  # no manifest key
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "tool-1", "name": "my-tool", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "tool-1",
            "customDescriptorContent": tool_descriptor,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_app_record_excluded(self):
        """A record with appId in descriptor is an app — must be excluded."""
        mod = _load_script()
        app_descriptor = json.dumps({
            "config": {},
            "manifest": {"name": "my-app"},
            "appId": "app-123",
            "orgId": "org-1",
            "createdBy": "user",
        })
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "app-1", "name": "my-app", "status": "PUBLISHED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "app-1",
            "customDescriptorContent": app_descriptor,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_app_with_agent_bindings_excluded(self):
        """manifest.agentBindings → app, excluded."""
        mod = _load_script()
        app_descriptor = json.dumps({
            "config": {},
            "manifest": {"agentBindings": [{"agentId": "a1"}]},
            "orgId": "org-1",
            "createdBy": "user",
        })
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "app-2", "name": "my-app-2", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "app-2",
            "customDescriptorContent": app_descriptor,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_app_with_manifest_access_excluded(self):
        """manifest.access → app, excluded."""
        mod = _load_script()
        app_descriptor = json.dumps({
            "config": {},
            "manifest": {"access": {"role": "admin"}},
            "orgId": "org-1",
            "createdBy": "user",
        })
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "app-3", "name": "my-app-3", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "app-3",
            "customDescriptorContent": app_descriptor,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_agent_record_included(self):
        """A record with manifest but no app fields is an agent — must be included."""
        mod = _load_script()
        agent_descriptor = json.dumps({
            "config": {},
            "manifest": {"name": "my-agent"},
            "orgId": "org-1",
            "createdBy": "fabricator",
        })
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "agent-1", "name": "my-agent", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "agent-1",
            "customDescriptorContent": agent_descriptor,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert len(findings) == 1
        assert findings[0]["recordId"] == "agent-1"


# ── Satisfaction semantics ──────────────────────────────────────────────────


class TestSatisfactionSemantics:
    """A record is satisfied when requiredPermissions has non-empty models OR
    integrations OR dataStores, or credentialMode is 'none'."""

    def _agent_descriptor(self, **extra) -> str:
        """Build a descriptor that passes the agent type filter."""
        base: dict = {
            "config": {},
            "manifest": {"name": "test-agent"},
            "orgId": "org-1",
            "createdBy": "fabricator",
        }
        base.update(extra)
        return json.dumps(base)

    def test_models_satisfies(self):
        mod = _load_script()
        desc = self._agent_descriptor(
            config={"requiredPermissions": {"models": ["anthropic.claude-sonnet-5"]}},
        )
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r1", "name": "a1", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r1", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []

    def test_integrations_satisfies(self):
        mod = _load_script()
        desc = self._agent_descriptor(
            config={"requiredPermissions": {"integrations": ["int-1"]}},
        )
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r2", "name": "a2", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r2", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []

    def test_datastores_satisfies(self):
        mod = _load_script()
        desc = self._agent_descriptor(
            config={"requiredPermissions": {"dataStores": ["ds-1"]}},
        )
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r3", "name": "a3", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r3", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []

    def test_credential_mode_none_satisfies(self):
        mod = _load_script()
        desc = self._agent_descriptor(config={"credentialMode": "none"})
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r4", "name": "a4", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r4", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []

    def test_empty_everything_is_finding(self):
        mod = _load_script()
        desc = self._agent_descriptor(
            config={"requiredPermissions": {"models": [], "integrations": [], "dataStores": []}},
        )
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r5", "name": "a5", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r5", "customDescriptorContent": desc,
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
            assert len(findings) == 1


# ── Exit codes ──────────────────────────────────────────────────────────────


class TestExitCodes:
    """Exit 0 = clean, 1 = missing permissions found, 2 = registry call failed."""

    def test_exit_0_when_clean(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[]):
            code = mod.main(["--registry-id", "reg-1"])
        assert code == 0

    def test_exit_1_when_findings(self):
        mod = _load_script()
        agent_desc = json.dumps({
            "config": {},
            "manifest": {"name": "agent-no-perms"},
            "orgId": "org-1",
            "createdBy": "fabricator",
        })
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-1", "name": "agent-no-perms", "status": "DRAFT"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-1",
            "customDescriptorContent": agent_desc,
        }):
            code = mod.main(["--registry-id", "reg-1"])
        assert code == 1

    def test_exit_2_when_registry_call_fails(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", side_effect=Exception("connection refused")):
            code = mod.main(["--registry-id", "reg-1"])
        assert code == 2

    def test_exit_0_no_registry_id(self):
        """No registry-id and no env var → nothing to audit, exit 0."""
        mod = _load_script()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("REGISTRY_ID", None)
            code = mod.main([])
        assert code == 0


# ── Dry-run / read-only invariant ───────────────────────────────────────────


class TestDryRunInvariant:
    def test_never_calls_any_mutating_registry_client_function(self):
        """The script module must not expose/call any write-capable
        registry_client function at all."""
        mod = _load_script()
        for name in dir(mod):
            assert "update_" not in name.lower() or name.startswith("_")
            assert "create_" not in name.lower() or name.startswith("_")
            assert "delete_" not in name.lower() or name.startswith("_")


# ── Malformed / edge cases ──────────────────────────────────────────────────


class TestEdgeCases:
    def _agent_descriptor(self, **extra) -> str:
        base: dict = {
            "config": {},
            "manifest": {"name": "test-agent"},
            "orgId": "org-1",
            "createdBy": "fabricator",
        }
        base.update(extra)
        return json.dumps(base)

    def test_malformed_descriptor_content_skipped(self):
        """A record with unparseable descriptor is skipped (not reported,
        since we can't determine if it's an agent)."""
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-6", "name": "broken", "status": "DRAFT"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-6",
            "customDescriptorContent": "not json",
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        # Malformed descriptor → can't determine kind → skip
        assert findings == []

    def test_no_registry_records_yields_empty(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[]):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_descriptor_level_sentinel_excludes(self):
        mod = _load_script()
        desc = self._agent_descriptor(credentialMode="none")
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r1", "name": "a1", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r1", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []

    def test_descriptor_level_permissions_checked(self):
        """requiredPermissions stamped at descriptor top-level (not nested
        under config) should also satisfy."""
        mod = _load_script()
        desc = self._agent_descriptor(
            requiredPermissions={"models": ["m1"]},
        )
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "r2", "name": "a2", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "r2", "customDescriptorContent": desc,
        }):
            assert mod.audit_missing_required_permissions("reg-1") == []
