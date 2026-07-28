"""Property-based tests for arbiter/workerWrapper/agent_runner.py usage capture.

Exercises the third patch installer, ``_install_usage_capture``, which wraps
``strands.models.BedrockModel``'s response-producing method to append
``source='worker'`` usage records to a module-global list, and the
``main()`` stdout envelope change from a bare ``{"response": ...}`` to
``{"response": ..., "usage": [...]}``.

Mirrors the conventions in ``test_agent_runner_properties.py`` (fake strands
module injection via monkeypatch, temp-module handler execution, captured
stdout parsing).
"""

import sys
import os
import json
import tempfile
import types
from unittest.mock import patch

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _install_fake_strands_with_bedrock(monkeypatch, converse_impl=None):
    """Install a fake ``strands`` module with a ``BedrockModel`` exposing a
    ``converse`` method, so ``_install_usage_capture`` has a real seam to
    patch. ``converse_impl`` lets the caller control the wrapped method's
    behaviour (return value or raise).
    """
    fake_mod = types.ModuleType("strands")

    class _FakeAgent:
        def __init__(self, *args, tool_handler=None, tools=None, **kwargs):
            self.tool_handler = tool_handler
            self.tools = list(tools) if tools is not None else []

    fake_mod.Agent = _FakeAgent
    fake_models = types.ModuleType("strands.models")

    class _BedrockModelStub:
        def __init__(self, *args, **kwargs):
            self.model_id = kwargs.get("model_id")
            self.args = args
            self.kwargs = kwargs

        def converse(self, *args, **kwargs):
            if converse_impl is not None:
                return converse_impl(self, *args, **kwargs)
            return {
                "usage": {"inputTokens": 7, "outputTokens": 3, "totalTokens": 10}
            }

    fake_models.BedrockModel = _BedrockModelStub
    fake_mod.models = fake_models
    monkeypatch.setitem(sys.modules, "strands", fake_mod)
    monkeypatch.setitem(sys.modules, "strands.models", fake_models)
    return fake_mod


def _run_runner_with_module(module_src, request, captured):
    """Execute ``agent_runner.main()`` against a temp module, capturing stdout."""
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


# ---------------------------------------------------------------------------
# Envelope: {"response": ..., "usage": [...]}
# ---------------------------------------------------------------------------

