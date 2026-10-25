"""Tests for S3 legacy key fallback in load_file_from_s3_into_tmp.

Validates:
- Scoped key hit: downloads from agents/{record_id}/{basename} directly.
- Scoped key miss + legacy hit: falls back to agents/{basename} with INFO log.
- Both keys miss: raises ClientError (clear error).
- No record_id: uses legacy key directly without trying scoped key.
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "test-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "test-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "citadel-agents-test")


def _fresh_index():
    sys.modules.pop("index", None)
    import index
    return index


def _make_client_error(code="NoSuchKey"):
    from botocore.exceptions import ClientError
    return ClientError(
        {"Error": {"Code": code, "Message": "Not Found"}},
        "HeadObject",
    )


class TestS3LegacyKeyFallback:
    """PR-396 regression fix: scoped key -> legacy fallback -> clear error."""

    def test_scoped_key_hit(self):
        """When the scoped key exists, download succeeds on first try."""
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "agent.py", record_id="rec-42"
            )
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/rec-42/agent.py", "/tmp/loaded_module.py"
        )

    def test_scoped_key_miss_legacy_hit(self, capsys):
        """When scoped key 404s, falls back to legacy key with INFO log."""
        index = _fresh_index()
        mock_s3 = MagicMock()

        def side_effect(bucket, key, path):
            if key == "agents/rec-42/agent.py":
                raise _make_client_error("404")
            # Legacy key succeeds (no exception)

        mock_s3.download_file.side_effect = side_effect

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "agent.py", record_id="rec-42"
            )

        assert mock_s3.download_file.call_count == 2
        mock_s3.download_file.assert_any_call(
            "bucket", "agents/rec-42/agent.py", "/tmp/loaded_module.py"
        )
        mock_s3.download_file.assert_any_call(
            "bucket", "agents/agent.py", "/tmp/loaded_module.py"
        )

        # Verify structured INFO log for legacy_code_key
        captured = capsys.readouterr()
        log_line = json.loads(captured.out.strip())
        assert log_line["level"] == "INFO"
        assert log_line["action"] == "legacy_code_key"
        assert log_line["scoped_key"] == "agents/rec-42/agent.py"
        assert log_line["legacy_key"] == "agents/agent.py"

    def test_scoped_key_miss_nosuchkey_legacy_hit(self, capsys):
        """NoSuchKey error code also triggers fallback."""
        index = _fresh_index()
        mock_s3 = MagicMock()

        def side_effect(bucket, key, path):
            if key == "agents/rec-42/agent.py":
                raise _make_client_error("NoSuchKey")

        mock_s3.download_file.side_effect = side_effect

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "agent.py", record_id="rec-42"
            )

        assert mock_s3.download_file.call_count == 2

    def test_both_keys_miss_raises(self):
        """When both scoped and legacy keys 404, raises ClientError."""
        from botocore.exceptions import ClientError
        index = _fresh_index()
        mock_s3 = MagicMock()
        mock_s3.download_file.side_effect = _make_client_error("404")

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            with pytest.raises(ClientError):
                index.load_file_from_s3_into_tmp(
                    "bucket", "agent.py", record_id="rec-42"
                )

        # First call is scoped key, second is legacy key (which also 404s)
        assert mock_s3.download_file.call_count == 2

    def test_no_record_id_uses_legacy_directly(self):
        """When record_id is None, uses legacy key without trying scoped."""
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp("bucket", "agent.py")
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/agent.py", "/tmp/loaded_module.py"
        )

    def test_empty_string_record_id_uses_legacy_directly(self):
        """When record_id is empty string, uses legacy key directly."""
        index = _fresh_index()
        mock_s3 = MagicMock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            index.load_file_from_s3_into_tmp(
                "bucket", "agent.py", record_id=""
            )
        mock_s3.download_file.assert_called_once_with(
            "bucket", "agents/agent.py", "/tmp/loaded_module.py"
        )

    def test_non_404_error_not_caught(self):
        """A non-404 ClientError (e.g. AccessDenied) propagates immediately."""
        from botocore.exceptions import ClientError
        index = _fresh_index()
        mock_s3 = MagicMock()
        mock_s3.download_file.side_effect = _make_client_error("AccessDenied")

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_s3
            with pytest.raises(ClientError) as exc_info:
                index.load_file_from_s3_into_tmp(
                    "bucket", "agent.py", record_id="rec-42"
                )
            assert exc_info.value.response['Error']['Code'] == 'AccessDenied'

        # Only one call — did not attempt legacy fallback
        mock_s3.download_file.assert_called_once()
