"""Unit tests for tools.tracing.active_trace_context() — OTel branch.

Context (design residual fix): the intake container has NO X-Ray segment
source (no daemon, no ``_X_AMZN_TRACE_ID``; the container runs ADOT/OTLP
auto-instrumentation via ``opentelemetry-instrument python agent.py`` +
``strands-agents[otel]``). The live trace source is the current OpenTelemetry
span context, not an X-Ray (sub)segment. ``active_trace_context()`` must
render that OTel context into the same carried ``traceContext`` shape,
using X-Ray-form ids so the platform's trace search stays compatible with
what ADOT's X-Ray propagator produces.
"""
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# A known 32-hex OTel trace id and 16-hex span id used across assertions.
_OTEL_TRACE_ID_HEX = "11111111222233334444555566667777"
_OTEL_SPAN_ID_HEX = "1111222233334444"
_EXPECTED_XRAY_TRACE_ID = "1-11111111-222233334444555566667777"


def _fake_span_context(trace_id_hex: str, span_id_hex: str, sampled: bool, valid: bool = True):
    """Build an object shaped like opentelemetry.trace.SpanContext with the
    subset of attributes active_trace_context() reads."""
    ctx = mock.MagicMock()
    ctx.is_valid = valid
    ctx.trace_id = int(trace_id_hex, 16)
    ctx.span_id = int(span_id_hex, 16)
    flags = mock.MagicMock()
    flags.sampled = sampled
    ctx.trace_flags = flags
    return ctx


class TestActiveTraceContextOtelBranch:
    def test_valid_otel_span_context_renders_xray_form_trace_and_parent_id(self, monkeypatch):
        import tools.tracing as tracing

        span_context = _fake_span_context(_OTEL_TRACE_ID_HEX, _OTEL_SPAN_ID_HEX, sampled=True)
        fake_span = mock.MagicMock()
        fake_span.get_span_context.return_value = span_context

        fake_trace_module = mock.MagicMock()
        fake_trace_module.get_current_span.return_value = fake_span

        with mock.patch.dict(sys.modules, {
            "opentelemetry": mock.MagicMock(trace=fake_trace_module),
            "opentelemetry.trace": fake_trace_module,
        }):
            result = tracing.active_trace_context()

        assert result is not None
        assert result["traceId"] == _EXPECTED_XRAY_TRACE_ID
        assert result["parentId"] == _OTEL_SPAN_ID_HEX

    def test_valid_otel_span_context_carries_sampled_flag_from_trace_flags(self, monkeypatch):
        import tools.tracing as tracing

        span_context = _fake_span_context(_OTEL_TRACE_ID_HEX, _OTEL_SPAN_ID_HEX, sampled=True)
        fake_span = mock.MagicMock()
        fake_span.get_span_context.return_value = span_context
        fake_trace_module = mock.MagicMock()
        fake_trace_module.get_current_span.return_value = fake_span

        with mock.patch.dict(sys.modules, {
            "opentelemetry": mock.MagicMock(trace=fake_trace_module),
            "opentelemetry.trace": fake_trace_module,
        }):
            result = tracing.active_trace_context()

        assert result is not None
        assert result["xrayTraceHeader"] == f"Root={_EXPECTED_XRAY_TRACE_ID};Parent={_OTEL_SPAN_ID_HEX};Sampled=1"

        span_context_unsampled = _fake_span_context(_OTEL_TRACE_ID_HEX, _OTEL_SPAN_ID_HEX, sampled=False)
        fake_span_unsampled = mock.MagicMock()
        fake_span_unsampled.get_span_context.return_value = span_context_unsampled
        fake_trace_module_unsampled = mock.MagicMock()
        fake_trace_module_unsampled.get_current_span.return_value = fake_span_unsampled

        with mock.patch.dict(sys.modules, {
            "opentelemetry": mock.MagicMock(trace=fake_trace_module_unsampled),
            "opentelemetry.trace": fake_trace_module_unsampled,
        }):
            result_unsampled = tracing.active_trace_context()

        assert result_unsampled is not None
        assert result_unsampled["xrayTraceHeader"] == (
            f"Root={_EXPECTED_XRAY_TRACE_ID};Parent={_OTEL_SPAN_ID_HEX};Sampled=0"
        )

    def test_invalid_otel_span_context_returns_none(self, monkeypatch):
        import tools.tracing as tracing

        span_context = _fake_span_context(_OTEL_TRACE_ID_HEX, _OTEL_SPAN_ID_HEX, sampled=True, valid=False)
        fake_span = mock.MagicMock()
        fake_span.get_span_context.return_value = span_context
        fake_trace_module = mock.MagicMock()
        fake_trace_module.get_current_span.return_value = fake_span

        with mock.patch.dict(sys.modules, {
            "opentelemetry": mock.MagicMock(trace=fake_trace_module),
            "opentelemetry.trace": fake_trace_module,
        }):
            result = tracing.active_trace_context()

        assert result is None

    def test_absent_span_context_returns_none(self, monkeypatch):
        """No current span at all (e.g. get_current_span returns the OTel
        no-op/INVALID span) must degrade to None, never raise."""
        import tools.tracing as tracing

        span_context = _fake_span_context("0" * 32, "0" * 16, sampled=False, valid=False)
        fake_span = mock.MagicMock()
        fake_span.get_span_context.return_value = span_context
        fake_trace_module = mock.MagicMock()
        fake_trace_module.get_current_span.return_value = fake_span

        with mock.patch.dict(sys.modules, {
            "opentelemetry": mock.MagicMock(trace=fake_trace_module),
            "opentelemetry.trace": fake_trace_module,
        }):
            result = tracing.active_trace_context()

        assert result is None

    def test_opentelemetry_import_failure_returns_none_no_raise(self, monkeypatch):
        """opentelemetry not installed (the real state in this repo's
        default environment) must degrade to None — never raise. This is
        the same no-op-safe guarantee the X-Ray branch already had for
        aws_xray_sdk."""
        import tools.tracing as tracing

        real_import = __import__

        def _raise_on_otel(name, *args, **kwargs):
            if name == "opentelemetry" or name.startswith("opentelemetry."):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=_raise_on_otel):
            result = tracing.active_trace_context()

        assert result is None

    def test_no_active_context_from_either_source_returns_none(self):
        """Neither X-Ray nor OTel available/active: real environment for
        every current pytest run (aws_xray_sdk absent from requirements,
        no live span outside an active OTel context). Must be None."""
        import tools.tracing as tracing

        assert tracing.active_trace_context() is None


class TestDownstreamPublisherOmitsKeyWhenTraceContextAbsent:
    """R20 (design file-list item 11, H6), extended to the OTel source: the
    publisher must still omit ``traceContext`` entirely — not null/empty —
    when active_trace_context() yields None, regardless of which underlying
    source (X-Ray or OTel) produced that None."""

    def test_publish_usage_event_omits_trace_context_key_when_none(self, monkeypatch):
        import json
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")
        monkeypatch.setattr(state.tracing, "active_trace_context", lambda: None)

        state.publish_usage_event("sess-otel-1", {"source": "intake"})

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert "traceContext" not in detail
