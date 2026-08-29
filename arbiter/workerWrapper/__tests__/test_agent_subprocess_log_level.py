"""Proves EMISSION (not mere configuration) of tool-seam INFO log records
from the real agent-subprocess entry path.

Root cause (diagnosed): ``tool_idempotency_hook.py`` does
``logging.getLogger(__name__)`` and emits at INFO, but the hook runs inside
the ``agent_runner`` subprocess (launched by ``index.run_agent_in_subprocess``
via ``subprocess.run``), and nothing in that process configured a logging
level — so Python's implicit root-logger default (WARNING) silently dropped
every INFO record before it could reach stderr, and therefore before
``index.py`` could forward it into the parent's captured output.

These tests run ``agent_runner.py`` as a REAL subprocess — exactly the shape
``index.run_agent_in_subprocess`` invokes it (``[sys.executable,
AGENT_RUNNER_PATH]``, JSON on stdin, response on stdout, everything else on
stderr) — with a fixture agent module whose ``handler()`` calls
``logging.getLogger('tool_idempotency_hook').info(...)``: the SAME logger
object name ``tool_idempotency_hook.py`` constructs via
``logging.getLogger(__name__)`` when loaded as a top-level bundle module (the
deployed layout; see ``test_deployed_bundle_importability.py``). This is the
smallest faithful equivalent to driving the real tool-call seam (which would
require the full strands + DynamoDB-ledger machinery to reach the same
``logger.info(...)`` call) while still exercising the REAL subprocess
logging pipeline end to end: env var -> ``agent_runner._configure_logging`` ->
root logger handler -> stderr -> (mirroring ``index.py``) captured output.

A test that only asserts ``setLevel`` was called, or that inspects
``logging.getLogger(...).level`` in-process, would NOT catch the actual
defect (the defect was the total ABSENCE of a configured handler/level in the
subprocess, not a wrong argument to a mock) — so every assertion here is on
the actual captured stderr TEXT of a real child process.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_WORKER_DIR = os.path.abspath(os.path.join(_HERE, ".."))
_AGENT_RUNNER_PATH = os.path.join(_WORKER_DIR, "agent_runner.py")

_FIXTURE_MODULE_SRC = textwrap.dedent(
    """
    import logging

    def handler(**kwargs):
        # Same logger-name convention tool_idempotency_hook.py uses
        # (logging.getLogger(__name__) as a top-level bundle module).
        logging.getLogger('tool_idempotency_hook').info(
            "tool-ledger reserve outcome=%s pk=%s sk=%s gen=%s",
            "WON", "org#exec", "node#tool", 3,
        )
        return "ok"
    """
)


def _write_fixture_module(tmp_path) -> str:
    path = os.path.join(tmp_path, "fixture_agent_module.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(_FIXTURE_MODULE_SRC)
    return path


def _run_agent_runner_subprocess(module_path: str, *, extra_env: dict | None = None):
    """Invoke agent_runner.py exactly as index.run_agent_in_subprocess does:
    real subprocess, JSON payload on stdin, capture stdout/stderr as text."""
    child_env = os.environ.copy()
    # Deterministic default-path testing: strip any AGENT_LOG_LEVEL leaking
    # in from the test runner's own shell environment, so the "no env var
    # set" test genuinely exercises the default rather than an ambient value.
    child_env.pop("AGENT_LOG_LEVEL", None)
    # Ensure the bundle dir + repo root are importable exactly like the real
    # subprocess launch (index.py propagates parent sys.path onto PYTHONPATH).
    parent_roots = [p for p in sys.path if p]
    inherited_pp = child_env.get("PYTHONPATH", "")
    if inherited_pp:
        parent_roots.append(inherited_pp)
    child_env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(parent_roots))
    if extra_env:
        child_env.update(extra_env)

    runner_input = json.dumps({"modulePath": module_path, "request": {}})
    return subprocess.run(
        [sys.executable, _AGENT_RUNNER_PATH],
        input=runner_input,
        capture_output=True,
        text=True,
        timeout=30,
        env=child_env,
    )


class TestAgentSubprocessLogLevelEmission:
    def test_info_seam_log_reaches_stderr_with_default_env(self, tmp_path):
        """No AGENT_LOG_LEVEL set -> defaults to INFO -> the seam INFO record
        is present in the subprocess's captured stderr (the RED case before
        the fix: this assertion fails because the record never reaches
        stderr at all under the implicit WARNING root-logger default)."""
        module_path = _write_fixture_module(str(tmp_path))
        result = _run_agent_runner_subprocess(module_path)

        assert result.returncode == 0, result.stderr
        assert "tool-ledger reserve outcome=WON" in result.stderr
        assert "pk=org#exec" in result.stderr
        assert "sk=node#tool" in result.stderr
        assert "gen=3" in result.stderr
        # Stdout carries ONLY the JSON response envelope — logging must never
        # pollute it.
        assert '"response"' in result.stdout
        assert "tool-ledger" not in result.stdout

    def test_info_seam_log_reaches_stderr_with_explicit_info_env(self, tmp_path):
        """AGENT_LOG_LEVEL=INFO explicitly set -> same emission."""
        module_path = _write_fixture_module(str(tmp_path))
        result = _run_agent_runner_subprocess(
            module_path, extra_env={"AGENT_LOG_LEVEL": "INFO"}
        )

        assert result.returncode == 0, result.stderr
        assert "tool-ledger reserve outcome=WON" in result.stderr

    def test_info_seam_log_suppressed_when_level_raised_to_warning(self, tmp_path):
        """AGENT_LOG_LEVEL=WARNING -> the INFO seam record does NOT appear.

        Proves the fix is a real, effective level gate — not a handler that
        always emits regardless of configured level."""
        module_path = _write_fixture_module(str(tmp_path))
        result = _run_agent_runner_subprocess(
            module_path, extra_env={"AGENT_LOG_LEVEL": "WARNING"}
        )

        assert result.returncode == 0, result.stderr
        assert "tool-ledger reserve outcome=WON" not in result.stderr

    def test_invalid_log_level_falls_back_to_info_default(self, tmp_path):
        """A garbage AGENT_LOG_LEVEL value must not crash the subprocess and
        must degrade to the INFO default (defensive parsing requirement)."""
        module_path = _write_fixture_module(str(tmp_path))
        result = _run_agent_runner_subprocess(
            module_path, extra_env={"AGENT_LOG_LEVEL": "not-a-real-level"}
        )

        assert result.returncode == 0, result.stderr
        assert "tool-ledger reserve outcome=WON" in result.stderr

    def test_lowercase_log_level_value_is_accepted(self, tmp_path):
        """Case-insensitive parsing: 'warning' behaves like 'WARNING'."""
        module_path = _write_fixture_module(str(tmp_path))
        result = _run_agent_runner_subprocess(
            module_path, extra_env={"AGENT_LOG_LEVEL": "warning"}
        )

        assert result.returncode == 0, result.stderr
        assert "tool-ledger reserve outcome=WON" not in result.stderr


class TestConfigureLoggingUnit:
    """Narrow unit coverage of the pure level-resolution helper, additive to
    the subprocess proofs above (which are the tests that actually bite)."""

    def test_resolve_log_level_default_is_info(self, monkeypatch):
        monkeypatch.delenv("AGENT_LOG_LEVEL", raising=False)
        sys.path.insert(0, _WORKER_DIR)
        import importlib
        import agent_runner
        importlib.reload(agent_runner)
        import logging as _logging

        assert agent_runner._resolve_log_level() == _logging.INFO

    def test_resolve_log_level_invalid_falls_back_to_info(self, monkeypatch):
        monkeypatch.setenv("AGENT_LOG_LEVEL", "banana")
        sys.path.insert(0, _WORKER_DIR)
        import importlib
        import agent_runner
        importlib.reload(agent_runner)
        import logging as _logging

        assert agent_runner._resolve_log_level() == _logging.INFO

    def test_resolve_log_level_honours_warning(self, monkeypatch):
        monkeypatch.setenv("AGENT_LOG_LEVEL", "WARNING")
        sys.path.insert(0, _WORKER_DIR)
        import importlib
        import agent_runner
        importlib.reload(agent_runner)
        import logging as _logging

        assert agent_runner._resolve_log_level() == _logging.WARNING
