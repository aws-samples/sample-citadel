"""Shared model-invocation usage-record schema and helpers.

A ``UsageRecord`` is a plain dict describing one model invocation's token
counts and latency, captured either from the worker subprocess (wrapping a
Strands ``BedrockModel`` call) or from the supervisor's own Bedrock Converse
call. It is pure telemetry data — no I/O, no AWS clients, no global state —
so it can be imported from any layer (worker, supervisor, and later the
intake/workflow step-runner paths) without side effects.

Schema (``UsageRecord``)::

    {
        "modelId": str,        # "" if unknown
        "inputTokens": int,    # >= 0
        "outputTokens": int,   # >= 0
        "latencyMs": int,      # >= 0
        "callIndex": int,      # >= 0, 0-based monotonic per process
        "capturedAt": str,     # ISO8601 UTC
        "source": "worker" | "supervisor",
        # optional, additive:
        "totalTokens": int,    # >= 0, only present when known
    }

Every helper here is defensive: malformed input is coerced/clamped rather
than raising, EXCEPT ``build_usage_record`` validating the ``source``
literal, which is an explicit programmer-error signal (a caller passing an
unrecognized source is a bug at the call site, not untrusted external data).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

VALID_SOURCES = ("worker", "supervisor")


def _coerce_non_negative_int(value: Any) -> int:
    """Best-effort coercion of an arbitrary value to a non-negative int.

    Accepts ints, floats (truncated), and numeric strings. Anything else
    (None, non-numeric strings, NaN/inf floats, unexpected types) coerces to
    0. Negative results are clamped to 0. Never raises.
    """
    try:
        if isinstance(value, bool):
            # bool is an int subclass; treat True/False as 1/0 explicitly
            # rather than falling through to the generic int() path below
            # (which would also work, but this is clearer intent).
            return 1 if value else 0
        if isinstance(value, (int, float)):
            if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
                # NaN or +/-inf
                return 0
            coerced = int(value)
        elif isinstance(value, str):
            coerced = int(float(value.strip()))
        else:
            return 0
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, coerced)


def build_usage_record(
    *,
    model_id: Optional[str],
    input_tokens: Any,
    output_tokens: Any,
    latency_ms: Any,
    call_index: Any,
    source: str,
    captured_at: Optional[str] = None,
    total_tokens: Any = None,
) -> dict:
    """Build a validated ``UsageRecord`` dict.

    ``source`` must be one of ``VALID_SOURCES`` — raises ``ValueError``
    otherwise (a programmer error at the call site, not untrusted data).
    All numeric fields are coerced/clamped to non-negative ints; ``model_id``
    defaults to ``""`` when falsy/None; ``captured_at`` defaults to the
    current UTC time in ISO8601 form when not supplied.

    ``total_tokens`` is optional and additive: included only when a
    non-None value is supplied (or successfully coerced), so callers that
    don't have a total omit the key entirely rather than writing a
    misleading ``0``.
    """
    if source not in VALID_SOURCES:
        raise ValueError(
            f"invalid usage record source {source!r}; expected one of {VALID_SOURCES}"
        )

    record: dict = {
        "modelId": model_id if isinstance(model_id, str) and model_id else "",
        "inputTokens": _coerce_non_negative_int(input_tokens),
        "outputTokens": _coerce_non_negative_int(output_tokens),
        "latencyMs": _coerce_non_negative_int(latency_ms),
        "callIndex": _coerce_non_negative_int(call_index),
        "capturedAt": captured_at or datetime.now(timezone.utc).isoformat(),
        "source": source,
    }

    if total_tokens is not None:
        record["totalTokens"] = _coerce_non_negative_int(total_tokens)

    return record


def extract_converse_usage(resp: Any) -> tuple[int, int, Optional[int]]:
    """Extract ``(inputTokens, outputTokens, totalTokens)`` from a Bedrock
    Converse-shaped response.

    Defensive by contract: any non-conforming shape (None, wrong type,
    missing/partial ``usage`` block) returns ``(0, 0, None)`` rather than
    raising. ``totalTokens`` is ``None`` when absent so callers can tell
    "known zero" apart from "not reported".
    """
    try:
        if not isinstance(resp, dict):
            return (0, 0, None)
        usage = resp.get("usage")
        if not isinstance(usage, dict):
            return (0, 0, None)
        input_tokens = _coerce_non_negative_int(usage.get("inputTokens"))
        output_tokens = _coerce_non_negative_int(usage.get("outputTokens"))
        raw_total = usage.get("totalTokens")
        total_tokens = _coerce_non_negative_int(raw_total) if raw_total is not None else None
        return (input_tokens, output_tokens, total_tokens)
    except Exception:  # noqa: BLE001 — boundary extractor must never raise
        return (0, 0, None)


def parse_usage_array(raw: Any) -> list[dict]:
    """Sanitize an arbitrary value into a list of dict usage records.

    Boundary sanitizer used when parsing a usage array that crossed a
    process or event boundary (subprocess stdout JSON, an SQS/EventBridge
    payload). A non-list top-level value returns ``[]``. Non-dict entries
    within a list are dropped. Never raises regardless of input shape.
    """
    try:
        if not isinstance(raw, list):
            return []
        return [entry for entry in raw if isinstance(entry, dict)]
    except Exception:  # noqa: BLE001 — boundary sanitizer must never raise
        return []
