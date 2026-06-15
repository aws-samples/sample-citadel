"""
Property-based tests for arbiter/workerWrapper/agent_runner.py

Tests payload parsing from stdin and response serialization to stdout.
"""

import sys
import os
import json
import tempfile
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

request_dicts = st.dictionaries(
    st.text(min_size=1, max_size=20, alphabet=st.characters(
        whitelist_categories=("L", "N"),
    )),
    st.text(max_size=100),
    max_size=5,
)

handler_return_values = st.one_of(
    st.text(max_size=200),
    st.integers(min_value=-10**6, max_value=10**6),
    st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False),
    st.dictionaries(st.text(max_size=20), st.text(max_size=50), max_size=3),
)


# ---------------------------------------------------------------------------
# agent_runner.main() payload parsing
# ---------------------------------------------------------------------------

class TestAgentRunnerMain:
    """Property tests for agent_runner.main stdin/stdout contract."""

    @given(
        request=request_dicts,
        return_value=st.text(max_size=200),
    )
    @settings(max_examples=50)
    def test_output_is_valid_json_with_response_key(self, request, return_value):
        """agent_runner always writes valid JSON with a 'response' key to stdout."""
        # Create a temporary module with a handler function
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                f"def handler(**kwargs):\n"
                f"    return {repr(return_value)}\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            assert len(captured_output) == 1
            parsed = json.loads(captured_output[0])
            assert "response" in parsed
        finally:
            os.unlink(module_path)

    @given(request=request_dicts)
    @settings(max_examples=30)
    def test_handler_exception_produces_error_response(self, request):
        """When handler raises, output still contains a 'response' key."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                "def handler(**kwargs):\n"
                "    raise RuntimeError('test error')\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            assert len(captured_output) == 1
            parsed = json.loads(captured_output[0])
            assert "response" in parsed
            assert "failed" in parsed["response"].lower() or "error" in parsed["response"].lower()
        finally:
            os.unlink(module_path)

    @given(request=request_dicts)
    @settings(max_examples=30)
    def test_request_kwargs_passed_to_handler(self, request):
        """Request dict is unpacked as kwargs to the handler function."""
        # Build a handler that returns its kwargs
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                "def handler(**kwargs):\n"
                "    return str(sorted(kwargs.keys()))\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            parsed = json.loads(captured_output[0])
            expected_keys = str(sorted(request.keys()))
            assert parsed["response"] == expected_keys
        finally:
            os.unlink(module_path)


# ---------------------------------------------------------------------------
# US-ARB-012a — GovernedToolHandler subprocess wiring (follow-up #9).
#
# agent_runner.main() MUST inject a GovernedToolHandler into every Strands
# Agent constructed inside the loaded module when CITADEL_AGENT_ID is set
# in the subprocess env. The injection is a monkey-patch of
# ``strands.Agent.__init__`` installed BEFORE exec_module so every Agent()
# call inside the generated code picks it up.
#
# AC mapping:
#   - env var CITADEL_AGENT_ID set    -> patch installed, handler injected
#   - env var CITADEL_AGENT_ID unset  -> no patch, no injection (back-compat)
#   - strands import fails            -> WARN-log, continue execution
#   - Agent() explicit tool_handler   -> caller wins, no override
#   - DENIED_TOOLS env var            -> flows through to handler.denied_tools
#   - CITADEL_WORKFLOW_ID env var     -> flows through to handler.workflow_id
# ---------------------------------------------------------------------------


class _FakeStrandsAgent:
    """Minimal Agent-shaped stand-in used to probe the injection patch."""

    def __init__(self, *args, tool_handler=None, tools=None, **kwargs):
        self.args = args
        self.tool_handler = tool_handler
        self.tools = list(tools) if tools is not None else []
        self.kwargs = kwargs

    def __call__(self, prompt):
        return f"fake-response:{prompt}"


def _install_fake_strands(monkeypatch):
    """Install a fake ``strands`` module so agent_runner can patch Agent.__init__."""
    import types

    fake_mod = types.ModuleType("strands")
    fake_mod.Agent = _FakeStrandsAgent
    fake_models = types.ModuleType("strands.models")

    class _BedrockModelStub:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

    fake_models.BedrockModel = _BedrockModelStub
    fake_mod.models = fake_models
    monkeypatch.setitem(sys.modules, "strands", fake_mod)
    monkeypatch.setitem(sys.modules, "strands.models", fake_models)
    return fake_mod


def _run_runner_with_module(module_src, request, captured):
    """Execute ``agent_runner.main()`` against a temp module and capture stdout."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False
    ) as f:
        f.write(module_src)
        module_path = f.name

    try:
        payload = json.dumps({"modulePath": module_path, "request": request})
        with patch("sys.stdin") as mock_stdin, \
             patch("builtins.print", side_effect=lambda s: captured.append(s)):
            mock_stdin.read.return_value = payload
            sys.modules.pop("agent_runner", None)
            from agent_runner import main
            main()
    finally:
        os.unlink(module_path)


