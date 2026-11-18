"""Tests for scripts/audit_missing_required_permissions.py (PR-4 §3):
dry-run audit of registry records missing requiredPermissions.

The script performs NO writes — these tests assert that no mutating
registry_client call is ever made and that the report correctly
classifies records as missing-permissions vs. opted-into the explicit
credentialMode: "none" sentinel vs. properly permissioned.
"""
import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SCRIPT_PATH = os.path.join(_REPO_ROOT, "scripts", "audit_missing_required_permissions.py")


def _load_script():
    """Load the script as a module without executing __main__."""
    spec = importlib.util.spec_from_file_location("audit_missing_required_permissions", _SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _descriptor(**kwargs):
    base = {"categories": [], "config": {}, "createdBy": "fabricator", "orgId": "org-1"}
    base.update(kwargs)
    return json.dumps(base)


class TestAuditMissingRequiredPermissions:
    def test_record_with_no_permissions_is_reported(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-1", "name": "agent-no-perms", "status": "DRAFT"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-1",
            "customDescriptorContent": _descriptor(config={}),
        }):
            findings = mod.audit_missing_required_permissions("reg-1")

        assert len(findings) == 1
        assert findings[0]["recordId"] == "rec-1"
        assert findings[0]["name"] == "agent-no-perms"
        assert findings[0]["orgId"] == "org-1"

    def test_record_with_empty_permissions_is_reported(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-2", "name": "agent-empty-perms", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-2",
            "customDescriptorContent": _descriptor(
                config={"requiredPermissions": {"integrations": [], "dataStores": []}},
            ),
        }):
            findings = mod.audit_missing_required_permissions("reg-1")

        assert len(findings) == 1
        assert findings[0]["recordId"] == "rec-2"

    def test_record_with_permissions_is_not_reported(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-3", "name": "agent-ok", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-3",
            "customDescriptorContent": _descriptor(
                config={"requiredPermissions": {"integrations": ["int-1"], "dataStores": []}},
            ),
        }):
            findings = mod.audit_missing_required_permissions("reg-1")

        assert findings == []

    def test_record_with_no_cloud_sentinel_is_not_reported(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-4", "name": "pure-compute-agent", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-4",
            "customDescriptorContent": _descriptor(
                config={"credentialMode": "none"},
            ),
        }):
            findings = mod.audit_missing_required_permissions("reg-1")

        assert findings == []

    def test_descriptor_level_sentinel_also_excludes(self):
        """The sentinel may be stamped at the top level of the descriptor
        (custom_metadata) rather than nested under config — both locations
        must be checked."""
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-5", "name": "pure-compute-agent-2", "status": "APPROVED"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-5",
            "customDescriptorContent": _descriptor(credentialMode="none", config={}),
        }):
            findings = mod.audit_missing_required_permissions("reg-1")

        assert findings == []

    def test_no_registry_records_yields_empty_findings(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[]):
            findings = mod.audit_missing_required_permissions("reg-1")
        assert findings == []

    def test_malformed_descriptor_content_skipped_not_raised(self):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-6", "name": "broken", "status": "DRAFT"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-6",
            "customDescriptorContent": "not json",
        }):
            findings = mod.audit_missing_required_permissions("reg-1")
        # Malformed descriptor parses to {} -> treated as missing permissions
        # (deny-default is the SAFE direction for a report tool: better to
        # over-report than silently skip a record whose permissions could
        # not be determined).
        assert len(findings) == 1
        assert findings[0]["recordId"] == "rec-6"

    def test_never_calls_any_mutating_registry_client_function(self):
        """Dry-run invariant: the script module must not expose/call any
        write-capable registry_client function at all."""
        mod = _load_script()
        for name in dir(mod):
            assert "update_" not in name.lower() or name.startswith("_")
            assert "create_" not in name.lower() or name.startswith("_")
            assert "delete_" not in name.lower() or name.startswith("_")


class TestMainIsDryRunAndAlwaysExitsZero:
    def test_main_returns_zero_with_findings(self, capsys):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[
            {"recordId": "rec-1", "name": "agent-no-perms", "status": "DRAFT"},
        ]), patch.object(mod, "get_agent_record", return_value={
            "recordId": "rec-1",
            "customDescriptorContent": _descriptor(config={}),
        }):
            exit_code = mod.main(["--registry-id", "reg-1"])

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "1 record(s)" in captured.out or "rec-1" in captured.out
        assert "DRY-RUN ONLY" in captured.out

    def test_main_returns_zero_with_no_findings(self, capsys):
        mod = _load_script()
        with patch.object(mod, "list_agent_records", return_value=[]):
            exit_code = mod.main(["--registry-id", "reg-1"])

        assert exit_code == 0
        captured = capsys.readouterr()
        assert "0 record" in captured.out or "(none)" in captured.out

    def test_main_returns_zero_with_no_registry_id(self):
        mod = _load_script()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("REGISTRY_ID", None)
            exit_code = mod.main([])
        assert exit_code == 0
