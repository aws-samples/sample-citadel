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
        # Additive, nullable (Pass 1, decision f1cbd5ef, design §2 "Carried
        # trace context" row): stamp the server-minted run_id when the
        # carried context happens to include one. Absent ⇒ no annotation,
        # same discipline as every other key above.
        if carried.get("runId"):
            segment.put_annotation("run_id", carried["runId"])
        segment.put_metadata("trace_context", carried)
    except Exception:  # noqa: BLE001 — annotation failure must never break the consumer
        logger.debug("annotate_from_carried failed; continuing untraced.", exc_info=True)


def _is_facade_segment(entity: Any) -> bool:
    """True when *entity* is the Lambda-service-owned ``FacadeSegment`` —
    the root segment X-Ray hands a Lambda invocation, whose ``put_annotation``
    (and every other mutator) unconditionally raises
    ``FacadeSegmentMutationException`` ("FacadeSegment cannot be modified").
    Only its *subsegments* are mutable and exported.

    Import-safe: imports ``FacadeSegment`` lazily so a missing/old X-Ray SDK
    degrades to ``False`` (treated as a plain, presumably-mutable segment)
    rather than raising here — the caller's own try/except plus the
    put_annotation-raises fallback below still protects against a facade
    slipping through.
    """
    try:
        from aws_xray_sdk.core.models.facade_segment import FacadeSegment

        return isinstance(entity, FacadeSegment)
    except Exception:  # noqa: BLE001 — detection failure must never break the caller
        return False


def _annotate_target(
    target: Any,
    *,
    run_id: Optional[str],
    execution_id: Optional[str],
    correlation_id: Optional[str],
    node_id: Optional[str],
    workflow_id: Optional[str],
) -> None:
    """Write the non-empty annotation keys onto *target* (a subsegment).
    Never raises: a ``FacadeSegment`` type-checks away via
    ``_is_facade_segment``, and any exception ``put_annotation`` itself
    raises (including a ``FacadeSegmentMutationException`` that somehow
    reaches here despite the type check) is swallowed by the caller's own
    try/except — this helper does not catch, by design, so callers must
    wrap it.
    """
    if target is None or _is_facade_segment(target):
        return
    if run_id:
        target.put_annotation("run_id", run_id)
    if execution_id:
        target.put_annotation("execution_id", execution_id)
    if correlation_id:
        target.put_annotation("correlation_id", correlation_id)
    if node_id:
        target.put_annotation("node_id", node_id)
    if workflow_id:
        target.put_annotation("workflow_id", workflow_id)


def annotate_execution(
    run_id: Optional[str] = None,
    execution_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    node_id: Optional[str] = None,
    workflow_id: Optional[str] = None,
) -> None:
    """Annotate a SUBSEGMENT with the workflow-execution identity (finding
    40061019, superseding the current-*segment*-first design from finding
    3d92ef6b / CIT-181): in a Lambda invocation ``xray_recorder.current_segment()``
    is the service-owned ``FacadeSegment``, whose ``put_annotation`` always
    raises ``FacadeSegmentMutationException`` ("FacadeSegment cannot be
    modified") — so the CIT-181 design silently dropped every annotation in
    Lambda (the exception is swallowed by this function's own outer
    try/except) even though the deploy looked healthy. Subsegment
    annotations DO export, so this now annotates ``current_subsegment()``
    when one is open, and otherwise opens a fresh subsegment (named
    ``citadel.execution``) to annotate. This function never leaves that
    fresh subsegment open — callers that want one held for a handler's
    duration must use ``execution_trace_scope`` instead (below), which owns
    the open/close lifecycle; a bare ``annotate_execution()`` call always
    closes anything it itself opened before returning.

    A ``FacadeSegment`` is never annotated, defense in depth: even if a
    caller somehow passes one in (or a future SDK version changes what
    ``current_subsegment()`` returns), ``_is_facade_segment`` type-checks it
    away from the annotation attempt, and the ``FacadeSegmentMutationException``
    /generic-exception catch around the whole body is a second backstop.

    Each parameter is optional and independently nullable; only non-empty
    string values are written via ``put_annotation``, mirroring
    ``annotate_from_carried``'s per-key omit-when-absent discipline — a
    handler that only has ``execution_id`` and ``node_id`` available
    annotates just those two keys. No-op when there is no active
    segment/subsegment and a fresh subsegment cannot be opened either (R10
    discipline), and no-op-safe when the X-Ray SDK itself is
    unavailable/disabled — never raises.

    Key names match the TS-side query filters in
    ``backend/src/lambda/utils/trace-span-query.ts`` (``run_id``,
    ``correlation_id``) plus the additional ``execution_id``/``node_id``/
    ``workflow_id`` keys already used by ``annotate_from_carried``.
    """
    try:
        from aws_xray_sdk.core import xray_recorder

        target = xray_recorder.current_subsegment()
        opened_here = False
        if target is None:
            target = xray_recorder.begin_subsegment("citadel.execution")
            opened_here = True

        try:
            _annotate_target(
                target,
                run_id=run_id,
                execution_id=execution_id,
                correlation_id=correlation_id,
                node_id=node_id,
                workflow_id=workflow_id,
            )
        finally:
            if opened_here:
                xray_recorder.end_subsegment()
    except Exception:  # noqa: BLE001 — annotation failure must never break the consumer
        logger.debug("annotate_execution failed; continuing untraced.", exc_info=True)


