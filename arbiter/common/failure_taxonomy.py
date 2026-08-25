"""Unified failure taxonomy — the SINGLE source of truth for classifying an
arbiter failure and deciding whether it may be retried.

Why this module exists
----------------------
Before this module, retry classification was FORKED across four consumers,
each with its own hardcoded set of error strings:

* ``supervisor/circuit_breaker.py`` — a ``retryable_errors`` tuple.
* ``fabricator/transient_retry.py`` — a ``TRANSIENT_BEDROCK_ERROR_CODES``
  frozenset.
* ``stepRunner/executor.py`` — a per-node, author-supplied ``retryableErrors``
  list matched by exact class-name string, with no central authority.
* the layer-2 tool seam (governance + idempotency) — a scatter of typed
  ``LedgerError`` subclasses each carrying its own ``retryable`` bit.

A second parallel list is exactly how the layer-2 governance surface drifted
INERT once (finding 027c4a89): two independent classifications diverged. This
module removes the ability to diverge by being the ONE place that maps an error
(exception OR class-name string) to a :class:`FailureClass`, and a
:class:`FailureClass` to a :class:`RetryDisposition`.

Binding decisions encoded here
------------------------------
* 84494854 — the taxonomy carries the story's six members PLUS
  ``APPROVAL_ABSENT`` and ``INDETERMINATE``, over THREE dispositions
  (``RETRY_WITH_BACKOFF`` / ``RETRY_AFTER_HUMAN`` / ``NEVER``).
  ``INDETERMINATE`` maps to ``NEVER`` (fail-safe: never auto-re-execute an
  un-tokened side effect of unknown outcome). Consumers read a SINGLE
  disposition lookup (``disposition`` / ``is_auto_retryable`` /
  ``is_retry_forbidden_by_taxonomy`` / ``is_governance_smell_on_retry``) and
  MUST NOT branch on individual members.
* 843a959e — the taxonomy is AUTHORITATIVE over a stored workflow's per-node
  ``retryableErrors``. A definition may only NARROW retries (opt OUT of an
  otherwise-auto-retryable class), never WIDEN a never-retry class. See
  :func:`is_retry_forbidden_by_taxonomy`.
* 5ac980e0 — this module adds NO backoff math. The canonical full-jitter
  ``calculate_backoff`` stays in ``stepRunner/retry.py``; the three verbatim
  copies are intentionally NOT deduplicated here (a parity test asserts they
  stay numerically equivalent).

Packaging note (verified, not inferred)
----------------------------------------
Every consumer Lambda mounts the shared ``ArbiterCatalogLayer`` (staging
``common``/``governance``/``catalog`` at ``/opt/python``): supervisor, worker,
fabricator, and stepRunner all list ``layers: [catalogLayer]`` in
``backend/lib/arbiter-stack.ts``. So ``from common.failure_taxonomy import ...``
resolves in every deployed bundle (and under pytest via ``arbiter/conftest.py``,
which appends the arbiter root to ``sys.path``). The taxonomy and its
never-retry guard are themselves fail-closed controls, so this mount is
load-bearing. The remaining gap is importability TEST coverage for three of the
four bundles, filed separately as a finding — NOT an unverified layer mount.

All functions here are pure (no side effects, no AWS calls).
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class FailureClass(str, Enum):
    """The exhaustive set of failure classes an arbiter failure maps to.

    ``str`` mixin per repo convention so a member compares/serialises as its
    value across module-identity boundaries.
    """

    TRANSIENT = "transient"
    THROTTLE = "throttle"
    TIMEOUT = "timeout"
    VALIDATION = "validation"
    POLICY_DENIED = "policy-denied"  # a settled governance DENY
    AUTHZ = "authz"
    APPROVAL_ABSENT = "approval-absent"  # human-grantable; retry only after a human acts
    INDETERMINATE = "indeterminate"  # un-tokened side effect, unknown outcome — fail-safe
    UNKNOWN = "unknown"  # unrecognised — fail-safe default for the AUTO path


class RetryDisposition(str, Enum):
    """What a :class:`FailureClass` permits. Read via :func:`disposition`."""

    RETRY_WITH_BACKOFF = "retry_with_backoff"  # auto, full jitter
    RETRY_AFTER_HUMAN = "retry_after_human"  # NOT auto; a human action unblocks it
    NEVER = "never"


# The one class -> disposition matrix. ``UNKNOWN`` is NEVER for the automatic
# retry path (a novel error must not be auto-retried); the executor's
# author-list path treats UNKNOWN specially (see is_retry_forbidden_by_taxonomy).
DISPOSITION: dict[FailureClass, RetryDisposition] = {
    FailureClass.TRANSIENT: RetryDisposition.RETRY_WITH_BACKOFF,
    FailureClass.THROTTLE: RetryDisposition.RETRY_WITH_BACKOFF,
    FailureClass.TIMEOUT: RetryDisposition.RETRY_WITH_BACKOFF,
    FailureClass.VALIDATION: RetryDisposition.NEVER,
    FailureClass.POLICY_DENIED: RetryDisposition.NEVER,
    FailureClass.AUTHZ: RetryDisposition.NEVER,
    FailureClass.APPROVAL_ABSENT: RetryDisposition.RETRY_AFTER_HUMAN,
    FailureClass.INDETERMINATE: RetryDisposition.NEVER,
    FailureClass.UNKNOWN: RetryDisposition.NEVER,
}

# Public token a governance DENY is recorded/classified under. A policy DENY
# does not raise a typed exception (it COMPLETES the node with a deny error
# ToolResult), so when a DENY class does reach a retry decision — e.g. a stale
# per-node retryableErrors listing it, or a duplicate delivery — it is
# identified by this stable string.
POLICY_DENIED_CLASS = "GovernanceDenied"

# The ONE source of truth mapping an error class-name / Bedrock error code to a
# FailureClass. Keys are the canonical (CamelCase) forms; a case-insensitive
# fallback index (built below) also matches Bedrock's mid-stream camelCase
# variants (e.g. ``throttlingException``, ``modelStreamErrorException``).
#
# Deliberately ABSENT (classify -> UNKNOWN, so the per-node retryableErrors list
# still governs, and the AUTO path never auto-retries):
#   * ``ToolExecutionError`` / ``AgentExecutionError`` — a bare tool/agent CRASH
#     is a DETERMINATE node failure that retry.py MAY retry per the node's
#     policy; it is not a governance class, so the taxonomy holds no veto.
#   * ``RecordedToolFailure`` — a memoized replay of a prior terminal failure;
#     it never reaches a FRESH node-retry decision.
#   * ``tool_error_result`` — a tool-RETURNED domain error; the node COMPLETES,
#     so it never reaches the node-retry decision at all.
_CLASSNAME_TO_CLASS: dict[str, FailureClass] = {
    # --- Bedrock request-level + mid-stream fault codes ---------------------
    "ThrottlingException": FailureClass.THROTTLE,
    "ServiceUnavailableException": FailureClass.TRANSIENT,
    "InternalServerException": FailureClass.TRANSIENT,
    "ModelStreamErrorException": FailureClass.TRANSIENT,
    "ModelTimeoutException": FailureClass.TIMEOUT,
    "ValidationException": FailureClass.VALIDATION,
    "AccessDeniedException": FailureClass.AUTHZ,
    # --- governance approval gate (tool_approval.py) ------------------------
    # ABSENT approval is human-grantable — distinct from a settled DENY.
    "ApprovalRequiredError": FailureClass.APPROVAL_ABSENT,
    "ApprovalReadError": FailureClass.TRANSIENT,  # infra: transport blip may recover
    # --- governance / tool-execution ledger hierarchy ----------------------
    "LedgerError": FailureClass.TRANSIENT,  # base infra refusal — fail-closed, retryable
    "LedgerWriteError": FailureClass.TRANSIENT,  # audit write fail-closed — infra
    "RetryableNoExecutionError": FailureClass.TRANSIENT,  # concurrent loser, no side effect
    "OutcomeIndeterminateError": FailureClass.INDETERMINATE,  # unknown outcome — fail-safe
    # Designed exactly-once carve-out: a stale re-dispatched-away worker,
    # refused at the reserve fence BEFORE any side effect. Terminal for THIS
    # worker (its generation can never become current again). Never re-execute.
    "StaleWorkerFencedError": FailureClass.INDETERMINATE,
    # Confused-deputy cross-org resultRef pointer — an authorization failure.
    "CrossOrgResultRefError": FailureClass.AUTHZ,
    # --- governance DENY (deny-list) ----------------------------------------
    POLICY_DENIED_CLASS: FailureClass.POLICY_DENIED,
}

# Case-insensitive fallback index. Includes every canonical class-name AND the
# enum value strings themselves (so classify("policy-denied") == POLICY_DENIED).
_LOWER_INDEX: dict[str, FailureClass] = {
    name.lower(): fc for name, fc in _CLASSNAME_TO_CLASS.items()
}
_LOWER_INDEX.update({fc.value.lower(): fc for fc in FailureClass})


def _extract_code(err: Any) -> str | None:
    """Derive the classification key from an exception OR a bare string.

    An exception is normalised to its botocore ``response['Error']['Code']``
    when present (Bedrock/ClientError/EventStreamError), else ``type().__name__``
    — the SAME derivation the circuit breaker used, so an exception on the
    breaker path and an ``errorClass`` string on the node path classify
    identically (cross-runtime parity).
    """
    if err is None:
        return None
    if isinstance(err, str):
        return err or None
    response = getattr(err, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict):
            code = error.get("Code")
            if code:
                return str(code)
    return type(err).__name__


def classify(err: Any) -> FailureClass:
    """Classify an exception OR a class-name/error-code string.

    Unrecognised input classifies to :attr:`FailureClass.UNKNOWN` (fail-safe:
    the AUTO retry path never auto-retries it). Case-insensitive so Bedrock's
    mid-stream camelCase codes classify the same as request-level CamelCase.
    """
    code = _extract_code(err)
    if not code:
        return FailureClass.UNKNOWN
    fc = _CLASSNAME_TO_CLASS.get(code)
    if fc is not None:
        return fc
    return _LOWER_INDEX.get(code.lower(), FailureClass.UNKNOWN)


def disposition(fc: FailureClass) -> RetryDisposition:
    """The single disposition lookup. Unknown members fail safe to NEVER."""
    return DISPOSITION.get(fc, RetryDisposition.NEVER)


def is_auto_retryable(fc: FailureClass) -> bool:
    """True iff the class may be retried AUTOMATICALLY (with full-jitter
    backoff). The circuit breaker and the transient-retry helper gate on this.
    ``UNKNOWN`` -> False (fail-safe)."""
    return disposition(fc) is RetryDisposition.RETRY_WITH_BACKOFF


def is_retry_forbidden_by_taxonomy(err: Any) -> bool:
    """Authoritative veto for the per-node ``retryableErrors`` path (843a959e).

    True iff ``err`` classifies to a RECOGNISED failure class whose disposition
    is NOT ``RETRY_WITH_BACKOFF`` (validation / policy-denied / authz /
    indeterminate / approval-absent). An UNRECOGNISED error (``UNKNOWN``)
    returns False: the taxonomy holds no opinion, so the author's per-node list
    still governs. This is precisely "narrow-only" — a stored definition can
    never WIDEN a recognised never-retry class into a retry, but may still
    configure retries for error strings the taxonomy does not classify (and may
    still opt OUT of an auto-retryable class by omitting it from the list).
    """
    fc = classify(err)
    if fc is FailureClass.UNKNOWN:
        return False
    return disposition(fc) is not RetryDisposition.RETRY_WITH_BACKOFF


def is_governance_smell_on_retry(fc: FailureClass) -> bool:
    """True iff reaching a RETRY decision for this class is a governance smell
    — i.e. something asked to retry a SETTLED denial. Only ``POLICY_DENIED`` and
    ``AUTHZ`` qualify: an absent approval (human-grantable) and an indeterminate
    outcome (fail-safe) are legitimate non-retry reasons, not smells, and a
    validation error is an author mistake, not a governance breach.
    """
    return fc in (FailureClass.POLICY_DENIED, FailureClass.AUTHZ)
