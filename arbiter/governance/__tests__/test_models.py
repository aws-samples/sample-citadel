"""Property + unit tests for arbiter/governance/models.py (US-ARB-001)."""
import os
import sys
import time
import uuid

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from models import (  # noqa: E402
    ArbitrationDecision,
    ConflictResolution,
    ScopeReductionReason,
    AuthorityScope,
    AuthorityUnit,
    DelegationEdge,
    CompositionContract,
    ConstitutionalLayer,
    DispatchRequest,
    GovernanceFinding,
    CaseLawEntry,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_request(
    action_type: str = "invoke_agent",
    domain: str = "payment",
    context: dict | None = None,
) -> DispatchRequest:
    return DispatchRequest(
        requesting_agent_id="arbiter",
        target_agent_id="agent-1",
        action_type=action_type,
        domain=domain,
        workflow_id="wf-1",
        agent_use_id="use-1",
        context=context or {},
    )


# ---------------------------------------------------------------------------
# Enum membership
# ---------------------------------------------------------------------------


def test_conflict_resolution_membership() -> None:
    assert {m.name for m in ConflictResolution} == {
        "HALT_AND_ESCALATE",
        "DEFAULT_DENY",
        "PRECEDENCE_RESOLUTION",
    }
    assert ConflictResolution.HALT_AND_ESCALATE.value == "halt_and_escalate"
    assert ConflictResolution.DEFAULT_DENY.value == "default_deny"
    assert ConflictResolution.PRECEDENCE_RESOLUTION.value == "precedence_resolution"


def test_arbitration_decision_membership() -> None:
    assert {m.name for m in ArbitrationDecision} == {
        "PERMIT",
        "DENY",
        "ESCALATE",
        "HALT",
    }
    assert ArbitrationDecision.PERMIT.value == "permit"
    assert ArbitrationDecision.DENY.value == "deny"
    assert ArbitrationDecision.ESCALATE.value == "escalate"
    assert ArbitrationDecision.HALT.value == "halt"


def test_scope_reduction_reason_membership() -> None:
    assert {m.name for m in ScopeReductionReason} == {
        "UNCONFIRMED_STATE",
        "DOMAIN_BOUNDARY",
        "ATTENUATION",
    }
    assert ScopeReductionReason.UNCONFIRMED_STATE.value == "unconfirmed_state"
    assert ScopeReductionReason.DOMAIN_BOUNDARY.value == "domain_boundary"
    assert ScopeReductionReason.ATTENUATION.value == "attenuation"


# ---------------------------------------------------------------------------
# AuthorityScope.covers — unit tests
# ---------------------------------------------------------------------------


def test_covers_exact_match_success() -> None:
    scope = AuthorityScope(decision_type="invoke_agent", domain="payment")
    request = _make_request(action_type="invoke_agent", domain="payment")
    assert scope.covers(request) is True


def test_covers_decision_type_wildcard() -> None:
    scope = AuthorityScope(decision_type="*", domain="payment")
    request = _make_request(action_type="execute_tool", domain="payment")
    assert scope.covers(request) is True


def test_covers_domain_wildcard() -> None:
    scope = AuthorityScope(decision_type="invoke_agent", domain="*")
    request = _make_request(action_type="invoke_agent", domain="fraud")
    assert scope.covers(request) is True


def test_covers_decision_type_mismatch_rejects() -> None:
    scope = AuthorityScope(decision_type="invoke_agent", domain="payment")
    request = _make_request(action_type="execute_tool", domain="payment")
    assert scope.covers(request) is False


def test_covers_domain_mismatch_rejects() -> None:
    scope = AuthorityScope(decision_type="invoke_agent", domain="payment")
    request = _make_request(action_type="invoke_agent", domain="fraud")
    assert scope.covers(request) is False


def test_covers_missing_condition_in_context_rejects() -> None:
    # Expected condition not present in request context → actual is None ≠ expected
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        conditions={"region": "eu-west-1"},
    )
    request = _make_request(context={})
    assert scope.covers(request) is False


def test_covers_condition_value_mismatch_rejects() -> None:
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        conditions={"region": "eu-west-1"},
    )
    request = _make_request(context={"region": "us-east-1"})
    assert scope.covers(request) is False