class TestAgentRunnerUsageEnvelope:
    """main() stdout envelope always carries a 'usage' key."""

    @given(return_value=st.text(max_size=100))
    @settings(max_examples=20, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_envelope_always_has_usage_key(self, monkeypatch, return_value):
        """Regardless of strands availability, stdout envelope has 'usage'."""
        monkeypatch.delenv("CITADEL_AGENT_ID", raising=False)
        monkeypatch.delitem(sys.modules, "strands", raising=False)
        module_src = (
            f"def handler(**kwargs):\n"
            f"    return {return_value!r}\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert "response" in parsed
        assert "usage" in parsed
        assert isinstance(parsed["usage"], list)

    def test_empty_usage_list_is_legal_when_no_bedrock_call_made(self, monkeypatch):
        """A handler that never calls BedrockModel produces usage == []."""
        _install_fake_strands_with_bedrock(monkeypatch)
        module_src = (
            "def handler(**kwargs):\n"
            "    return 'no-model-call'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        assert parsed["usage"] == []


# ---------------------------------------------------------------------------
# _install_usage_capture — happy path
# ---------------------------------------------------------------------------

class TestInstallUsageCaptureHappyPath:
    def test_happy_path_capture_source_worker_call_index_zero(self, monkeypatch):
        """A single converse() call is captured as source='worker', callIndex 0."""
        _install_fake_strands_with_bedrock(monkeypatch)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    resp = m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        usage = parsed["usage"]
        assert len(usage) == 1
        record = usage[0]
        assert record["source"] == "worker"
        assert record["callIndex"] == 0
        assert record["latencyMs"] >= 0
        assert record["modelId"] == "m.test"
        assert record["inputTokens"] == 7
        assert record["outputTokens"] == 3

    def test_multiple_calls_increment_call_index_monotonically(self, monkeypatch):
        """Multiple converse() calls within one process get monotonic callIndex."""
        _install_fake_strands_with_bedrock(monkeypatch)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    m.converse()\n"
            "    m.converse()\n"
            "    m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        usage = parsed["usage"]
        assert len(usage) == 3
        assert [r["callIndex"] for r in usage] == [0, 1, 2]

    def test_model_override_env_wins_over_instance_attribute(self, monkeypatch):
        """MODEL_OVERRIDE env var takes priority over the instance's model_id."""
        monkeypatch.setenv("MODEL_OVERRIDE", "us.override.model")
        _install_fake_strands_with_bedrock(monkeypatch)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='original.model')\n"
            "    m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        # _install_model_override also runs and forces the instance's
        # model_id kwarg to the override, so the usage record should reflect
        # the override either via env-read priority or the (already
        # overridden) instance attribute — either way, override wins.
        assert parsed["usage"][0]["modelId"] == "us.override.model"


# ---------------------------------------------------------------------------
# _install_usage_capture — graceful degradation
# ---------------------------------------------------------------------------

class TestInstallUsageCaptureDegradation:
    def test_degrades_when_strands_unimportable(self, monkeypatch):
        """Missing strands -> no crash, run completes, usage stays []."""
        monkeypatch.delitem(sys.modules, "strands", raising=False)
        monkeypatch.delitem(sys.modules, "strands.models", raising=False)

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
        parsed = json.loads(captured[0])
        assert parsed["response"] == "ran-without-strands"
        assert parsed["usage"] == []

    def test_degrades_when_bedrock_model_absent(self, monkeypatch):
        """strands present but no BedrockModel -> no crash, usage stays []."""
        fake_mod = types.ModuleType("strands")
        fake_mod.Agent = object
        fake_models = types.ModuleType("strands.models")
        # No BedrockModel attribute at all.
        fake_mod.models = fake_models
        monkeypatch.setitem(sys.modules, "strands", fake_mod)
        monkeypatch.setitem(sys.modules, "strands.models", fake_models)

        module_src = (
            "def handler(**kwargs):\n"
            "    return 'ran-without-bedrock-model'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        assert parsed["response"] == "ran-without-bedrock-model"
        assert parsed["usage"] == []

    def test_capture_never_breaks_run_when_seam_raises(self, monkeypatch):
        """If the wrapped converse() raises, the exception propagates to the
        handler (unchanged behavior) but the capture machinery itself must
        not introduce a NEW failure mode — no crash inside agent_runner's
        capture bookkeeping.
        """
        def _raising_converse(self, *args, **kwargs):
            raise RuntimeError("bedrock boom")

        _install_fake_strands_with_bedrock(monkeypatch, converse_impl=_raising_converse)

        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    try:\n"
            "        m.converse()\n"
            "    except RuntimeError as e:\n"
            "        return f'caught:{e}'\n"
            "    return 'unreachable'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        assert parsed["response"] == "caught:bedrock boom"
        # The failed call must not have appended a bogus usage record.
        assert parsed["usage"] == []

    def test_returns_false_when_seam_method_not_found(self, monkeypatch):
        """BedrockModel without converse/stream/structured_output -> installer
        returns False and degrades without raising."""
        fake_mod = types.ModuleType("strands")
        fake_mod.Agent = object
        fake_models = types.ModuleType("strands.models")

        class _NoSeamBedrockModel:
            def __init__(self, *args, **kwargs):
                pass

        fake_models.BedrockModel = _NoSeamBedrockModel
        fake_mod.models = fake_models
        monkeypatch.setitem(sys.modules, "strands", fake_mod)
        monkeypatch.setitem(sys.modules, "strands.models", fake_models)

        sys.modules.pop("agent_runner", None)
        from agent_runner import _install_usage_capture

        installed = _install_usage_capture()
        assert installed is False


# ---------------------------------------------------------------------------
# _install_usage_capture — bedrockRequestId capture (present/absent, never raises)
# ---------------------------------------------------------------------------

class TestInstallUsageCaptureBedrockRequestId:
    """bedrockRequestId is captured when the SDK response carries
    ResponseMetadata.RequestId, and cleanly omitted (never fabricated) when
    it does not — for both the non-streaming and streaming capture paths."""

    def test_non_streaming_response_with_request_id_is_captured(self, monkeypatch):
        def _converse_with_request_id(self, *args, **kwargs):
            return {
                "usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
                "ResponseMetadata": {"RequestId": "req-abc-123"},
            }

        _install_fake_strands_with_bedrock(monkeypatch, converse_impl=_converse_with_request_id)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        record = parsed["usage"][0]
        assert record["bedrockRequestId"] == "req-abc-123"

    def test_non_streaming_response_without_request_id_omits_key(self, monkeypatch):
        """Default fake converse() (no ResponseMetadata) never fabricates a
        bedrockRequestId — the key must be absent entirely, not null."""
        _install_fake_strands_with_bedrock(monkeypatch)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        record = parsed["usage"][0]
        assert "bedrockRequestId" not in record

    def test_malformed_response_metadata_never_raises_and_omits_key(self, monkeypatch):
        def _converse_with_bad_metadata(self, *args, **kwargs):
            return {
                "usage": {"inputTokens": 1, "outputTokens": 1},
                "ResponseMetadata": "not-a-dict",
            }

        _install_fake_strands_with_bedrock(monkeypatch, converse_impl=_converse_with_bad_metadata)
        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    m.converse()\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        record = parsed["usage"][0]
        assert "bedrockRequestId" not in record

    def test_streaming_response_with_metadata_request_id_is_captured(self, monkeypatch):
        """Streaming seam: the wrapped generator's per-event metadata may
        carry a ResponseMetadata block; the last non-empty id observed
        across the stream wins (mirrors last_usage's semantics)."""
        fake_mod = types.ModuleType("strands")

        class _FakeAgent:
            def __init__(self, *args, tool_handler=None, tools=None, **kwargs):
                pass

        fake_mod.Agent = _FakeAgent
        fake_models = types.ModuleType("strands.models")

        def _stream_events(self, *args, **kwargs):
            yield {"chunk": "part1"}
            yield {
                "metadata": {
                    "usage": {"inputTokens": 4, "outputTokens": 5, "totalTokens": 9},
                    "ResponseMetadata": {"RequestId": "req-stream-1"},
                }
            }

        class _BedrockModelStub:
            def __init__(self, *args, **kwargs):
                self.model_id = kwargs.get("model_id")

            def stream(self, *args, **kwargs):
                return _stream_events(self, *args, **kwargs)

        fake_models.BedrockModel = _BedrockModelStub
        fake_mod.models = fake_models
        monkeypatch.setitem(sys.modules, "strands", fake_mod)
        monkeypatch.setitem(sys.modules, "strands.models", fake_models)

        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    for _ in m.stream():\n"
            "        pass\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        record = parsed["usage"][0]
        assert record["bedrockRequestId"] == "req-stream-1"

    def test_streaming_response_without_request_id_omits_key(self, monkeypatch):
        """Streaming path with no ResponseMetadata anywhere in the stream
        never fabricates a bedrockRequestId."""
        fake_mod = types.ModuleType("strands")

        class _FakeAgent:
            def __init__(self, *args, tool_handler=None, tools=None, **kwargs):
                pass

        fake_mod.Agent = _FakeAgent
        fake_models = types.ModuleType("strands.models")

        def _stream_events(self, *args, **kwargs):
            yield {"chunk": "part1"}
            yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1}}}

        class _BedrockModelStub:
            def __init__(self, *args, **kwargs):
                self.model_id = kwargs.get("model_id")

            def stream(self, *args, **kwargs):
                return _stream_events(self, *args, **kwargs)

        fake_models.BedrockModel = _BedrockModelStub
        fake_mod.models = fake_models
        monkeypatch.setitem(sys.modules, "strands", fake_mod)
        monkeypatch.setitem(sys.modules, "strands.models", fake_models)

        module_src = (
            "from strands.models import BedrockModel\n"
            "def handler(**kwargs):\n"
            "    m = BedrockModel(model_id='m.test')\n"
            "    for _ in m.stream():\n"
            "        pass\n"
            "    return 'ok'\n"
        )
        captured = []
        _run_runner_with_module(module_src, {}, captured)
        parsed = json.loads(captured[0])
        record = parsed["usage"][0]
        assert "bedrockRequestId" not in record
