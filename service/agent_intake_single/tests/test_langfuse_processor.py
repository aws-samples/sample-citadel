"""QW-D: Langfuse span export must be batched, not synchronous per-span.

``agent.py`` wires an OTLP exporter to Langfuse when LANGFUSE_PUBLIC_KEY and
LANGFUSE_SECRET_KEY are set. SimpleSpanProcessor exports every span with a
blocking HTTPS round-trip inside the request path; BatchSpanProcessor queues
spans and exports them on a background thread. Constructor-level assertions:
the processor TYPE decides where exports run, so pinning the type pins the
no-export-in-request-path behavior. When the keys are absent, telemetry must
stay entirely un-wired, exactly as before.

Run with:
    PYTHONPATH=. pytest tests/test_langfuse_processor.py -q
from the service/agent_intake_single directory.
"""
import importlib
import os
import sys
import types
from unittest import mock

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# The SUT (``agent.py``) imports ``bedrock_agentcore`` at module load, which
# is only available inside the AWS Bedrock AgentCore runtime image. Stub it
# here so the import chain resolves in a plain pytest venv (same rationale
# and shape as tests/test_agent_cache.py).
if 'bedrock_agentcore' not in sys.modules:
    stub = types.ModuleType('bedrock_agentcore')

    class _StubApp:
        def __init__(self, *a, **kw): pass
        def add_middleware(self, *a, **kw): pass  # real app registers CORS at import time
        def entrypoint(self, fn):
            return fn  # passthrough decorator

    class _StubRequestContext:
        pass

    stub.BedrockAgentCoreApp = _StubApp  # type: ignore[attr-defined]
    stub.RequestContext = _StubRequestContext  # type: ignore[attr-defined]
    sys.modules['bedrock_agentcore'] = stub


@pytest.fixture(autouse=True)
def _restore_agent_module():
    """These tests re-import ``agent`` under controlled env; restore the
    original module afterwards so the rest of the suite (cache tests, EMF
    path tests) keeps its reference semantics."""
    original = sys.modules.get("agent")
    yield
    if original is not None:
        sys.modules["agent"] = original
    else:
        sys.modules.pop("agent", None)


def _reimport_agent(monkeypatch, *, with_keys: bool):
    """Fresh-import agent.py with Langfuse keys present or absent.

    StrandsTelemetry is replaced with a MagicMock so no real tracer provider
    is mutated; dotenv loading is disabled so a developer's local .env can
    never leak keys into the keys-absent case.
    """
    if with_keys:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    else:
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

    import dotenv
    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **kw: None)

    import strands.telemetry
    fake_telemetry_cls = mock.MagicMock(name="StrandsTelemetry")
    monkeypatch.setattr(strands.telemetry, "StrandsTelemetry", fake_telemetry_cls)

    sys.modules.pop("agent", None)
    agent_module = importlib.import_module("agent")
    return agent_module, fake_telemetry_cls


def test_batch_processor_selected_when_langfuse_keys_present(monkeypatch):
    _, telemetry_cls = _reimport_agent(monkeypatch, with_keys=True)
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor

    telemetry_cls.assert_called_once()
    add_processor = telemetry_cls.return_value.tracer_provider.add_span_processor
    add_processor.assert_called_once()
    (processor,) = add_processor.call_args.args

    # BatchSpanProcessor => spans queue and export on a background thread,
    # never synchronously inside the request path.
    assert isinstance(processor, BatchSpanProcessor)
    assert not isinstance(processor, SimpleSpanProcessor)


def test_batch_processor_wraps_the_same_otlp_exporter(monkeypatch):
    _, telemetry_cls = _reimport_agent(monkeypatch, with_keys=True)
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    (processor,) = telemetry_cls.return_value.tracer_provider.add_span_processor.call_args.args
    assert isinstance(processor.span_exporter, OTLPSpanExporter)


def test_no_telemetry_wired_when_keys_absent(monkeypatch):
    _, telemetry_cls = _reimport_agent(monkeypatch, with_keys=False)
    telemetry_cls.assert_not_called()
