"""Trace-context helpers for the agent_intake_single service (architect task
f4f4bab3-7a07-4acf-ba43-ba43bb488444, design §"Carried-context format
decision" / §"Annotation-key contract", file-list item 11).

Deliberately a SELF-CONTAINED COPY of the relevant subset of
``arbiter/common/tracing.py`` rather than a cross-package import.

Why not ``import common.tracing``: this service is packaged as its own
AgentCore Runtime container asset — the CDK asset root is
``service/agent_intake_single/`` only (see
``backend/lib/services-stack.ts``'s ``AgentRuntimeArtifact.fromAsset``), so
``arbiter/common`` is never copied into the built image. An import across
that boundary would pass in local/dev environments (where the monorepo
happens to have ``arbiter/`` on `sys.path`) but ImportError in the actual
deployed container — a latent prod-only break. Duplicating the small,
no-op-safe subset needed here avoids that trap entirely.

No X-Ray segment source exists in this container, and none is needed:
there is no X-Ray daemon, no ``_X_AMZN_TRACE_ID`` in the environment, and
``aws-xray-sdk`` is deliberately NOT in this service's ``requirements.txt``.
The container's Dockerfile runs ``opentelemetry-instrument python
agent.py`` (ADOT auto-instrumentation) together with ``strands-agents
[otel]``, so the live trace source is the current OpenTelemetry span
context, not an X-Ray (sub)segment. ``active_trace_context()`` reads that
OTel span context and renders it into the X-Ray form
(``1-<8 hex>-<24 hex>`` traceId, 16-hex parentId, sampled from
``trace_flags``) that ADOT's own X-Ray propagator produces, so ids stay
compatible with the platform's trace search — no new dependency is
required for this to work. The X-Ray branch is kept as a harmless fallback
for the (currently nonexistent) case where ``aws-xray-sdk`` is added and an
X-Ray segment is actually open. Both branches import their respective
packages lazily inside a try/except and degrade to ``None`` when
unavailable or when the context is invalid — never raising — so
``publish_usage_event``/``_publish_event`` omit ``traceContext`` entirely
(not null/empty) whenever neither source yields a valid context, keeping
the byte-identical-when-absent guarantee.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

_XRAY_ROOT_RE = re.compile(r"^1-([0-9a-f]{8})-([0-9a-f]{24})$", re.IGNORECASE)
_TRACE_HEADER_ROOT_RE = re.compile(r"Root=([^;]+)")


def render_xray_header(trace_id: str, parent_id: str, sampled: bool) -> Optional[str]:
    """Render "Root=<traceId>;Parent=<id>;Sampled=<0|1>" — identical mapping
    to ``arbiter/common/tracing.render_xray_header``."""
    if not trace_id or not parent_id:
        return None
    return f"Root={trace_id};Parent={parent_id};Sampled={1 if sampled else 0}"


def to_traceparent(xray_trace_id: str, parent_id: str, sampled: bool) -> Optional[str]:
    """Mechanical X-Ray Root -> W3C traceparent conversion, identical mapping
    to ``arbiter/common/tracing.to_traceparent``. Returns None for malformed
    input rather than raising."""
    match = _XRAY_ROOT_RE.match(xray_trace_id or "")
    if not match or not parent_id:
        return None
    trace_id_32 = f"{match.group(1)}{match.group(2)}"
    flags = "01" if sampled else "00"
    return f"00-{trace_id_32}-{parent_id}-{flags}"


def active_trace_context() -> Optional[dict]:
    """Read the active trace context and render it into the additive
    ``traceContext`` shape.

    Source priority:
    1. OpenTelemetry current span context — the LIVE source in this
       container (ADOT auto-instrumentation via ``opentelemetry-instrument``
       + ``strands-agents[otel]``). Rendered into X-Ray form so ids stay
       compatible with the platform's trace search, matching what ADOT's
       own X-Ray propagator produces.
    2. X-Ray (sub)segment — kept as a harmless fallback for a future
       environment where ``aws-xray-sdk`` is added and a segment is open.
       Not expected to ever fire in this container today (no daemon, no
       ``_X_AMZN_TRACE_ID``).

    Returns None when neither source yields a valid context, or when the
    relevant package is not installed — never raises.
    """
    otel_context = _active_otel_trace_context()
    if otel_context:
        return otel_context
    return _active_xray_trace_context()


def _active_otel_trace_context() -> Optional[dict]:
    """Render the current OpenTelemetry span context (if valid) into the
    carried ``traceContext`` shape, X-Ray-form ids. Returns None when
    ``opentelemetry`` is not installed or there is no valid current span —
    never raises."""
    try:
        from opentelemetry import trace as otel_trace  # type: ignore

        span_context = otel_trace.get_current_span().get_span_context()
        if not span_context or not span_context.is_valid:
            return None
        trace_id_hex = format(span_context.trace_id, "032x")
        span_id_hex = format(span_context.span_id, "016x")
        sampled = bool(span_context.trace_flags.sampled)
        trace_id = f"1-{trace_id_hex[:8]}-{trace_id_hex[8:]}"
        parent_id = span_id_hex
        xray_trace_header = render_xray_header(trace_id, parent_id, sampled)
        traceparent = to_traceparent(trace_id, parent_id, sampled)
        result: dict = {"traceId": trace_id, "parentId": parent_id}
        if xray_trace_header:
            result["xrayTraceHeader"] = xray_trace_header
        if traceparent:
            result["traceparent"] = traceparent
        return result
    except Exception:  # noqa: BLE001 — no-op-safe (incl. ImportError when opentelemetry absent)
        return None


def _active_xray_trace_context() -> Optional[dict]:
    """Read the active X-Ray (sub)segment, if any, and render it into the
    additive ``traceContext`` shape. Returns None when no segment is active
    OR when ``aws_xray_sdk`` is not installed (the current, real state of
    this service) — never raises.
    """
    try:
        from aws_xray_sdk.core import xray_recorder  # type: ignore

        segment = xray_recorder.current_subsegment() or xray_recorder.current_segment()
        if not segment:
            return None
        trace_id = getattr(segment, "trace_id", None)
        parent_id = getattr(segment, "id", None)
        if not trace_id or not parent_id:
            return None
        sampled = not getattr(segment, "not_traced", False)
        xray_trace_header = render_xray_header(trace_id, parent_id, sampled)
        traceparent = to_traceparent(trace_id, parent_id, sampled)
        result: dict = {"traceId": trace_id, "parentId": parent_id}
        if xray_trace_header:
            result["xrayTraceHeader"] = xray_trace_header
        if traceparent:
            result["traceparent"] = traceparent
        return result
    except Exception:  # noqa: BLE001 — no-op-safe (incl. ImportError when aws_xray_sdk absent)
        return None


def extract_carried(detail: Any) -> Optional[dict]:
    """Extract a well-formed carried ``traceContext`` dict from an arbitrary
    object. Returns None for missing/non-dict/malformed input — never
    raises."""
    try:
        if not isinstance(detail, dict):
            return None
        candidate = detail.get("traceContext")
        if not isinstance(candidate, dict):
            return None
        return candidate
    except Exception:  # noqa: BLE001
        return None


class TraceIdLogFilter(logging.Filter):
    """Logging filter injecting ``trace_id`` into every record, mirroring
    ``arbiter/common/tracing.TraceIdLogFilter``. No-op (adds nothing) when
    no active segment / no ``aws_xray_sdk`` — never raises."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            ctx = active_trace_context()
            trace_id = ctx.get("traceId") if ctx else None
            if not trace_id:
                import os

                header = os.environ.get("_X_AMZN_TRACE_ID", "")
                match = _TRACE_HEADER_ROOT_RE.search(header)
                if match:
                    trace_id = match.group(1)
            if trace_id:
                record.trace_id = trace_id
        except Exception:  # noqa: BLE001 — filter must never break logging
            pass
        return True


def install_log_filter(target_logger: logging.Logger) -> None:
    """Attach a ``TraceIdLogFilter`` idempotently. Never raises."""
    try:
        if any(isinstance(f, TraceIdLogFilter) for f in target_logger.filters):
            return
        target_logger.addFilter(TraceIdLogFilter())
    except Exception:  # noqa: BLE001
        logger.debug("install_log_filter failed; continuing without trace_id injection.", exc_info=True)