class execution_trace_scope:  # noqa: N801 — lowercase context-manager name matches contextlib convention
    """Context manager keeping ONE ``citadel.execution`` subsegment open for
    the duration of a handler's work (finding 40061019), so every SDK
    subsegment the handler's own code opens (e.g. patched boto3 calls)
    nests under a single annotated parent instead of each call site
    re-annotating (or, worse, re-opening/closing) its own transient
    subsegment.

    Usage::

        with execution_trace_scope(run_id=..., execution_id=..., node_id=...):
            do_the_work()

    Behavior:
      - If a subsegment is ALREADY open when the scope is entered, this
        annotates that existing subsegment directly and does NOT open (or
        later close) a new one — the caller's existing subsegment keeps its
        own lifecycle untouched.
      - Otherwise opens a fresh ``citadel.execution`` subsegment, annotates
        it, and ends it in a ``finally`` on scope exit — on success AND on
        exception. Never suppresses an exception raised inside the ``with``
        body (the exception's original type/traceback propagates
        unchanged).
      - Never raises: opening/annotating/closing failures (missing X-Ray
        SDK, disabled tracing, no active segment to attach a subsegment to)
        are swallowed, mirroring every other helper in this module. A
        handler's business logic must never fail because tracing failed.
    """

    def __init__(
        self,
        run_id: Optional[str] = None,
        execution_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        node_id: Optional[str] = None,
        workflow_id: Optional[str] = None,
    ) -> None:
        self._run_id = run_id
        self._execution_id = execution_id
        self._correlation_id = correlation_id
        self._node_id = node_id
        self._workflow_id = workflow_id
        self._opened_here = False

    def __enter__(self) -> "execution_trace_scope":
        target = None
        try:
            from aws_xray_sdk.core import xray_recorder

            target = xray_recorder.current_subsegment()
            if target is None:
                target = xray_recorder.begin_subsegment("citadel.execution")
                self._opened_here = True
        except Exception:  # noqa: BLE001 — scope entry must never break the caller
            logger.debug("execution_trace_scope failed to open; continuing untraced.", exc_info=True)
            self._opened_here = False
            target = None

        try:
            _annotate_target(
                target,
                run_id=self._run_id,
                execution_id=self._execution_id,
                correlation_id=self._correlation_id,
                node_id=self._node_id,
                workflow_id=self._workflow_id,
            )
        except Exception:  # noqa: BLE001 — annotation failure must never break the caller
            logger.debug("execution_trace_scope failed to annotate; continuing untraced.", exc_info=True)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._opened_here:
            try:
                from aws_xray_sdk.core import xray_recorder

                xray_recorder.end_subsegment()
            except Exception:  # noqa: BLE001 — scope exit must never break the caller
                logger.debug("execution_trace_scope failed to close; continuing untraced.", exc_info=True)
        # Never suppress the caller's exception (if any) — return falsy/None.
        return None


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

