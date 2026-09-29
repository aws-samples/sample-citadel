"""Tests for arbiter/governance/record_approval.py.

Covers the pure record-approval resolution + decision matrix used by the
dispatch-time approval gate (CIT-041). Full matrix: status x mode x
created_at (before/after/None relative to effective_at), plus hypothesis
properties per the design's Decision 6.
"""
from __future__ import annotations

import os
import sys

import pytest
from hypothesis import given, strategies as st

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.record_approval import (  # noqa: E402
    ApprovalStatus,
    ApprovalResolution,
    ApprovalDecision,
    RecordNotApprovedError,
    ApprovalStatusReadError,
    resolve_record_approval,
    decide,
    REGISTRY_STATUS_FIELD,
    CREATED_AT_FIELD,
)

MODES = ("permissive", "shadow", "strict")
BEFORE = "2026-01-01T00:00:00.000Z"
CUTOFF = "2026-06-01T00:00:00.000Z"
AFTER = "2026-12-01T00:00:00.000Z"


# ---------------------------------------------------------------------------
# resolve_record_approval
# ---------------------------------------------------------------------------


def test_resolve_none_item_is_unknown_record():
    result = resolve_record_approval(None)
    assert result.status == ApprovalStatus.UNKNOWN_RECORD


def test_resolve_missing_field_is_missing_status():
    result = resolve_record_approval({CREATED_AT_FIELD: BEFORE})
    assert result.status == ApprovalStatus.MISSING_STATUS
    assert result.created_at == BEFORE


def test_resolve_missing_field_and_missing_created_at():
    result = resolve_record_approval({})
    assert result.status == ApprovalStatus.MISSING_STATUS
    assert result.created_at is None


def test_resolve_approved():
    result = resolve_record_approval(
        {REGISTRY_STATUS_FIELD: "APPROVED", CREATED_AT_FIELD: BEFORE}
    )
    assert result.status == ApprovalStatus.APPROVED
    assert result.registry_status == "APPROVED"


@pytest.mark.parametrize(
    "raw_status", ["DRAFT", "PENDING_APPROVAL", "REJECTED", "DEPRECATED", "SOMETHING_ELSE"]
)
def test_resolve_not_approved_explicit_statuses(raw_status):
    result = resolve_record_approval({REGISTRY_STATUS_FIELD: raw_status})
    assert result.status == ApprovalStatus.NOT_APPROVED
    assert result.registry_status == raw_status


def test_resolve_created_at_non_string_treated_as_absent():
    result = resolve_record_approval({CREATED_AT_FIELD: 12345})
    assert result.created_at is None


def test_resolve_created_at_empty_string_treated_as_absent():
    result = resolve_record_approval({CREATED_AT_FIELD: ""})
    assert result.created_at is None


def test_resolve_never_raises_on_malformed_item():
    # Non-dict-like access is guarded — pass a dict missing all fields.
    result = resolve_record_approval({"unrelated": "value"})
    assert result.status == ApprovalStatus.MISSING_STATUS


# ---------------------------------------------------------------------------
# decide — full matrix: status x mode
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["permissive", "shadow"])
def test_permissive_shadow_never_refuse_approved(mode):
    resolution = ApprovalResolution(status=ApprovalStatus.APPROVED)
    result = decide(resolution, mode, None)
    assert result.refused is False
    assert result.would_block is False


@pytest.mark.parametrize("mode", ["permissive", "shadow"])
@pytest.mark.parametrize(
    "status",
    [
        ApprovalStatus.NOT_APPROVED,
        ApprovalStatus.MISSING_STATUS,
        ApprovalStatus.UNKNOWN_RECORD,
        ApprovalStatus.LOOKUP_FAILED,
    ],
)
def test_permissive_shadow_never_refuse_non_approved(mode, status):
    resolution = ApprovalResolution(status=status, registry_status="DRAFT")
    result = decide(resolution, mode, None)
    assert result.refused is False
    assert result.would_block is True


