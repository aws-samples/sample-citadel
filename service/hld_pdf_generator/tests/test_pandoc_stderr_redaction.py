"""Tests for HLD PDF generator stderr/stdout redaction (E23-c).

Pandoc stderr (and stdout) may contain document text (e.g. error context
quoting the input markdown). Logging it verbatim leaks user content into
CloudWatch. The handler must log only the exit code, stderr byte length,
and stderr SHA-256 — never the raw text.
"""
import hashlib
import os
import subprocess
import sys
import unittest.mock as mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lambda_handler


SAMPLE_DOC_TEXT = "TOP SECRET: board-approved merger with AcmeCorp 2027-Q1"


class TestPandocStderrRedaction:
    """stderr and stdout from pandoc must never appear in logs."""

    def test_success_path_does_not_log_pandoc_stdout(self, capsys, tmp_path):
        """On successful pandoc run, stdout must not be printed verbatim."""
        fake_result = subprocess.CompletedProcess(
            args=["pandoc"],
            returncode=0,
            stdout=SAMPLE_DOC_TEXT,
            stderr="",
        )

        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result), \
             mock.patch("lambda_handler.s3") as mock_s3:
            mock_s3.get_object.return_value = {
                "Body": mock.MagicMock(read=lambda: SAMPLE_DOC_TEXT.encode())
            }
            # Build minimal event
            event = {
                "Records": [{
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "doc.md"},
                    }
                }]
            }
            try:
                lambda_handler.handler(event, None)
            except Exception:
                pass  # downstream failures are fine — we only care about log output

        captured = capsys.readouterr()
        assert SAMPLE_DOC_TEXT not in captured.out, \
            "Pandoc stdout (which may contain document text) was logged verbatim"
        assert SAMPLE_DOC_TEXT not in captured.err, \
            "Pandoc stdout leaked to stderr log"

    def test_error_path_does_not_log_pandoc_stderr(self, capsys, tmp_path):
        """On CalledProcessError, stderr must not be printed verbatim."""
        err = subprocess.CalledProcessError(
            returncode=1,
            cmd=["pandoc"],
            stderr=SAMPLE_DOC_TEXT,
        )

        with mock.patch("lambda_handler.subprocess.run", side_effect=err), \
             mock.patch("lambda_handler.s3") as mock_s3:
            mock_s3.get_object.return_value = {
                "Body": mock.MagicMock(read=lambda: b"# Heading\n")
            }
            event = {
                "Records": [{
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "doc.md"},
                    }
                }]
            }
            with pytest.raises(subprocess.CalledProcessError):
                lambda_handler.handler(event, None)

        captured = capsys.readouterr()
        assert SAMPLE_DOC_TEXT not in captured.out, \
            "Pandoc stderr (containing document text) was logged verbatim"
        assert SAMPLE_DOC_TEXT not in captured.err, \
            "Pandoc stderr leaked to stderr log"

    def test_error_path_logs_exit_code_and_stderr_digest(self, capsys, tmp_path):
        """The error log must contain exit code, stderr length, and sha256."""
        stderr_text = "some pandoc error context"
        expected_sha = hashlib.sha256(stderr_text.encode()).hexdigest()
        err = subprocess.CalledProcessError(
            returncode=43,
            cmd=["pandoc"],
            stderr=stderr_text,
        )

        with mock.patch("lambda_handler.subprocess.run", side_effect=err), \
             mock.patch("lambda_handler.s3") as mock_s3:
            mock_s3.get_object.return_value = {
                "Body": mock.MagicMock(read=lambda: b"# Heading\n")
            }
            event = {
                "Records": [{
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "doc.md"},
                    }
                }]
            }
            with pytest.raises(subprocess.CalledProcessError):
                lambda_handler.handler(event, None)

        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "43" in combined, "exit code not logged"
        assert str(len(stderr_text)) in combined, "stderr length not logged"
        assert expected_sha[:16] in combined, "stderr sha256 not logged"
