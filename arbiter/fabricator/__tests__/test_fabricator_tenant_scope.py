"""Tests for fabricator tenant-scope hardening (§2.2 C/D).

Covers:
  C — _find_existing_record_id org-scoped idempotency lookup
  C — load_config_from_dynamodb org-scoped tool catalogue
  D — upload_to_s3 scoped S3 key + codeSha256 stamping
"""

import hashlib
import json
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import _find_existing_record_id, _extract_org_from_summary, upload_to_s3
import index


# ---------------------------------------------------------------------------
# §2.2-C: _find_existing_record_id — two-org negative
# ---------------------------------------------------------------------------

class TestFindExistingRecordIdOrgScope:
    """_find_existing_record_id must respect orgId when org_id is passed."""

    def _make_summary(self, name, record_id, org_id):
        """Build a registry summary dict with embedded orgId."""
        return {
            "displayName": name,
            "recordId": record_id,
            "descriptors": {
                "custom": {
                    "data": json.dumps({"orgId": org_id}),
                },
            },
        }

    def test_same_name_different_org_returns_none(self):
        """Org-A's 'SalesBot' must NOT match when org_id='org-B'."""
        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                self._make_summary("SalesBot", "rec-A", "org-A"),
            ],
        }
        with patch.object(index, "_get_registry_client", return_value=mock_client):
            result = _find_existing_record_id("reg-1", "SalesBot", org_id="org-B")
        assert result is None

    def test_same_name_same_org_returns_record_id(self):
        """Org-A's 'SalesBot' matches when org_id='org-A'."""
        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                self._make_summary("SalesBot", "rec-A", "org-A"),
            ],
        }
        with patch.object(index, "_get_registry_client", return_value=mock_client):
            result = _find_existing_record_id("reg-1", "SalesBot", org_id="org-A")
        assert result == "rec-A"

    def test_multiple_same_name_picks_matching_org(self):
        """When the registry has same-name records for two orgs, pick the caller's."""
        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                self._make_summary("SalesBot", "rec-A", "org-A"),
                self._make_summary("SalesBot", "rec-B", "org-B"),
            ],
        }
        with patch.object(index, "_get_registry_client", return_value=mock_client):
            result = _find_existing_record_id("reg-1", "SalesBot", org_id="org-B")
        assert result == "rec-B"

    def test_no_org_id_falls_back_to_name_only_match(self):
        """Legacy callers (org_id='') match on name only."""
        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                self._make_summary("SalesBot", "rec-A", "org-A"),
            ],
        }
        with patch.object(index, "_get_registry_client", return_value=mock_client):
            result = _find_existing_record_id("reg-1", "SalesBot", org_id="")
        assert result == "rec-A"

    def test_missing_descriptors_treated_as_empty_org(self):
        """A record with no descriptors has orgId=='' — only matches empty org_id."""
        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {
            "registryRecords": [
                {"displayName": "SalesBot", "recordId": "rec-X"},
            ],
        }
        with patch.object(index, "_get_registry_client", return_value=mock_client):
            result = _find_existing_record_id("reg-1", "SalesBot", org_id="org-A")
        assert result is None


# ---------------------------------------------------------------------------
# §2.2-C: tools_config.load_config_from_dynamodb — two-org negative
# ---------------------------------------------------------------------------

class TestLoadConfigOrgScope:
    """load_config_from_dynamodb must filter tool catalogue by org."""

    def test_filters_tools_to_callers_org(self):
        """Only tools belonging to org-A are returned when org_id='org-A'."""
        # Import the tools_config that fabricator/index.py actually uses.
        # The arbiter conftest rebinds sys.modules per test, so import it
        # fresh from the fabricator's own sys.path to stay aligned.
        import importlib
        tc_mod = importlib.import_module("tools_config")

        mock_table = MagicMock()
        mock_table.scan.return_value = {
            "Items": [
                {
                    "state": "active",
                    "orgId": "org-A",
                    "config": {"name": "tool-a", "description": "Tool A"},
                },
                {
                    "state": "active",
                    "orgId": "org-B",
                    "config": {"name": "tool-b", "description": "Tool B"},
                },
            ],
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        # CONFIG_TABLE is a module-level global evaluated at import time;
        # ensure it's non-None even if the env var was absent at import.
        with patch.object(tc_mod, "_get_dynamodb", return_value=mock_resource), \
             patch.object(tc_mod, "CONFIG_TABLE", "fake-tool-table"):
            result = tc_mod.load_config_from_dynamodb(org_id="org-A")

        assert len(result["tools"]) == 1
        assert result["tools"][0]["name"] == "tool-a"

    def test_empty_org_id_returns_empty(self):
        """Fail-closed: empty org_id returns no tools."""
        import importlib
        tc_mod = importlib.import_module("tools_config")
        result = tc_mod.load_config_from_dynamodb(org_id="")
        assert result == {"tools": []}


# ---------------------------------------------------------------------------
# §2.2-D: S3 key layout + codeSha256
# ---------------------------------------------------------------------------

class TestUploadToS3ScopedKey:
    """upload_to_s3 must use {folder}/{record_id}/{basename} and return sha256."""

    def test_scoped_key_and_sha256(self, tmp_path):
        """S3 key is agents/{record_id}/{basename} and sha256 is correct."""
        code = b"print('hello')"
        expected_sha = hashlib.sha256(code).hexdigest()
        test_file = tmp_path / "my_agent.py"
        test_file.write_bytes(code)

        mock_s3 = MagicMock()
        os.environ["AGENT_BUCKET_NAME"] = "test-bucket"
        try:
            with patch("index.boto3") as mock_boto3:
                mock_boto3.client.return_value = mock_s3
                sha = upload_to_s3(str(test_file), "agents", record_id="rec-123")
        finally:
            os.environ["AGENT_BUCKET_NAME"] = "fake-bucket"

        assert sha == expected_sha
        mock_s3.upload_file.assert_called_once_with(
            str(test_file),
            "test-bucket",
            "agents/rec-123/my_agent.py",
        )

    def test_no_record_id_uses_flat_key(self, tmp_path):
        """Without record_id, falls back to legacy flat key."""
        test_file = tmp_path / "my_tool.py"
        test_file.write_bytes(b"pass")

        mock_s3 = MagicMock()
        os.environ["AGENT_BUCKET_NAME"] = "test-bucket"
        try:
            with patch("index.boto3") as mock_boto3:
                mock_boto3.client.return_value = mock_s3
                upload_to_s3(str(test_file), "tools")
        finally:
            os.environ["AGENT_BUCKET_NAME"] = "fake-bucket"

        mock_s3.upload_file.assert_called_once_with(
            str(test_file),
            "test-bucket",
            "tools/my_tool.py",
        )
