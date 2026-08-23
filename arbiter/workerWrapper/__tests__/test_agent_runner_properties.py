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
    """Install a fake ``strands`` module so agent_runner can patch Agent.__init__.

    A FRESH ``Agent`` subclass is handed out per call so the ``Agent.__init__``
    monkeypatch installed by ``_install_tool_call_hooks`` (which mutates the
    class object, not something monkeypatch auto-restores) never accumulates
    across tests within this reused worker process."""
    import types

    class _FreshAgent(_FakeStrandsAgent):
        pass

    fake_mod = types.ModuleType("strands")
    fake_mod.Agent = _FreshAgent
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
        """CITADEL_AGENT_ID set -> every Agent() in the loaded module gets the
        composed governance+idempotency hook appended to its hooks list (the
        re-ported seam; finding 027c4a89). The dead ``tool_handler`` kwarg is
        no longer used."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.setenv("CITADEL_WORKFLOW_ID", "wf-42")
        monkeypatch.setenv("DENIED_TOOLS", "tool_a,tool_b")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[])\n"
            "    hooks = a.kwargs.get('hooks') or []\n"
            "    h = hooks[0] if hooks else None\n"
            "    return (\n"
            "        f'count={len(hooks)};'\n"
            "        f'type={type(h).__name__};'\n"
            "        f'gov={h.governance is not None};'\n"
            "        f'idem={h.idempotency is not None}'\n"
            "    )\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1, captured
        parsed = json.loads(captured[0])
        resp = parsed["response"]
        assert "count=1" in resp, resp
        assert "type=ComposedToolHook" in resp, resp
        assert "gov=True" in resp, resp
        # No idempotency envelope here (supervisor task path) → governance only.
        assert "idem=False" in resp, resp

    def test_caller_hooks_preserved(self, monkeypatch):
        """When generated code passes its own hooks=, the composed hook is
        APPENDED (caller hooks preserved), never clobbered."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "_SENTINEL = object()\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[], hooks=[_SENTINEL])\n"
            "    hooks = a.kwargs.get('hooks') or []\n"
            "    return f'count={len(hooks)};first_is_sentinel={hooks[0] is _SENTINEL}'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        resp = parsed["response"]
        assert "count=2" in resp, resp
        assert "first_is_sentinel=True" in resp, resp

    def test_install_fails_loud_when_strands_unimportable_in_envelope(self, monkeypatch):
        """Fail-loud (finding 027c4a89 step 4): with a governance envelope
        active but strands unimportable, the installer RAISES — the node is
        never allowed to run unprotected under a silent skip."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-xyz")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
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
            "    return 'should-not-reach'\n"
        )
        captured = []
        with pytest.raises(RuntimeError, match="governance/idempotency REQUIRED"):
            _run_runner_with_module(module_src, {}, captured)

    def test_no_injection_leaves_agent_hooks_absent(self, monkeypatch):
        """Symmetric control: no envelope → composed hook not installed, so a
        plain Agent() has no injected hooks."""
        monkeypatch.delenv("CITADEL_AGENT_ID", raising=False)
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        _install_fake_strands(monkeypatch)

        module_src = (
            "from strands import Agent\n"
            "def handler(**kwargs):\n"
            "    a = Agent(tools=[])\n"
            "    return f'hooks={a.kwargs.get(\"hooks\")}'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert parsed["response"] == "hooks=None"


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
# Fail-loud composed install (governance + idempotency at one seam).
#
# The composed control is fail-closed: inside an ACTIVE envelope (governance =
# CITADEL_AGENT_ID; idempotency = CITADEL_EXECUTION_ID + CITADEL_NODE_ID) an
# uninstallable control must ABORT the node — never degrade to a warning — so
# it can never be mistaken for protected (finding 027c4a89 step 4). Governance
# now fails loud too, matching the idempotency rule. Outside any envelope the
# installer is a silent back-compat no-op.
# ---------------------------------------------------------------------------

import types


def _fresh_agent_runner():
    sys.modules.pop("agent_runner", None)
    import agent_runner
    return agent_runner


class TestComposedInstallFailsLoud:
    def test_backcompat_noop_when_no_envelope(self, monkeypatch):
        """No envelope → silent no-op, never raises, even with strands
        unavailable. Preserves agents run outside any envelope."""
        for v in ("CITADEL_AGENT_ID", "CITADEL_EXECUTION_ID", "CITADEL_NODE_ID"):
            monkeypatch.delenv(v, raising=False)
        monkeypatch.setitem(sys.modules, "strands", None)  # import strands -> ImportError
        agent_runner = _fresh_agent_runner()
        assert agent_runner._install_tool_call_hooks() is False

    def test_raises_when_idempotency_envelope_active_and_strands_unavailable(self, monkeypatch):
        """Idempotency envelope active + strands not importable → RAISE."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        monkeypatch.setitem(sys.modules, "strands", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="governance/idempotency REQUIRED"):
            agent_runner._install_tool_call_hooks()

    def test_raises_when_governance_envelope_active_and_strands_unavailable(self, monkeypatch):
        """Governance envelope active (no idempotency) + strands not importable
        → RAISE. Governance is now fail-loud, not a warning (the 027c4a89 fix)."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)
        monkeypatch.setitem(sys.modules, "strands", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="governance/idempotency REQUIRED"):
            agent_runner._install_tool_call_hooks()

    def test_raises_when_idempotency_hook_module_unimportable(self, monkeypatch):
        """Idempotency envelope active, strands present, but the hook module
        can't be imported (packaging/bundle regression) → RAISE naming the
        likely cause."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.setenv("CITADEL_EXECUTION_ID", "exec-1")
        monkeypatch.setenv("CITADEL_NODE_ID", "node-1")
        monkeypatch.setitem(sys.modules, "strands", types.ModuleType("strands"))
        monkeypatch.setitem(sys.modules, "tool_idempotency_hook", None)
        agent_runner = _fresh_agent_runner()
        with pytest.raises(RuntimeError, match="idempotency hook REQUIRED"):
            agent_runner._install_tool_call_hooks()


class TestGovernanceInstallsOnHooksSeam:
    def test_installs_via_hooks_on_seamless_agent(self, monkeypatch):
        """strands 1.30.0's Agent.__init__ accepts ``hooks`` but NOT
        ``tool_handler``. The re-ported installer must INSTALL (patch
        Agent.__init__ to append the composed hook) — the opposite of the old
        best-effort skip that left layer-2 inert (finding 027c4a89)."""
        monkeypatch.setenv("CITADEL_AGENT_ID", "agent-1")
        monkeypatch.delenv("CITADEL_EXECUTION_ID", raising=False)
        monkeypatch.delenv("CITADEL_NODE_ID", raising=False)

        fake_strands = types.ModuleType("strands")

        class _FakeAgent:
            # Mirrors strands 1.30.0: hooks accepted, no tool_handler.
            def __init__(self, model=None, tools=None, hooks=None):
                self.hooks = hooks

        fake_strands.Agent = _FakeAgent
        monkeypatch.setitem(sys.modules, "strands", fake_strands)

        agent_runner = _fresh_agent_runner()
        original_init = _FakeAgent.__init__
        assert agent_runner._install_tool_call_hooks() is True
        # The installer MUST have patched Agent.__init__.
        assert _FakeAgent.__init__ is not original_init
        # And the composed hook is appended to every constructed Agent.
        a = _FakeAgent(tools=[])
        assert isinstance(a.hooks, list) and len(a.hooks) == 1
        assert type(a.hooks[0]).__name__ == "ComposedToolHook"
