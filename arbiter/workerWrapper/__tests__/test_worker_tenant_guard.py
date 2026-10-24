"""Worker tenant-isolation tests.

Validates:
- Two-org negative: mismatch between agent's orgId and the execution's org
  raises OrgMismatchError (no execution).
- System agent (orgId='') is allowed through with allow_system=True.
- H7: path traversal is stripped; digest mismatch removes the file.
"""
from __future__ import annotations

import hashlib
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Ensure the worker module dir is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "test-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "test-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "citadel-agents-test")


def _fresh_index():
    sys.modules.pop("index", None)
    import index
    return index


# ---------------------------------------------------------------------------
# require_same_org integration — worker process_event path
# ---------------------------------------------------------------------------
class TestWorkerTwoOrgNegative:
    """C5 regression: worker must refuse an agent record from a different org."""

    def test_mismatch_raises_org_mismatch_error(self):
        from common.tenant_guard import OrgMismatchError, require_same_org

        agent_record = {"agentId": "org-b-agent", "orgId": "org-b"}
        with pytest.raises(OrgMismatchError) as exc_info:
            require_same_org(
                agent_record,
                "org-a",
                record_id_field="agentId",
                component="worker",
                allow_system=True,
            )
        assert exc_info.value.record_org == "org-b"
        assert exc_info.value.bound_org == "org-a"


class TestWorkerSystemAgent:
    """System agent (orgId='') should be allowed by the worker."""

    def test_system_agent_allowed(self):
        from common.tenant_guard import require_same_org

        agent_record = {"agentId": "echo-demo", "orgId": ""}
        # Should NOT raise
        require_same_org(
            agent_record,
            "org-a",
            record_id_field="agentId",
            component="worker",
            allow_system=True,
        )


# ---------------------------------------------------------------------------
# H7: load_file_from_s3_into_tmp hardening
# ---------------------------------------------------------------------------
class TestLoadFileFromS3IntoTmp:
    """H7 artifact binding tests."""

    def test_traversal_stripped(self):
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "../../etc/passwd", record_id="rec-1"
            )
        # The key must use basename only, scoped by record_id
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/rec-1/passwd", "/tmp/loaded_module.py"
        )

    def test_legacy_fallback_no_record_id(self):
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp("bucket", "agent.py")
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/agent.py", "/tmp/loaded_module.py"
        )

    def test_record_id_key_derivation(self):
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "my_agent.py", record_id="abc-123"
            )
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/abc-123/my_agent.py", "/tmp/loaded_module.py"
        )

    def test_digest_mismatch_removes_file(self, tmp_path):
        index = _fresh_index()
        # Write a known file to /tmp/loaded_module.py
        target = "/tmp/loaded_module.py"
        content = b"print('hello')"
        actual_hash = hashlib.sha256(content).hexdigest()
        bad_hash = "0" * 64

        mock_s3 = MagicMock()

        def fake_download(bucket, key, path):
            with open(path, "wb") as f:
                f.write(content)

        mock_s3.download_file.side_effect = fake_download

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            with pytest.raises(ValueError, match="digest mismatch"):
                index.load_file_from_s3_into_tmp(
                    "bucket", "agent.py", record_id="r1", expected_sha256=bad_hash
                )
        # File must be removed after digest failure
        assert not os.path.exists(target)

    def test_digest_match_keeps_file(self, tmp_path):
        index = _fresh_index()
        content = b"print('valid')"
        actual_hash = hashlib.sha256(content).hexdigest()

        mock_s3 = MagicMock()

        def fake_download(bucket, key, path):
            with open(path, "wb") as f:
                f.write(content)

        mock_s3.download_file.side_effect = fake_download

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            # Should not raise
            index.load_file_from_s3_into_tmp(
                "bucket", "agent.py", record_id="r1", expected_sha256=actual_hash
            )
        assert os.path.exists("/tmp/loaded_module.py")
