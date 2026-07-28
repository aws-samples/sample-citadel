"""Tracing foundation — X-Ray SDK activation for the Python arbiter.

Companion to the TypeScript backend's ``utils/dynamodb.ts`` /
``utils/events.ts`` wrap (architect task
5459301e-1e7b-4bfd-bccb-b106aba2748c, design §1(b)/§6 items 9-11): the
arbiter's boto3 clients are constructed inline, module-level, with no
shared factory (``supervisor/index.py``'s ``sqs``/``bedrock-runtime``/
``events`` clients, ``stepRunner/events.py``'s ``events`` client,
``stepRunner/executor.py``'s ``sqs``/``cloudwatch`` clients). Rather than
wrapping each construction point individually, ``aws_xray_sdk.core.patch_all()``
patches ``botocore`` process-wide, so importing this module once — before
any boto3 client is constructed — instruments every inline client with a
single call. This is the Python equivalent of the TS single-wrap-point
strategy; in particular it gives the supervisor's ``bedrock-runtime``
Converse calls an X-Ray subsegment, which is the acceptance-critical
"Bedrock call site" for the arbiter side of the trace.

No-op-safety:
  - ``patch_all()`` (via ``aws_xray_sdk.core.global_sdk_config.sdk_enabled()``)
    is a no-op when the ``AWS_XRAY_SDK_ENABLED`` env var is set to a falsy
    value — set this in a test environment (e.g. pytest, no X-Ray
    daemon/Lambda runtime present) to skip patching entirely.
  - Even when patching IS active, X-Ray's context-missing behavior is
    controlled by ``AWS_XRAY_CONTEXT_MISSING`` (default ``LOG_ERROR`` in
    this SDK version — see the TS-side rationale in
    ``backend/src/utils/dynamodb.ts``): a patched boto3 call made with no
    active segment/daemon logs and continues rather than raising.
  - ``configure()`` is idempotent — calling it multiple times (e.g. from
    both ``supervisor/index.py`` and a test import) only calls
    ``patch_all()`` once per process, guarded by a module-level flag.
    ``patch_all()`` itself is also safe to call repeatedly (the underlying
    ``wrapt`` patching machinery checks whether a callable is already
    wrapped), but the explicit guard keeps the intent — and the "exactly
    once" assertion in tests — obvious.

Import-order-safety: this module must be imported BEFORE any boto3 client
is constructed in a given process, so botocore is patched before the
client's underlying session is created. Each entry point below imports
``common.tracing`` (and calls ``configure()``) at the very top of the
file, ahead of its own ``import boto3`` / client construction.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_configured = False


def configure() -> None:
    """Patch botocore (and other supported libraries) for X-Ray tracing.

    Safe to call multiple times — only the first call invokes
    ``patch_all()``. Never raises: a failure to patch (e.g. an
    unsupported/missing dependency) is logged and swallowed so a tracing
    activation problem can never break arbiter dispatch.
    """
    global _configured
    if _configured:
        return

    try:
        from aws_xray_sdk.core import patch_all

        patch_all()
    except Exception:  # noqa: BLE001 — tracing activation must never break dispatch
        logger.exception("Failed to activate X-Ray tracing (patch_all); continuing untraced.")
    finally:
        _configured = True


# Side-effect on import: every entry point that imports this module before
# constructing its boto3 clients gets tracing activated automatically,
# without needing to remember to call configure() explicitly. configure()
# itself is defensive (see above), so this is safe at import time.
configure()


# ---------------------------------------------------------------------------
# Trace-context propagation helpers (architect task f4f4bab3-7a07-4acf-ba43-
# ba43bb488444, design §"Carried-context format decision" /
# §"Annotation-key contract"). Mirror the TS backend/src/utils/trace-context.ts
# helpers so both runtimes carry the identical additive, optional
# `traceContext` shape and stamp the identical stable annotation keys.
#
# Root-segment constraint (honest framing, see design): Lambda owns its root
# segment, so these helpers never attempt to make a consumer adopt an
# upstream trace-id as its own root — they carry the additive context across
# async hops and annotate the CONSUMER's own active segment/subsegment with
# searchable `source_trace_id` / `correlation_id` keys, delivering
# provably-linked traces rather than a false merge.
#
# No-op-safety: every helper below is safe to call with NO active X-Ray
# segment/subsegment (pytest, local dev, a cold path before the Lambda
# runtime attaches a segment) — none of them raise.
# ---------------------------------------------------------------------------
import os
import re
from typing import Any, Optional

_XRAY_ROOT_RE = re.compile(r"^1-([0-9a-f]{8})-([0-9a-f]{24})$", re.IGNORECASE)
_TRACE_HEADER_ROOT_RE = re.compile(r"Root=([^;]+)")


def render_xray_header(trace_id: str, parent_id: str, sampled: bool) -> Optional[str]:
    """Render the standard X-Ray header string:
    "Root=<traceId>;Parent=<id>;Sampled=<0|1>" — the exact format the
    `AWSTraceHeader` SQS MessageAttribute and `_X_AMZN_TRACE_ID` env var use.
    """
    if not trace_id or not parent_id:
        return None
    return f"Root={trace_id};Parent={parent_id};Sampled={1 if sampled else 0}"


def to_traceparent(xray_trace_id: str, parent_id: str, sampled: bool) -> Optional[str]:
    """Mechanical, best-effort X-Ray Root -> W3C `traceparent` conversion —
    identical mapping to the TS-side `toTraceparent`. Returns None for a
    malformed X-Ray trace id rather than raising or fabricating a value.
    """
    match = _XRAY_ROOT_RE.match(xray_trace_id or "")
    if not match or not parent_id:
        return None
    trace_id_32 = f"{match.group(1)}{match.group(2)}"
    flags = "01" if sampled else "00"
    return f"00-{trace_id_32}-{parent_id}-{flags}"


def active_trace_context() -> Optional[dict]:
    """Read the active X-Ray (sub)segment (if any) and render it into the
    additive `traceContext` shape. Returns None outside a segment — never
    raises.
    """
    try:
        from aws_xray_sdk.core import xray_recorder

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
    except Exception:  # noqa: BLE001 — no-op-safe, tracing must never break the caller
        return None


def extract_carried(detail: Any) -> Optional[dict]:
    """Extract a well-formed carried `traceContext` dict from an arbitrary
    EventBridge detail / SQS message-body object. Returns None for a
    missing, non-dict, or malformed `traceContext` field — never raises.
    """
    try:
        if not isinstance(detail, dict):
            return None
        candidate = detail.get("traceContext")
        if not isinstance(candidate, dict):
            return None
        return candidate
    except Exception:  # noqa: BLE001 — extraction must never raise
        return None


def annotate_from_carried(carried: Optional[dict]) -> None:
    """Annotate the active X-Ray segment/subsegment from a carried
    `traceContext` (stable annotation-key contract — the waterfall-viewer
    story consumes these keys). No-op when there is no active segment AND
    no-op when `carried` is None/malformed — never raises.
    """
    try:
        from aws_xray_sdk.core import xray_recorder

        segment = xray_recorder.current_subsegment() or xray_recorder.current_segment()
        if not segment:
            return
        if not isinstance(carried, dict):
            return
        if carried.get("correlationId"):
            segment.put_annotation("correlation_id", carried["correlationId"])
        if carried.get("traceId"):
            segment.put_annotation("source_trace_id", carried["traceId"])
        if carried.get("executionId"):
            segment.put_annotation("execution_id", carried["executionId"])
        if carried.get("nodeId"):
            segment.put_annotation("node_id", carried["nodeId"])
        if carried.get("sessionId"):
            segment.put_annotation("session_id", carried["sessionId"])
        segment.put_metadata("trace_context", carried)
    except Exception:  # noqa: BLE001 — annotation failure must never break the consumer
        logger.debug("annotate_from_carried failed; continuing untraced.", exc_info=True)


class TraceIdLogFilter(logging.Filter):
    """Logging filter injecting `trace_id` into every record (stable
    contract, mirrors the TS `logger.ts` behaviour): read the active
    X-Ray segment first; fall back to parsing the Lambda-injected
    `_X_AMZN_TRACE_ID` env var; absent-safe otherwise. Never raises —
    a filter exception would silently drop the log record.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 — logging.Filter API
        try:
            ctx = active_trace_context()
            trace_id = ctx.get("traceId") if ctx else None
            if not trace_id:
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
    """Attach a `TraceIdLogFilter` to *target_logger*, idempotently (a
    second call is a no-op rather than a duplicate filter). Never raises.
    """
    try:
        if any(isinstance(f, TraceIdLogFilter) for f in target_logger.filters):
            return
        target_logger.addFilter(TraceIdLogFilter())
    except Exception:  # noqa: BLE001 — filter installation must never break startup
        logger.debug("install_log_filter failed; continuing without trace_id injection.", exc_info=True)