def test_covers_condition_match_succeeds() -> None:
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        conditions={"region": "eu-west-1"},
    )
    request = _make_request(context={"region": "eu-west-1"})
    assert scope.covers(request) is True


def test_covers_limit_exceeded_rejects() -> None:
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        limits={"amount": 100},
    )
    request = _make_request(context={"amount": 150})
    assert scope.covers(request) is False


def test_covers_limit_within_bound_succeeds() -> None:
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        limits={"amount": 100},
    )
    request = _make_request(context={"amount": 50})
    assert scope.covers(request) is True


def test_covers_limit_equal_to_bound_succeeds() -> None:
    # Reference semantics use strict `>`, so equal-to-limit is permitted.
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        limits={"amount": 100},
    )
    request = _make_request(context={"amount": 100})
    assert scope.covers(request) is True


def test_covers_limit_missing_in_context_ignored() -> None:
    # Reference semantics: absent/None numeric → limit check skipped.
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        limits={"amount": 100},
    )
    request = _make_request(context={})
    assert scope.covers(request) is True


def test_covers_limit_non_numeric_ignored() -> None:
    # Reference semantics: non-numeric value → limit check skipped.
    scope = AuthorityScope(
        decision_type="invoke_agent",
        domain="payment",
        limits={"amount": 100},
    )
    request = _make_request(context={"amount": "not-a-number"})
    assert scope.covers(request) is True


# ---------------------------------------------------------------------------
# AuthorityScope.specificity — unit tests
# ---------------------------------------------------------------------------


def test_specificity_empty_is_zero() -> None:
    scope = AuthorityScope(decision_type="*", domain="*")
    assert scope.specificity == 0


def test_specificity_monotonic_with_additions() -> None:
    a = AuthorityScope(decision_type="*", domain="*")
    b = AuthorityScope(decision_type="*", domain="*", conditions={"x": 1})
    c = AuthorityScope(
        decision_type="*", domain="*", conditions={"x": 1}, limits={"y": 10}
    )
    assert a.specificity == 0
    assert b.specificity == 1
    assert c.specificity == 2
    # Monotonicity: each successive scope has ≥ specificity of its predecessor.
    assert a.specificity <= b.specificity <= c.specificity


# ---------------------------------------------------------------------------
# AuthorityUnit.is_valid — unit tests
# ---------------------------------------------------------------------------


def _make_unit(**overrides) -> AuthorityUnit:
    defaults = dict(
        unit_id="u-1",
        agent_id="a-1",
        scope=AuthorityScope(decision_type="*", domain="*"),
    )
    defaults.update(overrides)
    return AuthorityUnit(**defaults)


def test_is_valid_revoked_false() -> None:
    unit = _make_unit(revoked=True)
    assert unit.is_valid() is False


def test_is_valid_expiry_in_past_false() -> None:
    unit = _make_unit(expiry_timestamp=time.time() - 3600)
    assert unit.is_valid() is False


def test_is_valid_no_expiry_true() -> None:
    unit = _make_unit(expiry_timestamp=None)
    assert unit.is_valid() is True


def test_is_valid_expiry_in_future_true() -> None:
    unit = _make_unit(expiry_timestamp=time.time() + 3600)
    assert unit.is_valid() is True


def test_is_valid_revoked_overrides_future_expiry() -> None:
    unit = _make_unit(revoked=True, expiry_timestamp=time.time() + 3600)
    assert unit.is_valid() is False


def test_authority_unit_registry_id_defaults_none() -> None:
    unit = _make_unit()
    assert unit.registry_id is None


def test_authority_unit_registry_id_global_sentinel() -> None:
    unit = _make_unit(registry_id="*GLOBAL*")
    assert unit.registry_id == "*GLOBAL*"


# ---------------------------------------------------------------------------
# GovernanceFinding.create — unit tests
# ---------------------------------------------------------------------------


