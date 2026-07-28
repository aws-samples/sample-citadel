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

Why no new dependency: ``aws-xray-sdk`` is NOT in this service's
``requirements.txt`` (the service's own tracing story is OpenTelemetry via
``strands-agents[otel]`` / Langfuse, not X-Ray) and is out of scope to add
here per the "no new deps" convention. ``active_trace_context()`` therefore
imports ``aws_xray_sdk`` lazily inside a try/except and returns ``None``
whenever it is unavailable — which is the case for every current
deployment of this service. This makes the helper a genuine, honest no-op
today: ``publish_usage_event``/``_publish_event`` never carry a
``traceContext`` in the real deployed container right now, and the
byte-identical-when-absent guarantee holds unconditionally. If
``aws-xray-sdk`` is later added to this service's requirements (an
infra-level follow-up, not a code change), tracing activates automatically
with no further edits here.
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
