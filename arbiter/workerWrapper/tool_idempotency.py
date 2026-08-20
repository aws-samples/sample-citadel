"""Pure canonical args-hash + idempotency-key derivation (PR1 of 2).

This module is the deterministic, I/O-free core of tool-call idempotency. It
produces a stable ``argsHash`` from a tool's input and derives the ledger key
``(orgId#executionId, nodeId#callIndex#toolName#argsHash)`` used by
``arbiter/governance/tool_execution_ledger.py``.

Guarantee scope (read this precisely — the honest framing per the security
consensus, do NOT collapse it to a bare "exactly-once"):

* The key is **attempt-scoped**: ``callIndex`` is a per-handler-instance
  monotonic counter (one handler instance == one subprocess == one node
  attempt) and ``argsHash`` derives from the exact tool input the model
  produced on *this* attempt. Two byte-identical (post-canonicalization)
  re-issues of the same logical call within one attempt collapse to the same
  key → exactly-once within an attempt, plus reservation-race safety.
* It does **NOT** provide exactly-once across nondeterministic re-dispatch
  (a watchdog re-dispatch runs a fresh LLM body whose calls may reorder or
  reword → different keys). Closing that requires the worker
  ``dispatchGeneration`` fence, which is **deferred to PR2** and is REQUIRED
  for the complete guarantee. Nothing here should be read as the complete
  guarantee.

Why not just ``json.dumps(sort_keys=True)``? Two flagged determinism traps
that raw ``dumps`` gets wrong (both are property-tested):

1. **Non-string dict keys.** ``json.dumps(..., sort_keys=True)`` raises
   ``TypeError`` on mixed-type keys (``'<' not supported between 'str' and
   'int'``) and silently coerces ``int`` keys to strings otherwise —
   producing ``{1: 2}`` and ``{"1": 2}`` as the *same* text (a collision).
   We reject non-string keys deterministically (raise
   :class:`CanonicalizationError`) rather than silently collide; model-
   produced tool JSON always has string keys, so this fails loudly only on
   the pathological case.
2. **Integral-float / -0.0 collapse.** ``1`` vs ``1.0`` vs ``1e0`` dump to
   different text, and ``-0.0`` vs ``0.0`` differ — so semantically-equal
   numbers would hash differently. We normalize integral floats to ``int``
   (``2.0 -> 2``, ``-0.0 -> 0``) so they hash equal, and reject non-finite
   (``NaN``/``Infinity``). ``null`` is preserved (``{"a": null}`` never
   equals ``{}``), unlike the ledger *serializer* which strips ``None`` for
   storage — that is a storage concern, not a hash-input concern.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

__all__ = [
    "CanonicalizationError",
    "BypassMisflagError",
    "canonicalize",
    "args_hash",
    "build_partition_key",
    "build_sort_key",
    "build_key",
    "classify_idempotency_mode",
    "detect_write_verbs",
    "check_bypass_classification",
    "MODE_LEDGER",
    "MODE_BYPASS",
]


class CanonicalizationError(ValueError):
    """Raised when a tool input cannot be canonicalized deterministically.

    The two deterministic-failure cases are a non-string dict key and a
    non-finite number (``NaN``/``Infinity``). Callers MUST treat this as a
    fail-closed condition for a side-effecting tool: a call whose key cannot
    be derived cannot be deduplicated, so it must not be executed
    unprotected.
    """


def _normalize(obj: Any) -> Any:
    """Recursively normalize a JSON-ish value to a canonical form.

    * ``dict`` — keys MUST be strings (reject otherwise); values normalized
      recursively; ``None`` values preserved (``null`` != missing).
    * ``float`` — reject ``NaN``/``Infinity``; integral floats (incl.
      ``-0.0``) collapse to ``int`` so ``2.0`` and ``2`` hash equal.
    * ``bool`` — preserved as-is (checked before ``int`` since ``bool`` is an
      ``int`` subclass; ``True`` must not become ``1``).
    * ``int`` / ``str`` / ``None`` — as-is.
    * ``list`` / ``tuple`` — normalized element-wise (tuple -> list).
    * anything else — coerced to ``str`` deterministically (defensive; model
      tool input is plain JSON, so this is a rare fallback).
    """
    if obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, bool):  # bool BEFORE int (bool is a subclass of int)
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            raise CanonicalizationError(
                f"non-finite number is not canonicalizable: {obj!r}"
            )
        # Integral floats (including -0.0) collapse to int so 2.0 == 2 and
        # -0.0 == 0 at the hash layer. is_integer() is True for -0.0.
        if obj.is_integer():
            return int(obj)
        return obj
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for key, value in obj.items():
            if not isinstance(key, str):
                raise CanonicalizationError(
                    f"non-string dict key is not canonicalizable: {key!r} "
                    f"(type {type(key).__name__}); coerce keys to str upstream"
                )
            out[key] = _normalize(value)
        return out
    if isinstance(obj, (list, tuple)):
        return [_normalize(v) for v in obj]
    # Defensive coercion for a non-JSON scalar (Decimal, datetime, set, ...).
    return str(obj)


def canonicalize(tool_input: Any) -> str:
    """Return the deterministic canonical JSON string for a tool input.

    Pure and total except for the two deterministic rejections documented on
    :class:`CanonicalizationError` (non-string dict key, non-finite number).
    After normalization every dict key is a string, so ``sort_keys=True``
    cannot raise; integral floats are ints, so ``1``/``1.0`` serialize
    identically.
    """
    normalized = _normalize(tool_input)
    return json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def args_hash(tool_input: Any) -> str:
    """Return the SHA-256 hex digest of the canonicalized tool input."""
    canonical = canonicalize(tool_input)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_partition_key(org_id: str, execution_id: str) -> str:
    """Ledger partition key: ``orgId#executionId``.

    ``orgId`` is prefixed for structural cross-org isolation — a key minted
    for org A can never collide with or read org B's rows. ``orgId`` MUST be
    resolved server-side (execution row / trusted env), never from a
    subprocess-supplied payload. ``executionId`` alone is globally unique, so
    correctness holds even when ``orgId`` is an empty/sentinel string.
    """
    return f"{org_id}#{execution_id}"


def build_sort_key(node_id: str, call_index: int, tool_name: str, hash_hex: str) -> str:
    """Ledger sort key: ``nodeId#callIndex#toolName#argsHash``.

    ``toolName`` and ``argsHash`` are included even though
    ``(executionId, nodeId, callIndex)`` is already unique within one attempt:
    they keep the key stable and *verifiable* across attempts — a replayed
    call with the same ``callIndex`` but a different tool/args yields a
    different key and is correctly treated as a different call, never wrongly
    absorbed. Dispatch generation is deliberately NOT in the key (that would
    mint a fresh key on every re-dispatch and guarantee duplicates — the
    opposite of the goal); cross-dispatch closure is PR2's worker fence.
    """
    return f"{node_id}#{call_index}#{tool_name}#{hash_hex}"


def build_key(
    org_id: str,
    execution_id: str,
    node_id: str,
    call_index: int,
    tool_name: str,
    tool_input: Any,
) -> tuple[str, str]:
    """Derive the ``(partitionKey, sortKey)`` ledger key for a tool call."""
    hash_hex = args_hash(tool_input)
    return (
        build_partition_key(org_id, execution_id),
        build_sort_key(node_id, call_index, tool_name, hash_hex),
    )


# ---------------------------------------------------------------------------
# Bypass classification (read-only tools skip the ledger)
# ---------------------------------------------------------------------------

MODE_LEDGER = "ledger"
MODE_BYPASS = "bypass"


def classify_idempotency_mode(tool_config: Any) -> str:
    """Resolve a tool's idempotency mode from its per-tool config.

    **Fail-safe default = ``ledger`` (treat as side-effecting).** The
    dangerous direction — a side-effecting tool silently unprotected —
    requires an *explicit* ``mode: "bypass"`` flag, never a mere omission,
    a malformed config, or an unrecognized value. Anything that is not
    exactly the string ``"bypass"`` resolves to ``ledger``.

    Config shape (per-tool item, loaded by ``fabricator/tools_config.py``)::

        {"idempotency": {"mode": "ledger" | "bypass", ...}}
    """
    if not isinstance(tool_config, dict):
        return MODE_LEDGER
    idem = tool_config.get("idempotency")
    if not isinstance(idem, dict):
        return MODE_LEDGER
    mode = idem.get("mode")
    if mode == MODE_BYPASS:
        return MODE_BYPASS
    # Absent / None / malformed / any unrecognized value -> fail-safe ledger.
    return MODE_LEDGER


class BypassMisflagError(Exception):
    """Raised when a ``bypass``-flagged tool looks demonstrably side-effecting.

    Security linkage (consensus condition C1): a ``bypass`` tool writes no
    ledger row, so it also never reaches the reserve step — meaning a
    mis-flagged side-effecting tool loses BOTH dedupe AND (in PR2) the
    dispatch-generation fence at once (double jeopardy). A ``warn`` is too
    weak for a control whose failure silently removes protection, so in
    ``strict`` enforcement mode this BLOCKS (raises); in other modes the
    caller should WARN and record a governance signal, never swallow.
    """


# Write-verb heuristic: substrings that strongly imply a mutating operation.
# Deliberately broad (over-blocking a bypass mis-flag is the safe direction);
# matched case-insensitively against the tool's source/binding code. This is
# a heuristic, NOT a soundness boundary — a determined author can hide a write
# behind indirection; the real control is the fail-safe default plus this gate.
_WRITE_VERB_TOKENS = (
    "put_item", "update_item", "delete_item", "batch_write", "transact_write",
    "put_object", "delete_object", "putcommand", "updatecommand", "deletecommand",
    "createticket", "create_ticket", "create(", "update(", "delete(", "insert(",
    "post(", "put(", "patch(", "send_message", "sendmessage", "publish(",
    "requests.post", "requests.put", "requests.patch", "requests.delete",
    ".create_", ".update_", ".delete_", ".write(", "execute(", "commit(",
)


def detect_write_verbs(tool_code: Any) -> list[str]:
    """Return the write-verb tokens found in ``tool_code`` (case-insensitive).

    Empty list when ``tool_code`` is not a non-empty string or contains no
    recognized mutating token. Pure and total — never raises.
    """
    if not isinstance(tool_code, str) or not tool_code:
        return []
    lowered = tool_code.lower()
    return [tok for tok in _WRITE_VERB_TOKENS if tok in lowered]


def check_bypass_classification(
    tool_config: Any,
    tool_code: Any,
    *,
    enforcement_mode: str,
) -> list[str]:
    """Guard a ``bypass`` classification against a demonstrably-writing tool.

    Returns the list of detected write-verb tokens (empty = clean). For a
    ``ledger``-classified tool this is always a clean no-op (empty list) —
    the guard only scrutinizes ``bypass`` claims.

    In ``strict`` ``enforcement_mode`` a non-empty detection RAISES
    :class:`BypassMisflagError` (blocks activation, consensus condition C1).
    In any other mode the detection is returned for the caller to WARN and
    record — never silently dropped.
    """
    if classify_idempotency_mode(tool_config) != MODE_BYPASS:
        return []
    hits = detect_write_verbs(tool_code)
    if hits and enforcement_mode == "strict":
        raise BypassMisflagError(
            "tool is flagged idempotency.mode='bypass' but its code contains "
            f"write verbs {hits!r}; blocked in strict enforcement mode "
            "(a bypass tool skips the ledger and, in PR2, the dispatch fence)"
        )
    return hits