def test_governance_finding_create_populates_fields() -> None:
    before = time.time()
    finding = GovernanceFinding.create(
        workflow_id="wf-1",
        decision=ArbitrationDecision.PERMIT,
        requesting_agent="arbiter",
        target_agent="agent-1",
        reason="within scope",
    )
    after = time.time()
    assert finding.workflow_id == "wf-1"
    assert finding.decision is ArbitrationDecision.PERMIT
    assert finding.requesting_agent == "arbiter"
    assert finding.target_agent == "agent-1"
    assert finding.reason == "within scope"
    # UUID is well-formed and timestamp is in-range.
    uuid.UUID(finding.finding_id)  # raises if not a valid UUID
    assert before <= finding.timestamp <= after


def test_governance_finding_create_uuid_uniqueness_1000() -> None:
    ids: set[str] = set()
    for _ in range(1000):
        finding = GovernanceFinding.create(
            workflow_id="wf",
            decision=ArbitrationDecision.DENY,
            requesting_agent="arbiter",
            target_agent="t",
            reason="r",
        )
        ids.add(finding.finding_id)
    assert len(ids) == 1000


def test_governance_finding_create_passes_optional_kwargs() -> None:
    finding = GovernanceFinding.create(
        workflow_id="wf-1",
        decision=ArbitrationDecision.ESCALATE,
        requesting_agent="arbiter",
        target_agent="agent-1",
        reason="conflict",
        scope_evaluated="u-1",
        contract_evaluated="c-1",
        escalation_target="arn:aws:sns:us-west-2:0:esc",
        residual_authority_denial=True,
    )
    assert finding.scope_evaluated == "u-1"
    assert finding.contract_evaluated == "c-1"
    assert finding.escalation_target == "arn:aws:sns:us-west-2:0:esc"
    assert finding.residual_authority_denial is True


# ---------------------------------------------------------------------------
# Dataclass construction smoke tests for remaining exports
# ---------------------------------------------------------------------------


def test_delegation_edge_construction() -> None:
    edge = DelegationEdge(
        edge_id="e-1",
        grantor_unit_id="u-1",
        grantee_agent_id="a-2",
        delegated_scope=AuthorityScope(decision_type="*", domain="*"),
    )
    assert edge.allow_redelegation is False
    assert edge.attenuation_rules == []


def test_composition_contract_defaults() -> None:
    contract = CompositionContract(
        contract_id="c-1",
        party_a="a",
        party_b="b",
        authority_precedence="none",
    )
    assert contract.conflict_resolution is ConflictResolution.DEFAULT_DENY
    assert contract.scope.decision_type == "*"
    assert contract.scope.domain == "*"
    assert contract.stop_rights == []
    assert contract.escalation_path is None


def test_constitutional_layer_defaults() -> None:
    layer = ConstitutionalLayer(layer_id="l-1", layer_type="global")
    assert layer.applies_to == []
    assert layer.rules == []
    assert layer.parent_layer_id is None


def test_case_law_entry_defaults() -> None:
    entry = CaseLawEntry(
        case_id="case-1",
        pattern={"k": "v"},
        resolution=ArbitrationDecision.DENY,
        encoded_at=time.time(),
        encoded_by="human-1",
    )
    assert entry.scope_of_applicability == {}
    assert entry.precedence == 0


# ---------------------------------------------------------------------------
# Hypothesis strategies
# ---------------------------------------------------------------------------

_keys = st.text(
    alphabet=st.characters(min_codepoint=97, max_codepoint=122),
    min_size=1,
    max_size=6,
)
_condition_values = st.one_of(
    st.integers(min_value=-1000, max_value=1000),
    st.text(max_size=8),
    st.booleans(),
)
_limit_values = st.integers(min_value=0, max_value=10_000)

_conditions_st = st.dictionaries(_keys, _condition_values, max_size=5)
_limits_st = st.dictionaries(_keys, _limit_values, max_size=5)


# ---------------------------------------------------------------------------
# Property test 1: specificity = len(conditions) + len(limits)
# ---------------------------------------------------------------------------


@given(conditions=_conditions_st, limits=_limits_st)
@settings(max_examples=200, deadline=None)
def test_property_specificity_equals_sum_of_lens(
    conditions: dict, limits: dict
) -> None:
    # Ensure the two dicts don't share keys in a way that matters for the
    # property — specificity is strictly the sum of the two lengths.
    scope = AuthorityScope(
        decision_type="*",
        domain="*",
        conditions=dict(conditions),
        limits=dict(limits),
    )
    assert scope.specificity == len(conditions) + len(limits)