def test_strict_approved_proceeds():
    resolution = ApprovalResolution(status=ApprovalStatus.APPROVED)
    result = decide(resolution, "strict", None)
    assert result.refused is False
    assert result.reason is None
    assert result.failure_class is None
    assert result.would_block is False


@pytest.mark.parametrize(
    "raw_status", ["DRAFT", "PENDING_APPROVAL", "REJECTED", "DEPRECATED"]
)
def test_strict_not_approved_refuses_regardless_of_created_at(raw_status):
    for created_at in (BEFORE, AFTER, None):
        resolution = ApprovalResolution(
            status=ApprovalStatus.NOT_APPROVED,
            registry_status=raw_status,
            created_at=created_at,
        )
        result = decide(resolution, "strict", CUTOFF)
        assert result.refused is True
        assert result.reason == f"approval_absent:{raw_status}"
        assert result.failure_class == "APPROVAL_ABSENT"
        assert result.would_block is True


def test_strict_missing_status_created_at_before_cutoff_is_grandfathered():
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=BEFORE)
    result = decide(resolution, "strict", CUTOFF)
    assert result.refused is False
    assert result.would_block is True


def test_strict_missing_status_created_at_after_cutoff_refused():
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=AFTER)
    result = decide(resolution, "strict", CUTOFF)
    assert result.refused is True
    assert result.reason == "approval_absent_missing_status"
    assert result.failure_class == "APPROVAL_ABSENT"


def test_strict_missing_status_created_at_equal_cutoff_refused():
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=CUTOFF)
    result = decide(resolution, "strict", CUTOFF)
    assert result.refused is True
    assert result.reason == "approval_absent_missing_status"


def test_strict_missing_status_created_at_none_refused_even_with_effective_at():
    # Fail-closed: absent created_at must NOT fall back to
    # is_grandfathered_pure's malformed-input bypass branch.
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=None)
    result = decide(resolution, "strict", CUTOFF)
    assert result.refused is True
    assert result.reason == "approval_absent_missing_status"
    assert result.failure_class == "APPROVAL_ABSENT"


def test_strict_missing_status_created_at_none_refused_even_with_no_cutoff():
    # Also refused when effective_at itself is None (no cutoff set) —
    # created_at absence is refused independent of the cutoff's presence.
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=None)
    result = decide(resolution, "strict", None)
    assert result.refused is True
    assert result.reason == "approval_absent_missing_status"


def test_strict_missing_status_no_cutoff_set_with_created_at_is_grandfathered():
    # effective_at is None (pre-shadow-flip): is_grandfathered_pure(created_at, None) -> True.
    resolution = ApprovalResolution(status=ApprovalStatus.MISSING_STATUS, created_at=BEFORE)
    result = decide(resolution, "strict", None)
    assert result.refused is False


def test_strict_unknown_record_refused_regardless_of_created_at():
    for created_at in (BEFORE, AFTER, None):
        resolution = ApprovalResolution(status=ApprovalStatus.UNKNOWN_RECORD, created_at=created_at)
        result = decide(resolution, "strict", CUTOFF)
        assert result.refused is True
        assert result.reason == "approval_record_unknown"
        assert result.failure_class == "APPROVAL_ABSENT"
        assert result.would_block is True


def test_strict_lookup_failed_refused_regardless_of_created_at():
    for created_at in (BEFORE, AFTER, None):
        resolution = ApprovalResolution(status=ApprovalStatus.LOOKUP_FAILED, created_at=created_at)
        result = decide(resolution, "strict", CUTOFF)
        assert result.refused is True
        assert result.reason == "approval_lookup_failed"
        assert result.failure_class == "TRANSIENT"
        assert result.would_block is True


# ---------------------------------------------------------------------------
# decide never raises
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "status",
    [
        ApprovalStatus.APPROVED,
        ApprovalStatus.NOT_APPROVED,
        ApprovalStatus.MISSING_STATUS,
        ApprovalStatus.UNKNOWN_RECORD,
        ApprovalStatus.LOOKUP_FAILED,
    ],
)
def test_decide_never_raises(mode, status):
    resolution = ApprovalResolution(status=status, registry_status="DRAFT", created_at=None)
    # Should not raise for any combination.
    decide(resolution, mode, None)
    decide(resolution, mode, CUTOFF)