class TestAgentRunnerGovernanceInjection:
    """US-ARB-012a subprocess wiring — injection contract at agent_runner level."""

    def test_no_injection_when_citadel_agent_id_unset(self, monkeypatch):
        """Backward-compat: with no CITADEL_AGENT_ID in env, no patch installed."""
        monkeypatch.delenv("CITADEL_AGENT_ID", raising=False)
        monkeypatch.delenv("CITADEL_WORKFLOW_ID", raising=False)
        monkeypatch.delenv("DENIED_TOOLS", raising=False)
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[])\n"
            "    return 'tool_handler=' + repr(a.tool_handler)\n"
        )
        captured = []
        _run_runner_with_module(module_src, {"x": "y"}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert parsed["response"] == "tool_handler=None"

    def test_injection_when_citadel_agent_id_set(self, monkeypatch):
        """CITADEL_AGENT_ID set -> every Agent() in loaded module gets a handler."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.setenv("CITADEL_WORKFLOW_ID", "wf-42")
        monkeypatch.setenv("DENIED_TOOLS", "tool_a,tool_b")
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[])\n"
            "    return (\n"
            "        f'injected={a.tool_handler is not None};'\n"
            "        f'agent_id={getattr(a.tool_handler, \"agent_id\", None)};'\n"
            "        f'workflow_id={getattr(a.tool_handler, \"workflow_id\", None)};'\n"
            "        f'denied={sorted(getattr(a.tool_handler, \"denied_tools\", []))}'\n"
            "    )\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1, captured
        parsed = json.loads(captured[0])
        resp = parsed["response"]
        assert "injected=True" in resp, resp
        assert "agent_id=agent-xyz" in resp
        assert "workflow_id=wf-42" in resp
        assert "denied=['tool_a', 'tool_b']" in resp

    def test_explicit_tool_handler_is_preserved(self, monkeypatch):
        """When generated code explicitly passes tool_handler=, injector MUST NOT override."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.setenv("DENIED_TOOLS", "t1")
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "class _MyHandler:\n"
            "    agent_id = 'custom-caller-handler'\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[], tool_handler=_MyHandler())\n"
            "    return 'agent_id=' + a.tool_handler.agent_id\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert parsed["response"] == "agent_id=custom-caller-handler"

    def test_injection_skipped_when_strands_unimportable(self, monkeypatch):
        """Graceful degrade: missing strands -> no crash, runner still works."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.delitem(sys.modules, "strands", raising=False)

        import builtins
        real_import = builtins.__import__

        def failing_import(name, *args, **kwargs):
            if name == "strands" or name.startswith("strands."):
                raise ImportError("strands unavailable (simulated)")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", failing_import)

        module_src = (
            "def handler(**kwargs):\n"
            "    return 'ran-without-strands'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert parsed["response"] == "ran-without-strands"
