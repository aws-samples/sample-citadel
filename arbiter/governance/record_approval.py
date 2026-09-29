"""Dispatch-time record-approval gate (CIT-041) — pure resolver + decide.

Sibling of ``release_resolution.py`` / ``grandfathering.py``: a pure
resolution function that reads an already-fetched citadel-agents cache
item, and a pure ``decide`` function that applies the enforcement-mode
matrix. All I/O (GetItem, exception construction on a failed read) is
isolated in the per-consumer adapters (supervisor / stepRunner / worker),
mirroring how ``resolve_release`` keeps ``is_grandfathered_pure`` pure.

Field names read from the cache item are sourced as module constants
matching ``backend/src/lambda/approval-cache-fields.ts`` (the shared
TS/Python field-name contract) — never hardcoded inline, so a rename on
either side surfaces as a constant mismatch, not a silent field-name skew.

Four-way (not boolean) :class:`ApprovalStatus`, because the decide matrix's
strict-mode doctrine depends on distinguishing "cleanly not approved" from
"the record is entirely unknown" from "the lookup itself failed" — same
three/four-way-status doctrine as ``ReleaseResolutionStatus``.

Grandfathering interaction (deliberate divergence from the release gate):
grandfathering excuses ABSENCE of signal (MISSING_STATUS) for a record that
predates the cutoff, never a POSITIVE non-approved signal (explicit
NOT_APPROVED) and never UNKNOWN_RECORD/LOOKUP_FAILED. MISSING_STATUS with
an absent ``created_at`` is treated as fail-closed (refused) in strict
mode — this deliberately does NOT reuse the release gate's
``created_at=None`` -> always-grandfather convention, because approval has
a real per-record ``createdAt`` signal (unlike the release gate, which has
none), so an absent value here is a data gap, not "no signal was ever
possible" (design consensus-reviewer Change 3 / consensus-architect
Change B).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from .grandfathering import is_grandfathered_pure

# Field names on the citadel-agents cache item, matching the shared
# constant module ``backend/src/lambda/approval-cache-fields.ts``. Sourced
# as named constants (never inline string literals) so a rename on the TS
# producer side is a one-place Python change, not a silent skew.
REGISTRY_STATUS_FIELD = "registryStatus"
CREATED_AT_FIELD = "createdAt"

APPROVED_STATUS_VALUE = "APPROVED"


class ApprovalStatus(str, Enum):
    APPROVED = "approved"
    NOT_APPROVED = "not_approved"
    MISSING_STATUS = "missing_status"
    UNKNOWN_RECORD = "unknown_record"
    LOOKUP_FAILED = "lookup_failed"


@dataclass
class ApprovalResolution:
    status: ApprovalStatus
    registry_status: str | None = None  # raw value, present when NOT_APPROVED
    created_at: str | None = None  # from the cache item, feeds grandfathering
    detail: str | None = None


def resolve_record_approval(cache_item: dict | None) -> ApprovalResolution:
    """Pure resolution of a cache item to an :class:`ApprovalResolution`.

    Never raises and performs no I/O. ``cache_item`` is an already-fetched
    citadel-agents row (or ``None`` if the GetItem returned no ``Item``).
    ``LOOKUP_FAILED`` is NEVER produced here — it is constructed by the
    calling adapter when its own GetItem raises (mirrors
    ``resolve_release``'s exception-to-status boundary).
    """
    if cache_item is None:
        return ApprovalResolution(status=ApprovalStatus.UNKNOWN_RECORD)

    created_at = cache_item.get(CREATED_AT_FIELD)
    if not isinstance(created_at, str) or created_at == "":
        created_at = None

    if REGISTRY_STATUS_FIELD not in cache_item:
        return ApprovalResolution(
            status=ApprovalStatus.MISSING_STATUS,
            created_at=created_at,
        )

    registry_status = cache_item.get(REGISTRY_STATUS_FIELD)
    if registry_status == APPROVED_STATUS_VALUE:
        return ApprovalResolution(
            status=ApprovalStatus.APPROVED,
            registry_status=registry_status,
            created_at=created_at,
        )

    return ApprovalResolution(
        status=ApprovalStatus.NOT_APPROVED,
        registry_status=registry_status,
        created_at=created_at,
    )


@dataclass
class ApprovalDecision:
    refused: bool
    reason: str | None
    failure_class: str | None
    would_block: bool


class RecordNotApprovedError(Exception):
    """Raised by a defence-in-depth adapter (worker second layer) when a
    dispatch target's record-approval status resolves to a refused
    decision in strict mode. The class NAME is the classification key
    ``failure_taxonomy`` maps to ``FailureClass.APPROVAL_ABSENT`` —
    human-grantable, distinct from a settled DENY.
    """


class ApprovalStatusReadError(Exception):
    """Raised by an adapter when its own GetItem against the citadel-agents
    table raises. The class NAME is the classification key
    ``failure_taxonomy`` maps to ``FailureClass.TRANSIENT`` — an infra blip
    that may recover, never grandfathered (assert-or-refuse doctrine).
    """


def decide(
    resolution: ApprovalResolution,
    enforcement_mode: str,
    effective_at: str | None,
) -> ApprovalDecision:
    """Apply the enforcement-mode decision matrix to an
    :class:`ApprovalResolution`.

    permissive/shadow: never refuse. ``would_block`` is True for any
    non-APPROVED status (the shadow-rollout would-block signal).

    strict:
      - APPROVED -> proceed.
      - NOT_APPROVED -> refuse ``approval_absent:<status>``,
        APPROVAL_ABSENT. Never grandfathered — an explicit non-approved
        signal is refused regardless of age.
      - MISSING_STATUS -> grandfathered only if ``created_at`` is present
        and predates ``effective_at`` (via ``is_grandfathered_pure``);
        otherwise (including ``created_at`` absent) refuse
        ``approval_absent_missing_status``, APPROVAL_ABSENT.
      - UNKNOWN_RECORD -> refuse ``approval_record_unknown``,
        APPROVAL_ABSENT. Never grandfathered.
      - LOOKUP_FAILED -> refuse ``approval_lookup_failed``, TRANSIENT.
        Never grandfathered (assert-or-refuse doctrine).
    """
    would_block = resolution.status != ApprovalStatus.APPROVED

    if enforcement_mode != "strict":
        return ApprovalDecision(
            refused=False,
            reason=None,
            failure_class=None,
            would_block=would_block,
        )

    if resolution.status == ApprovalStatus.APPROVED:
        return ApprovalDecision(
            refused=False, reason=None, failure_class=None, would_block=False,
        )

    if resolution.status == ApprovalStatus.NOT_APPROVED:
        return ApprovalDecision(
            refused=True,
            reason=f"approval_absent:{resolution.registry_status}",
            failure_class="APPROVAL_ABSENT",
            would_block=True,
        )

    if resolution.status == ApprovalStatus.MISSING_STATUS:
        # created_at is None -> is_grandfathered_pure's malformed/absent
        # branch would return True; explicitly refuse absent created_at in
        # strict instead, per design Change 3 (do not rely on backfill
        # alone to close the fail-open hole).
        if resolution.created_at is not None and is_grandfathered_pure(
            resolution.created_at, effective_at
        ):
            return ApprovalDecision(
                refused=False, reason=None, failure_class=None, would_block=True,
            )
        return ApprovalDecision(
            refused=True,
            reason="approval_absent_missing_status",
            failure_class="APPROVAL_ABSENT",
            would_block=True,
        )

    if resolution.status == ApprovalStatus.UNKNOWN_RECORD:
        return ApprovalDecision(
            refused=True,
            reason="approval_record_unknown",
            failure_class="APPROVAL_ABSENT",
            would_block=True,
        )

    # LOOKUP_FAILED
    return ApprovalDecision(
        refused=True,
        reason="approval_lookup_failed",
        failure_class="TRANSIENT",
        would_block=True,
    )
