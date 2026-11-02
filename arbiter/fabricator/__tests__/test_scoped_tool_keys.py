"""Tests for tenant-scoped tool S3 keys (CIT-256 C1).

Covers:
- upload_to_s3 builds tenant-scoped keys from ContextVars
- upload_to_s3 falls back to record-scoped then flat keys
- put_object IfNoneMatch='*' prevents overwrite (stateful S3 fake)
- upload_tool_to_s3 records key in per-job map
- get_worker_tool resolves via per-job map (source 1)
- get_worker_tool resolves via registry codeKey, org-filtered (source 2)
- get_worker_tool rejects foreign-org records
- get_worker_tool falls back to legacy flat key only with org-owned record (source 3)
- get_worker_tool raises when no key source is available
- store_tool_config_registry persists codeKey in custom_metadata
- _validate_basename rejects traversal / control chars
- ContextVars (including tool_keys) set and cleared by process_event
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
from unittest.mock import MagicMock, patch, call

import pytest
from botocore.exceptions import ClientError

# Ensure fabricator's index resolves from the correct subdir.
import sys
_fab_dir = os.path.join(os.path.dirname(__file__), "..")
if _fab_dir not in sys.path:
    sys.path.insert(0, _fab_dir)

from fabrication_context import (
    fabrication_job_id,
    fabrication_org_id,
    fabrication_tool_keys,
    lookup_tool_key,
    record_tool_key,
)


# ---------------------------------------------------------------------------
# Stateful S3 fake honouring IfNoneMatch='*'
# ---------------------------------------------------------------------------

class StatefulS3Fake:
    """In-memory S3 store that honours ``IfNoneMatch='*'``."""

    def __init__(self):
        self.objects: dict[tuple[str, str], bytes] = {}

    def put_object(self, *, Bucket, Key, Body, IfNoneMatch=None, **kwargs):
        if IfNoneMatch == "*" and (Bucket, Key) in self.objects:
            raise ClientError(
                {
                    "Error": {
                        "Code": "PreconditionFailed",
                        "Message": "At least one of the pre-conditions you specified did not hold",
                    }
                },
                "PutObject",
            )
        data = Body if isinstance(Body, bytes) else Body.read()
        self.objects[(Bucket, Key)] = data

    def get_object(self, *, Bucket, Key, **kwargs):
        if (Bucket, Key) not in self.objects:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "Not found"}},
                "GetObject",
            )
        body = MagicMock()
        body.read.return_value = self.objects[(Bucket, Key)]
        return {"Body": body}

    def upload_file(self, file_path, bucket, key, **kwargs):
        with open(file_path, "rb") as fh:
            self.objects[(bucket, key)] = fh.read()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_context():
    """Reset ContextVars between tests."""
    fabrication_org_id.set("")
    fabrication_job_id.set("")
    fabrication_tool_keys.set(None)
    yield
    fabrication_org_id.set("")
    fabrication_job_id.set("")
    fabrication_tool_keys.set(None)


@pytest.fixture()
def s3_fake():
    return StatefulS3Fake()


@pytest.fixture()
def tmp_tool(tmp_path):
    """Create a temporary .py file with known content."""
    p = tmp_path / "my_tool.py"
    p.write_text("# tool code\n")
    return str(p)


@pytest.fixture()
def env_bucket(monkeypatch):
    monkeypatch.setenv("AGENT_BUCKET_NAME", "test-bucket")


# ---------------------------------------------------------------------------
# upload_to_s3 — key layout tests
# ---------------------------------------------------------------------------

class TestUploadToS3KeyLayout:

    def test_tenant_scoped_key_from_contextvars(self, s3_fake, tmp_tool, env_bucket):
        """When both ContextVars are set, the key is tools/{org}/{job}/{basename}."""
        fabrication_org_id.set("org-abc")
        fabrication_job_id.set("job-123")

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            sha, key = upload_to_s3(tmp_tool, "tools")

        assert key == "tools/org-abc/job-123/my_tool.py"
        assert (("test-bucket", key)) in s3_fake.objects
        # SHA should match file content.
        expected_sha = hashlib.sha256(b"# tool code\n").hexdigest()
        assert sha == expected_sha

    def test_record_scoped_key_when_no_context(self, s3_fake, tmp_tool, env_bucket):
        """When ContextVars are empty but record_id is given, use record-scoped key."""
        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            sha, key = upload_to_s3(tmp_tool, "tools", record_id="rec-42")

        assert key == "tools/rec-42/my_tool.py"

    def test_legacy_flat_key_when_no_context_no_record(self, s3_fake, tmp_tool, env_bucket):
        """When nothing is set, fall back to flat key."""
        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            sha, key = upload_to_s3(tmp_tool, "tools")

        assert key == "tools/my_tool.py"

    def test_context_takes_precedence_over_record_id(self, s3_fake, tmp_tool, env_bucket):
        """ContextVar-derived key wins over an explicit record_id."""
        fabrication_org_id.set("org-x")
        fabrication_job_id.set("job-y")

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            sha, key = upload_to_s3(tmp_tool, "tools", record_id="rec-ignored")

        assert key == "tools/org-x/job-y/my_tool.py"


# ---------------------------------------------------------------------------
# upload_to_s3 — IfNoneMatch='*' (no overwrite)
# ---------------------------------------------------------------------------

class TestUploadIfNoneMatch:

    def test_first_upload_succeeds(self, s3_fake, tmp_tool, env_bucket):
        fabrication_org_id.set("org-1")
        fabrication_job_id.set("job-1")

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            sha, key = upload_to_s3(tmp_tool, "tools")

        assert ("test-bucket", key) in s3_fake.objects

    def test_second_upload_same_key_raises(self, s3_fake, tmp_tool, env_bucket):
        """IfNoneMatch='*' prevents overwriting an existing object."""
        fabrication_org_id.set("org-1")
        fabrication_job_id.set("job-1")

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            upload_to_s3(tmp_tool, "tools")

            with pytest.raises(ClientError) as exc_info:
                upload_to_s3(tmp_tool, "tools")

        assert exc_info.value.response["Error"]["Code"] == "PreconditionFailed"


# ---------------------------------------------------------------------------
# _validate_basename
# ---------------------------------------------------------------------------

class TestValidateBasename:

    def test_simple_name_passes(self):
        from index import _validate_basename
        assert _validate_basename("my_tool.py") == "my_tool.py"

    def test_traversal_rejected(self):
        from index import _validate_basename
        with pytest.raises(ValueError, match="\\.\\."):
            _validate_basename("../etc/passwd")

    def test_slash_rejected(self):
        from index import _validate_basename
        with pytest.raises(ValueError, match="path separators"):
            _validate_basename("sub/dir.py")

    def test_control_char_rejected(self):
        from index import _validate_basename
        with pytest.raises(ValueError, match="control characters"):
            _validate_basename("tool\x00.py")

    def test_empty_rejected(self):
        from index import _validate_basename
        with pytest.raises(ValueError, match="non-empty"):
            _validate_basename("")


# ---------------------------------------------------------------------------
# upload_tool_to_s3 — records key in per-job map
# ---------------------------------------------------------------------------

class TestUploadToolRecordsKey:

    def test_upload_tool_records_in_per_job_map(self, s3_fake, tmp_tool, env_bucket):
        """upload_tool_to_s3 records the scoped key in fabrication_tool_keys."""
        fabrication_org_id.set("org-r")
        fabrication_job_id.set("job-r")

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            from index import upload_tool_to_s3 as uts
            returned_key = uts.__wrapped__(tmp_tool)

        assert returned_key == "tools/org-r/job-r/my_tool.py"
        assert lookup_tool_key("my_tool.py") == returned_key


# ---------------------------------------------------------------------------
# get_worker_tool — server-side key resolution
# ---------------------------------------------------------------------------

class TestGetWorkerToolKeyResolution:

    def test_per_job_map_hit(self, s3_fake, env_bucket):
        """Source 1: per-job map populated by upload_tool_to_s3."""
        from index import get_worker_tool as gwt
        scoped_key = "tools/org-a/job-1/calc.py"
        record_tool_key("calc.py", scoped_key)
        s3_fake.objects[("test-bucket", scoped_key)] = b"# calc"

        with patch("index.boto3") as mock_boto:
            mock_boto.client.return_value = s3_fake
            code = gwt.__wrapped__("calc.py")

        assert code == "# calc"

    def test_registry_codekey_hit_org_filtered(self, s3_fake, env_bucket, monkeypatch):
        """Source 2: registry codeKey for an org-owned CUSTOM record."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        fabrication_org_id.set("org-mine")

        scoped_key = "tools/org-mine/job-x/calc.py"
        s3_fake.objects[("test-bucket", scoped_key)] = b"# registry calc"

        mock_client = MagicMock()
        # _find_existing_record_id returns a record id for org-mine.
        mock_client.list_registry_records.return_value = {
            "registryRecords": [{
                "recordId": "rec-abc",
                "displayName": "calc.py",
                "descriptors": {
                    "custom": {
                        "data": json.dumps({"orgId": "org-mine", "codeKey": scoped_key}),
                    },
                },
            }],
        }
        # get_registry_record returns the full record with codeKey.
        mock_client.get_registry_record.return_value = {
            "descriptors": {
                "custom": {
                    "data": json.dumps({"orgId": "org-mine", "codeKey": scoped_key}),
                },
            },
        }

        from index import get_worker_tool as gwt
        with patch("index.boto3") as mock_boto, \
             patch("index._get_registry_client", return_value=mock_client):
            mock_boto.client.return_value = s3_fake
            code = gwt.__wrapped__("calc.py")

        assert code == "# registry calc"

    def test_foreign_org_record_not_found(self, s3_fake, env_bucket, monkeypatch):
        """A record owned by a different org must NOT be used."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        fabrication_org_id.set("org-mine")

        mock_client = MagicMock()
        # _find_existing_record_id: the record exists but belongs to org-other.
        # Org-filtered lookup returns nothing.
        mock_client.list_registry_records.return_value = {
            "registryRecords": [{
                "recordId": "rec-foreign",
                "displayName": "calc.py",
                "descriptors": {
                    "custom": {
                        "data": json.dumps({"orgId": "org-other"}),
                    },
                },
            }],
        }

        from index import get_worker_tool as gwt
        with patch("index.boto3") as mock_boto, \
             patch("index._get_registry_client", return_value=mock_client):
            mock_boto.client.return_value = s3_fake
            with pytest.raises(ValueError, match="no org-owned registry record"):
                gwt.__wrapped__("calc.py")

    def test_legacy_flat_key_only_with_org_owned_record(self, s3_fake, env_bucket, monkeypatch):
        """Source 3: legacy flat key used ONLY when org-owned record exists without codeKey."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        fabrication_org_id.set("org-mine")

        s3_fake.objects[("test-bucket", "tools/old_tool.py")] = b"# legacy"

        mock_client = MagicMock()
        # org-filtered record found, no codeKey.
        mock_client.list_registry_records.return_value = {
            "registryRecords": [{
                "recordId": "rec-old",
                "displayName": "old_tool.py",
                "descriptors": {
                    "custom": {
                        "data": json.dumps({"orgId": "org-mine"}),
                    },
                },
            }],
        }
        mock_client.get_registry_record.return_value = {
            "descriptors": {
                "custom": {
                    "data": json.dumps({"orgId": "org-mine"}),
                },
            },
        }
        mock_cw = MagicMock()

        from index import get_worker_tool as gwt
        with patch("index.boto3") as mock_boto, \
             patch("index._get_registry_client", return_value=mock_client), \
             patch("index._cloudwatch", return_value=mock_cw):
            mock_boto.client.return_value = s3_fake
            code = gwt.__wrapped__("old_tool.py")

        assert code == "# legacy"
        mock_cw.put_metric_data.assert_called_once()
        metric_call = mock_cw.put_metric_data.call_args
        assert metric_call[1]["MetricData"][0]["MetricName"] == "LegacyToolKeyFallback"

    def test_no_key_source_raises(self, s3_fake, env_bucket, monkeypatch):
        """When no per-job map, no registry record, raises ValueError."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        fabrication_org_id.set("org-mine")

        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {"registryRecords": []}

        from index import get_worker_tool as gwt
        with patch("index.boto3") as mock_boto, \
             patch("index._get_registry_client", return_value=mock_client):
            mock_boto.client.return_value = s3_fake
            with pytest.raises(ValueError, match="Cannot resolve S3 key"):
                gwt.__wrapped__("missing.py")


# ---------------------------------------------------------------------------
# store_tool_config_registry persists codeKey
# ---------------------------------------------------------------------------

class TestStoreToolConfigRegistryCodeKey:

    def test_codekey_persisted_in_custom_metadata(self, monkeypatch):
        """store_tool_config_registry stamps codeKey from per-job map into the registry record."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        monkeypatch.setenv("AGENT_BUCKET_NAME", "bucket")

        # Populate the per-job tool key map.
        record_tool_key("my_tool.py", "tools/org-t/job-t/my_tool.py")

        mock_client = MagicMock()
        # No existing record.
        mock_client.list_registry_records.return_value = {"registryRecords": []}
        # create returns an ARN.
        mock_client.create_registry_record.return_value = {
            "recordArn": "arn:aws:agentcore:us-west-2:123:registry/reg-1/record/rec-new",
        }
        # submit for approval => APPROVED.
        mock_client.get_registry_record.return_value = {"status": "DRAFT"}
        mock_client.submit_registry_record_for_approval.return_value = {"status": "APPROVED"}

        from index import store_tool_config_registry as stcr
        with patch("index._get_registry_client", return_value=mock_client), \
             patch("index.registration_checkpoint"):
            result = stcr.__wrapped__(
                file_name="/tmp/my_tool.py",
                tool_id="my_tool",
                tool_schema={"type": "object", "properties": {}},
                tool_description="A test tool",
                org_id="org-t",
            )

        assert result is True
        # Verify codeKey was written into the custom descriptor.
        create_call = mock_client.create_registry_record.call_args
        descriptor_data = json.loads(
            create_call[1]["descriptors"]["custom"]["data"]
        )
        assert descriptor_data["codeKey"] == "tools/org-t/job-t/my_tool.py"

    def test_no_codekey_when_per_job_map_empty(self, monkeypatch):
        """When per-job map has no entry, codeKey is not set."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        monkeypatch.setenv("AGENT_BUCKET_NAME", "bucket")

        mock_client = MagicMock()
        mock_client.list_registry_records.return_value = {"registryRecords": []}
        mock_client.create_registry_record.return_value = {
            "recordArn": "arn:aws:agentcore:us-west-2:123:registry/reg-1/record/rec-2",
        }
        mock_client.get_registry_record.return_value = {"status": "DRAFT"}
        mock_client.submit_registry_record_for_approval.return_value = {"status": "APPROVED"}

        from index import store_tool_config_registry as stcr
        with patch("index._get_registry_client", return_value=mock_client), \
             patch("index.registration_checkpoint"):
            stcr.__wrapped__(
                file_name="/tmp/other_tool.py",
                tool_id="other_tool",
                tool_schema={"type": "object"},
                tool_description="No key",
                org_id="org-t",
            )

        create_call = mock_client.create_registry_record.call_args
        descriptor_data = json.loads(
            create_call[1]["descriptors"]["custom"]["data"]
        )
        assert "codeKey" not in descriptor_data


# ---------------------------------------------------------------------------
# process_event sets ContextVars
# ---------------------------------------------------------------------------

class TestProcessEventContextVars:

    def test_contextvars_set_during_fabrication(self, monkeypatch):
        """process_event sets fabrication_org_id and fabrication_job_id."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        monkeypatch.setenv("AGENT_BUCKET_NAME", "bucket")

        captured_org = None
        captured_job = None

        original_call_with_retry = None
        def fake_call_with_retry(fn, **kwargs):
            nonlocal captured_org, captured_job
            captured_org = fabrication_org_id.get("")
            captured_job = fabrication_job_id.get("")

        with patch("index.check_design_assessment"), \
             patch("index.call_with_transient_retry", side_effect=fake_call_with_retry), \
             patch("index._write_fabrication_status"), \
             patch("index.publish_intake_progress"), \
             patch("index.set_fabrication_deadline"), \
             patch("index.clear_fabrication_deadline"):
            from index import process_event
            event = {
                "orchestration_id": "orch-999",
                "agent_use_id": "tool-1",
                "org_id": "org-tenant-42",
                "agent_input": {"taskDetails": "build a tool"},
            }
            process_event(event, {}, request_type="tool-creation")

        assert captured_org == "org-tenant-42"
        assert captured_job == "orch-999"

    def test_contextvars_cleared_after_fabrication(self, monkeypatch):
        """ContextVars are reset even after an exception (including tool_keys)."""
        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        monkeypatch.setenv("AGENT_BUCKET_NAME", "bucket")

        def fail_retry(fn, **kwargs):
            # Populate the tool keys map during the run.
            record_tool_key("fail_tool.py", "tools/org/job/fail_tool.py")
            raise RuntimeError("boom")

        with patch("index.check_design_assessment"), \
             patch("index.call_with_transient_retry", side_effect=fail_retry), \
             patch("index._write_fabrication_status"), \
             patch("index.publish_intake_progress"), \
             patch("index.publish_fabrication_event"), \
             patch("index.set_fabrication_deadline"), \
             patch("index.clear_fabrication_deadline"):
            from index import process_event
            event = {
                "orchestration_id": "orch-x",
                "agent_use_id": "tool-x",
                "org_id": "org-x",
                "agent_input": {"taskDetails": "fail"},
            }
            with pytest.raises(RuntimeError):
                process_event(event, {}, request_type="tool-creation")

        # Must be cleared.
        assert fabrication_org_id.get("") == ""
        assert fabrication_job_id.get("") == ""
        assert fabrication_tool_keys.get(None) is None


# ---------------------------------------------------------------------------
# Import helpers (deferred to avoid conftest import-order issues)
# ---------------------------------------------------------------------------

def upload_to_s3(*args, **kwargs):
    from index import upload_to_s3 as _fn
    return _fn(*args, **kwargs)


def get_worker_tool(*args, **kwargs):
    from index import get_worker_tool as _fn
    return _fn(*args, **kwargs)
