"""Tests for subprocess hardening in the HLD PDF generator (Finding H-timeout).

Both external processes invoked by the handler — `dot` (graphviz) and
`pandoc`/xelatex — must run with a bounded timeout so a malformed or
adversarial document cannot hang the Lambda invocation indefinitely.

Requirements covered:
  1. The `dot` subprocess call passes timeout=30 (seconds).
  2. The `pandoc` subprocess call passes a timeout derived from the Lambda
     context's remaining time budget (context.get_remaining_time_in_millis()
     minus an upload margin), with a sane default when no context is given.
  3. subprocess.TimeoutExpired from either call is mapped to a structured
     error rather than propagating a raw traceback with document content.
  4. The `dot` subprocess env sets GV_FILE_PATH to the working tmp dir, so
     graphviz cannot resolve external file references.
"""
import os
import subprocess
import sys
import unittest.mock as mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lambda_handler
from lambda_handler import extract_and_render_dot_diagrams, run_pandoc_with_timeout


DOT_MARKDOWN = "intro\n\n```dot\ndigraph G { a -> b }\n```\n\nmore text\n"


# ---------- dot (graphviz) subprocess timeout + env confinement ----------

class TestDotSubprocessHardening:
    def test_dot_call_passes_30s_timeout(self, tmp_path):
        fake_result = subprocess.CompletedProcess(
            args=["dot"], returncode=0, stdout="", stderr=""
        )
        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            extract_and_render_dot_diagrams(DOT_MARKDOWN, str(tmp_path))

        assert mock_run.called, "subprocess.run was never invoked for the dot diagram"
        _, kwargs = mock_run.call_args
        assert kwargs.get("timeout") == 30

    def test_dot_call_sets_gv_file_path_to_tmp_dir(self, tmp_path):
        fake_result = subprocess.CompletedProcess(
            args=["dot"], returncode=0, stdout="", stderr=""
        )
        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            extract_and_render_dot_diagrams(DOT_MARKDOWN, str(tmp_path))

        _, kwargs = mock_run.call_args
        env = kwargs.get("env")
        assert env is not None, "dot subprocess call must pass an explicit env to set GV_FILE_PATH"
        assert env.get("GV_FILE_PATH") == str(tmp_path)

    def test_dot_timeout_expired_is_handled_without_raising(self, tmp_path, capsys):
        """A dot render that times out must not crash the whole handler —
        it should be treated the same as a CalledProcessError (warn + skip
        that diagram), since extract_and_render_dot_diagrams best-effort
        renders each diagram independently."""
        with mock.patch(
            "lambda_handler.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["dot"], timeout=30),
        ):
            result = extract_and_render_dot_diagrams(DOT_MARKDOWN, str(tmp_path))

        # The dot block should remain un-replaced (best-effort skip) rather
        # than raising, and a warning should be emitted.
        assert "```dot" in result or "diagram_0.svg" not in result
        captured = capsys.readouterr()
        assert "timed out" in (captured.out + captured.err).lower()


# ---------- pandoc subprocess timeout derivation ----------

class _FakeContext:
    def __init__(self, remaining_ms):
        self._remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self._remaining_ms


class TestPandocTimeoutDerivation:
    def test_pandoc_call_receives_timeout_kwarg(self, tmp_path):
        fake_result = subprocess.CompletedProcess(
            args=["pandoc"], returncode=0, stdout="", stderr=""
        )
        cmd = ["pandoc", "in.md", "-o", "out.pdf"]
        env = {"PATH": "/usr/bin"}

        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            run_pandoc_with_timeout(cmd, env, context=_FakeContext(60_000))

        assert mock_run.called
        _, kwargs = mock_run.call_args
        assert "timeout" in kwargs
        assert isinstance(kwargs["timeout"], (int, float))
        assert kwargs["timeout"] > 0

    def test_pandoc_timeout_derived_from_remaining_context_time_minus_margin(self, tmp_path):
        fake_result = subprocess.CompletedProcess(
            args=["pandoc"], returncode=0, stdout="", stderr=""
        )
        cmd = ["pandoc"]
        env = {}
        remaining_ms = 45_000  # 45s remaining

        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            run_pandoc_with_timeout(cmd, env, context=_FakeContext(remaining_ms))

        _, kwargs = mock_run.call_args
        # Expect timeout strictly less than the full remaining budget,
        # since an upload margin must be reserved.
        assert kwargs["timeout"] < remaining_ms / 1000.0
        assert kwargs["timeout"] > 0

    def test_pandoc_timeout_has_sane_default_when_no_context(self, tmp_path):
        fake_result = subprocess.CompletedProcess(
            args=["pandoc"], returncode=0, stdout="", stderr=""
        )
        cmd = ["pandoc"]
        env = {}

        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            run_pandoc_with_timeout(cmd, env, context=None)

        _, kwargs = mock_run.call_args
        assert kwargs.get("timeout") is not None
        assert kwargs["timeout"] > 0

    def test_pandoc_timeout_never_negative_when_budget_nearly_exhausted(self, tmp_path):
        """If the Lambda is nearly out of time, the derived timeout must
        still be a small positive number, not zero or negative (which
        would make subprocess.run raise immediately in a confusing way)."""
        fake_result = subprocess.CompletedProcess(
            args=["pandoc"], returncode=0, stdout="", stderr=""
        )
        cmd = ["pandoc"]
        env = {}

        with mock.patch("lambda_handler.subprocess.run", return_value=fake_result) as mock_run:
            run_pandoc_with_timeout(cmd, env, context=_FakeContext(500))  # 0.5s remaining

        _, kwargs = mock_run.call_args
        assert kwargs["timeout"] > 0

    def test_pandoc_timeout_expired_maps_to_structured_error(self):
        cmd = ["pandoc"]
        env = {}
        with mock.patch(
            "lambda_handler.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=cmd, timeout=10),
        ):
            with pytest.raises(lambda_handler.PdfGenerationTimeoutError):
                run_pandoc_with_timeout(cmd, env, context=_FakeContext(20_000))


# ---------- End-to-end: handler maps TimeoutExpired to a structured error ----------

class TestHandlerTimeoutMapping:
    def test_handler_maps_pandoc_timeout_to_structured_error_without_raw_traceback(self, capsys):
        with mock.patch(
            "lambda_handler.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["pandoc"], timeout=10),
        ), mock.patch("lambda_handler.s3") as mock_s3:
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
            with pytest.raises(lambda_handler.PdfGenerationTimeoutError):
                lambda_handler.handler(event, None)

        captured = capsys.readouterr()
        combined = (captured.out + captured.err).lower()
        assert "timed out" in combined or "timeout" in combined