# ---------------------------------------------------------------------------
# Hypothesis properties (design Decision 6)
# ---------------------------------------------------------------------------

_status_strategy = st.sampled_from(list(ApprovalStatus))
_registry_status_strategy = st.one_of(
    st.none(), st.sampled_from(["DRAFT", "PENDING_APPROVAL", "REJECTED", "DEPRECATED", "APPROVED"])
)
_created_at_strategy = st.one_of(st.none(), st.sampled_from([BEFORE, CUTOFF, AFTER]))
_effective_at_strategy = st.one_of(st.none(), st.just(CUTOFF))


@given(effective_at=_effective_at_strategy, created_at=_created_at_strategy)
def test_property_strict_approved_always_proceeds(effective_at, created_at):
    resolution = ApprovalResolution(
        status=ApprovalStatus.APPROVED, registry_status="APPROVED", created_at=created_at,
    )
    result = decide(resolution, "strict", effective_at)
    assert result.refused is False
    assert result.would_block is False


@given(
    mode=st.sampled_from(["permissive", "shadow"]),
    status=_status_strategy,
    registry_status=_registry_status_strategy,
    created_at=_created_at_strategy,
    effective_at=_effective_at_strategy,
)
def test_property_shadow_permissive_never_refuse(mode, status, registry_status, created_at, effective_at):
    resolution = ApprovalResolution(
        status=status, registry_status=registry_status, created_at=created_at,
    )
    result = decide(resolution, mode, effective_at)
    assert result.refused is False


@given(created_at=_created_at_strategy, effective_at=_effective_at_strategy)
def test_property_lookup_failed_never_grandfathered(created_at, effective_at):
    resolution = ApprovalResolution(status=ApprovalStatus.LOOKUP_FAILED, created_at=created_at)
    result = decide(resolution, "strict", effective_at)
    assert result.refused is True
    assert result.failure_class == "TRANSIENT"


@given(created_at=_created_at_strategy, effective_at=_effective_at_strategy)
def test_property_unknown_record_never_grandfathered(created_at, effective_at):
    resolution = ApprovalResolution(status=ApprovalStatus.UNKNOWN_RECORD, created_at=created_at)
    result = decide(resolution, "strict", effective_at)
    assert result.refused is True
    assert result.failure_class == "APPROVAL_ABSENT"


@given(
    registry_status=st.sampled_from(["DRAFT", "PENDING_APPROVAL", "REJECTED", "DEPRECATED"]),
    created_at=_created_at_strategy,
    effective_at=_effective_at_strategy,
)
def test_property_not_approved_never_grandfathered(registry_status, created_at, effective_at):
    resolution = ApprovalResolution(
        status=ApprovalStatus.NOT_APPROVED, registry_status=registry_status, created_at=created_at,
    )
    result = decide(resolution, "strict", effective_at)
    assert result.refused is True
    assert result.failure_class == "APPROVAL_ABSENT"


# ---------------------------------------------------------------------------
# Failure-taxonomy classification wiring
# ---------------------------------------------------------------------------


def test_record_not_approved_error_classifies_as_approval_absent():
    from arbiter.common.failure_taxonomy import classify, FailureClass

    assert classify(RecordNotApprovedError.__name__) == FailureClass.APPROVAL_ABSENT
    assert classify(RecordNotApprovedError("x")) == FailureClass.APPROVAL_ABSENT


def test_approval_status_read_error_classifies_as_transient():
    from arbiter.common.failure_taxonomy import classify, FailureClass

    assert classify(ApprovalStatusReadError.__name__) == FailureClass.TRANSIENT
    assert classify(ApprovalStatusReadError("x")) == FailureClass.TRANSIENT
