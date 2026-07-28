"""Minimal usage-record helper for the intake service (container-local copy).

The service layer is a SEPARATE deployable (see ``Dockerfile`` — the build
context is ``service/agent_intake_single/`` only, so ``arbiter/`` is not
available at build or runtime). This module intentionally REPLICATES the
minimal subset of the canonical schema defined in ``arbiter/common/usage.py``
rather than importing across the arbiter/service boundary.

Schema (``UsageRecord``), identical field names to the arbiter version::

    {
        "modelId": str,        # "" if unknown
        "inputTokens": int,    # >= 0
        "outputTokens": int,   # >= 0
        "latencyMs": int,      # >= 0
        "callIndex": int,      # >= 0, 0-based monotonic per process
        "capturedAt": str,     # ISO8601 UTC
        "source": "intake",
        # optional, additive:
        "bedrockRequestId": str,  # only present when known; NEVER fabricated
    }

Defensive by contract: malformed numeric input is coerced/clamped to 0
rather than raising. Usage capture must never break a conversation turn.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

SOURCE = "intake"


def _coerce_non_negative_int(value: Any) -> int:
    """Best-effort coercion of an arbitrary value to a non-negative int.

    Accepts ints, floats (truncated), and numeric strings. Anything else
    (None, non-numeric strings, NaN/inf floats, unexpected types) coerces to
    0. Negative results are clamped to 0. Never raises.
    """
    try:
        if isinstance(value, bool):
            return 1 if value else 0
        if isinstance(value, (int, float)):
            if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
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
    captured_at: Optional[str] = None,
    bedrock_request_id: Optional[str] = None,
) -> dict:
    """Build a validated ``UsageRecord`` dict with ``source="intake"``.

    All numeric fields are coerced/clamped to non-negative ints; ``model_id``
    defaults to ``""`` when falsy/None; ``captured_at`` defaults to the
    current UTC time in ISO8601 form when not supplied. Never raises.

    ``bedrock_request_id`` is optional and additive: included only when a
    non-empty string is supplied. Mirrors the arbiter schema's
    omit-when-absent contract — never fabricated.
    """
    record: dict = {
        "modelId": model_id if isinstance(model_id, str) and model_id else "",
        "inputTokens": _coerce_non_negative_int(input_tokens),
        "outputTokens": _coerce_non_negative_int(output_tokens),
        "latencyMs": _coerce_non_negative_int(latency_ms),
        "callIndex": _coerce_non_negative_int(call_index),
        "capturedAt": captured_at or datetime.now(timezone.utc).isoformat(),
        "source": SOURCE,
    }
    if isinstance(bedrock_request_id, str) and bedrock_request_id:
        record["bedrockRequestId"] = bedrock_request_id
    return record


def extract_request_id(resp: Any) -> Optional[str]:
    """Extract the Bedrock request id from a boto3 Converse-shaped response.

    Mirrors ``arbiter/common/usage.py``'s ``extract_request_id`` (this
    module is a container-local copy — see module docstring). Source per
    SDK: ``resp["ResponseMetadata"]["RequestId"]``. Defensive by contract:
    any non-conforming shape returns ``None`` rather than raising or
    fabricating a value.
    """
    try:
        if not isinstance(resp, dict):
            return None
        metadata = resp.get("ResponseMetadata")
        if not isinstance(metadata, dict):
            return None
        request_id = metadata.get("RequestId")
        return request_id if isinstance(request_id, str) and request_id else None
    except Exception:  # noqa: BLE001 — boundary extractor must never raise
        return None


def extract_converse_usage(resp: Any) -> tuple[int, int]:
    """Extract ``(inputTokens, outputTokens)`` from a Bedrock Converse-shaped
    response.

    Defensive by contract: any non-conforming shape (None, wrong type,
    missing/partial ``usage`` block) returns ``(0, 0)`` rather than raising.
    """
    try:
        if not isinstance(resp, dict):
            return (0, 0)
        usage = resp.get("usage")
        if not isinstance(usage, dict):
            return (0, 0)
        return (
            _coerce_non_negative_int(usage.get("inputTokens")),
            _coerce_non_negative_int(usage.get("outputTokens")),
        )
    except Exception:  # noqa: BLE001 — boundary extractor must never raise
        return (0, 0)


class UsageCallCounter:
    """Simple monotonic 0-based call-index counter, scoped per instantiation
    (e.g. one per module or per session), matching the arbiter convention of
    a monotonic per-process ``callIndex``.
    """

    def __init__(self) -> None:
        self._next = 0

    def next(self) -> int:
        idx = self._next
        self._next += 1
        return idx