@given(
    base_conditions=_conditions_st,
    base_limits=_limits_st,
    extra_cond_key=_keys,
    extra_cond_value=_condition_values,
    extra_limit_key=_keys,
    extra_limit_value=_limit_values,
)
@settings(max_examples=100, deadline=None)
def test_property_specificity_monotonic(
    base_conditions: dict,
    base_limits: dict,
    extra_cond_key: str,
    extra_cond_value,
    extra_limit_key: str,
    extra_limit_value: int,
) -> None:
    """Adding a condition or limit key must never decrease specificity."""
    base = AuthorityScope(
        decision_type="*",
        domain="*",
        conditions=dict(base_conditions),
        limits=dict(base_limits),
    )
    with_cond_conditions = dict(base_conditions)
    with_cond_conditions[extra_cond_key] = extra_cond_value
    with_cond = AuthorityScope(
        decision_type="*",
        domain="*",
        conditions=with_cond_conditions,
        limits=dict(base_limits),
    )
    with_limit_limits = dict(base_limits)
    with_limit_limits[extra_limit_key] = extra_limit_value
    with_limit = AuthorityScope(
        decision_type="*",
        domain="*",
        conditions=dict(base_conditions),
        limits=with_limit_limits,
    )
    assert with_cond.specificity >= base.specificity
    assert with_limit.specificity >= base.specificity


# ---------------------------------------------------------------------------
# Property test 2: covers-implies-specificity
#
# For scope A with just decision_type+domain (specificity=0) and scope B
# derived from A by adding exactly one condition (specificity=1):
#   ∀ request: B.covers(request) ⇒ A.covers(request)
# i.e. the more specific scope's coverage is a subset of the less specific
# scope's coverage. This is the formal statement of "more permissive scopes
# are less specific".
# ---------------------------------------------------------------------------


@given(
    decision_type=st.sampled_from(["invoke_agent", "execute_tool", "create_agent"]),
    domain=st.sampled_from(["payment", "fraud", "ops"]),
    extra_key=_keys,
    extra_value=st.integers(min_value=-100, max_value=100),
    req_context=st.dictionaries(_keys, _condition_values, max_size=4),
)
@settings(max_examples=100, deadline=None)
def test_property_covers_implies_specificity(
    decision_type: str,
    domain: str,
    extra_key: str,
    extra_value: int,
    req_context: dict,
) -> None:
    scope_a = AuthorityScope(decision_type=decision_type, domain=domain)
    scope_b = AuthorityScope(
        decision_type=decision_type,
        domain=domain,
        conditions={extra_key: extra_value},
    )
    # Specificity ordering.
    assert scope_a.specificity == 0
    assert scope_b.specificity == 1

    # Build a request against the same decision_type/domain with arbitrary context.
    request = _make_request(
        action_type=decision_type, domain=domain, context=dict(req_context)
    )

    # If B covers the request, A must also cover it (less specific = more permissive).
    if scope_b.covers(request):
        assert scope_a.covers(request)


# ---------------------------------------------------------------------------
# Property test 3: is_valid respects revoked and expiry independently
#
# is_valid() == (not revoked) AND (expiry_offset is None OR expiry_offset > 0)
# where expiry_offset is seconds relative to "now" at evaluation time.
# ---------------------------------------------------------------------------


@given(
    revoked=st.booleans(),
    # Use offsets well away from 0 so we don't race the clock between
    # constructing the unit and calling is_valid().
    expiry_offset=st.one_of(
        st.none(),
        st.integers(min_value=-10_000, max_value=-10),   # past
        st.integers(min_value=10, max_value=10_000),     # future
    ),
)
@settings(max_examples=100, deadline=None)
def test_property_is_valid_independence(
    revoked: bool, expiry_offset: int | None
) -> None:
    expiry_ts = None if expiry_offset is None else time.time() + expiry_offset
    unit = AuthorityUnit(
        unit_id="u",
        agent_id="a",
        scope=AuthorityScope(decision_type="*", domain="*"),
        revoked=revoked,
        expiry_timestamp=expiry_ts,
    )
    expected = (not revoked) and (expiry_offset is None or expiry_offset > 0)
    assert unit.is_valid() is expected
