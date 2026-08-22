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
    def test_handler_exception_produces_failure_envelope_and_nonzero_exit(self, request):
        """finding 56d763d4: when the agent body raises, agent_runner must NOT
        launder the exception into a successful ``response`` string. It emits a
        FAILURE-MARKED envelope carrying the exception CLASS + diagnostic and
        exits non-zero, so the parent can never record a crash as completed."""
        import io

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

            fake_stdout = io.StringIO()
            with patch("sys.stdin") as mock_stdin, \
                 patch("sys.stdout", fake_stdout):
                mock_stdin.read.return_value = payload

                import agent_runner
                with pytest.raises(SystemExit) as excinfo:
                    agent_runner.main()

            # Non-zero exit is the failure signal.
            assert excinfo.value.code != 0

            parsed = json.loads(fake_stdout.getvalue())
            # Structural failure marker present; NO success 'response' key.
            assert parsed[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
            assert "response" not in parsed
            # The exception CLASS is carried for retry.py's failure-class logic.
            assert parsed["errorClass"] == "RuntimeError"
            # The human diagnostic is preserved in the envelope.
            assert "test error" in parsed["error"]
            # usage remains an (additive) list even on failure.
            assert isinstance(parsed["usage"], list)
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

    def test_denylisted_tool_never_executes_end_to_end(self, monkeypatch):
        """US-ARB-012a wiring contract: a denylisted tool call must never
        reach the underlying tool implementation.

        This exercises the full chain the real subprocess uses: agent_runner
        installs the patch, the injected GovernedToolHandler's preprocess()
        DENYs the call, and Strands (simulated here) must short-circuit
        before invoking the tool function — never call it "just to log",
        never call it at all.
        """
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.setenv("DENIED_TOOLS", "dangerous_tool")
        fake_mod = _install_fake_strands(monkeypatch)

        # Extend the fake Agent so it actually drives tool_handler.preprocess()
        # before "calling" a tool, mirroring the real Strands dispatch loop
        # closely enough to prove the short-circuit contract.
        class _DrivingAgent(fake_mod.Agent):
            def dispatch_tool(self, tool_use, executed_log):
                pre = None
                if self.tool_handler is not None:
                    pre = self.tool_handler.preprocess(tool_use)
                if pre is not None:
                    return pre  # DENY short-circuit — tool must NOT run.
                executed_log.append(tool_use["name"])
                return {"status": "success", "content": [{"text": "ran"}]}

        fake_mod.Agent = _DrivingAgent

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    executed = []\n"
            "    a = Agent(tools=[])\n"
            "    result = a.dispatch_tool({'name': 'dangerous_tool', 'toolUseId': 'tu-1'}, executed)\n"
            "    return f'executed={executed};status={result.get(\"status\")}'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        resp = parsed["response"]
        assert "executed=[]" in resp, resp  # tool function never ran
        assert "status=error" in resp, resp

    def test_permitted_tool_executes_end_to_end(self, monkeypatch):
        """Symmetric control: a non-denied tool DOES reach execution."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.setenv("DENIED_TOOLS", "dangerous_tool")
        fake_mod = _install_fake_strands(monkeypatch)

        class _DrivingAgent(fake_mod.Agent):
            def dispatch_tool(self, tool_use, executed_log):
                pre = None
                if self.tool_handler is not None:
                    pre = self.tool_handler.preprocess(tool_use)
                if pre is not None:
                    return pre
                executed_log.append(tool_use["name"])
                return {"status": "success", "content": [{"text": "ran"}]}

        fake_mod.Agent = _DrivingAgent

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    executed = []\n"
            "    a = Agent(tools=[])\n"
            "    result = a.dispatch_tool({'name': 'safe_tool', 'toolUseId': 'tu-2'}, executed)\n"
            "    return f'executed={executed};status={result.get(\"status\")}'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        resp = parsed["response"]
        assert "executed=['safe_tool']" in resp, resp
        assert "status=success" in resp, resp


# ---------------------------------------------------------------------------
# Per-agent model override — agent_runner._install_model_override.
#
# When MODEL_OVERRIDE is set in the subprocess env, agent_runner MUST patch
# strands.models.BedrockModel.__init__ so every BedrockModel(...) built inside
# the loaded module is forced onto the operator-selected model id. When the
# env var is unset the patch is a no-op (backward compatible).
# ---------------------------------------------------------------------------


class TestAgentRunnerModelOverride:
    """MODEL_OVERRIDE subprocess wiring — BedrockModel.model_id patch contract."""

    def test_override_forces_bedrock_model_id_when_env_set(self, monkeypatch):
        """MODEL_OVERRIDE set -> BedrockModel(...) gets model_id == override."""
        monkeypatch.setenv("MODEL_OVERRIDE", "us.p.model-override")
        fake_mod = _install_fake_strands(monkeypatch)

        sys.modules.pop("agent_runner", None)
        from agent_runner import _install_model_override

        installed = _install_model_override()

        assert installed is True
        # Even when caller passes a different id, the override wins.
        model = fake_mod.models.BedrockModel(model_id="original.p.model")
        assert model.kwargs["model_id"] == "us.p.model-override"
        # And when caller passes no id at all, the override is injected.
        model2 = fake_mod.models.BedrockModel()
        assert model2.kwargs["model_id"] == "us.p.model-override"

    def test_no_patch_when_env_unset(self, monkeypatch):
        """Backward-compat: no MODEL_OVERRIDE -> returns False, __init__ untouched."""
        monkeypatch.delenv("MODEL_OVERRIDE", raising=False)
        fake_mod = _install_fake_strands(monkeypatch)
        original_init = fake_mod.models.BedrockModel.__init__

        sys.modules.pop("agent_runner", None)
        from agent_runner import _install_model_override

        installed = _install_model_override()

        assert installed is False
        assert fake_mod.models.BedrockModel.__init__ is original_init
        model = fake_mod.models.BedrockModel(model_id="original.p.model")
        assert model.kwargs["model_id"] == "original.p.model"

    def test_graceful_degrade_when_strands_unimportable(self, monkeypatch):
        """Missing strands -> WARN + return False, no crash."""
        monkeypatch.setenv("MODEL_OVERRIDE", "us.p.model-override")
        monkeypatch.delitem(sys.modules, "strands", raising=False)
        monkeypatch.delitem(sys.modules, "strands.models", raising=False)

        import builtins
        real_import = builtins.__import__

        def failing_import(name, *args, **kwargs):
            if name == "strands" or name.startswith("strands."):
                raise ImportError("strands unavailable (simulated)")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", failing_import)

        sys.modules.pop("agent_runner", None)
        from agent_runner import _install_model_override

        assert _install_model_override() is False


# ---------------------------------------------------------------------------
# Fail-loud idempotency install + best-effort governance guard.
#
# The idempotency hook is a fail-closed security control: inside an active
# idempotency envelope (CITADEL_EXECUTION_ID + CITADEL_NODE_ID set) a hook
# that cannot install must ABORT the node — never degrade to a warning — so it
# can never be mistaken for protected. Governance injection, by contrast, is
# best-effort AND its tool_handler seam is absent on strands 1.30.0, so it must
# skip (not crash the agent) when the seam is unavailable.
# ---------------------------------------------------------------------------

import types


def _fresh_agent_runner():
    sys.modules.pop("agent_runner", None)
    import agent_runner
    return agent_runner


class TestIdempotencyHookFailsLoud:
    def test_backcompat_noop_when_envelope_absent(self, monkeypatch):
        """No envelope (no execution/node id) → silent no-op, never raises,
        even with strands unavailable. Preserves agents run outside the
        idempotency envelope."""
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        monkeypatch.setitem(sys.modules, "strands", None)  # import strands -> ImportError
        agent_runner = _fresh_agent_runner()
        assert agent_runner._install_idempotency_hook() is False

    def test_raises_when_envelope_active_and_strands_unavailable(self, monkeypatch):
        """Envelope active + strands not importable → RAISE (fail the node),
        never a silent warn/return-False."""
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        monkeypatch.setitem(sys.modules, "strands", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="idempotency hook REQUIRED"):
            agent_runner._install_idempotency_hook()

    def test_raises_when_envelope_active_and_hook_module_unimportable(self, monkeypatch):
        """Envelope active, strands present, but the hook module can't be
        imported (simulating a packaging/bundle regression) → RAISE with a
        diagnostic naming the likely packaging cause."""
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        monkeypatch.setitem(sys.modules, "strands", types.ModuleType("strands"))
        # Force `from tool_idempotency_hook import ...` to fail deterministically.
        monkeypatch.setitem(sys.modules, "tool_idempotency_hook", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="tool_idempotency_hook"):
            agent_runner._install_idempotency_hook()


class TestGovernanceInjectionBestEffortGuard:
    def test_skips_without_crashing_when_agent_lacks_tool_handler_seam(self, monkeypatch):
        """strands 1.30.0's Agent.__init__ accepts neither ``tool_handler`` nor
        **kwargs. Injecting a tool_handler kwarg would raise TypeError at every
        Agent construction. The installer must detect the missing seam and skip
        (return False, no patch) rather than break agent construction."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")

        fake_strands = types.ModuleType("strands")

        class _FakeAgent:
            # Mirrors strands 1.30.0: no tool_handler, no **kwargs.
            def __init__(self, model=None, tools=None, hooks=None):
                self.tools = tools

        fake_strands.Agent = _FakeAgent
        monkeypatch.setitem(sys.modules, "strands", fake_strands)

        agent_runner = _fresh_agent_runner()
        original_init = _FakeAgent.__init__
        assert agent_runner._install_governed_tool_handler() is False
        # The installer must NOT have patched Agent.__init__.
        assert _FakeAgent.__init__ is original_init
