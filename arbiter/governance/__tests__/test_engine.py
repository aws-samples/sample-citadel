"""Unit + property tests for arbiter/governance/engine.py (US-ARB-005).

Covers the six deterministic acceptance criteria from the backlog and three
Hypothesis property tests (total invariants the engine must uphold):

  Property A — ``evaluate`` never raises and never returns ``None`` for any
               valid ``DispatchRequest`` + any authority-unit population.
  Property B — ``_select_tightest_scope`` is deterministic: the same input
               list produces the same output across repeated invocations.
  Property C — When at least one unit covers the request, the finding's
               ``scope_evaluated`` is one of the covering unit_ids AND has
               the maximum specificity among covering units (Req 5.8).
"""
from __future__ import annotations

import os
import sys

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

# Add the project root so ``from arbiter.governance...`` resolves when
# pytest is run from the repo root (matches test_hierarchy.py / test_ledger.py).
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.engine import GovernanceEngine  # noqa: E402
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    AuthorityScope,
    AuthorityUnit,
    CaseLawEntry,
    CompositionContract,
    ConflictResolution,
    ConstitutionalLayer,
    DispatchRequest,
    GovernanceFinding,
)


# ---------------------------------------------------------------------------
# Construction helpers
# ---------------------------------------------------------------------------


def make_scope(
    dt: str = "invoke_agent",
    dom: str = "payment",
    conds: dict | None = None,
    lims: dict | None = None,
) -> AuthorityScope:
    return AuthorityScope(
        decision_type=dt,
        domain=dom,
        conditions=conds or {},
        limits=lims or {},
    )


def make_unit(
    uid: str,
    agent: str = "alice",
    scope: AuthorityScope | None = None,
    revoked: bool = False,
    expiry: float | None = None,
    app: str | None = None,
) -> AuthorityUnit:
    return AuthorityUnit(
        unit_id=uid,
        agent_id=agent,
        scope=scope if scope is not None else make_scope(),
        revoked=revoked,
        expiry_timestamp=expiry,
        registry_id=app,
    )


def make_request(
    action: str = "invoke_agent",
    dom: str = "payment",
    requester: str = "alice",
    target: str = "bob",
    ctx: dict | None = None,
) -> DispatchRequest:
    return DispatchRequest(
        requesting_agent_id=requester,
        target_agent_id=target,
        action_type=action,
        domain=dom,
        workflow_id="wf-test",
        agent_use_id="use-test",
        context=ctx or {},
    )


# ---------------------------------------------------------------------------
# AC1 — residual-authority denial when no unit covers the request
# ---------------------------------------------------------------------------


def test_no_covering_unit_produces_residual_authority_deny() -> None:
    # No units at all.
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.residual_authority_denial is True
    assert finding.reason.startswith("residual_authority_denial")
    assert finding.reason == "residual_authority_denial:no_scope_covers_action"


def test_unit_exists_but_scope_does_not_cover_still_residual_deny() -> None:
    # Unit is valid but targets a different domain, so scope.covers() is False.
    unit = make_unit("u-1", scope=make_scope(dom="fraud"))
    engine = GovernanceEngine(
        authority_units=[unit], composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(make_request(dom="payment"))

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.residual_authority_denial is True


def test_revoked_unit_does_not_count_as_covering() -> None:
    unit = make_unit("u-1", revoked=True)
    engine = GovernanceEngine(
        authority_units=[unit], composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.residual_authority_denial is True


# ---------------------------------------------------------------------------
# AC2 — deterministic tie-break on equal specificity (unit_id ascending)
# ---------------------------------------------------------------------------


def test_equal_specificity_tiebreaks_on_lexicographically_smaller_unit_id() -> None:
    # Both units have the same specificity (0 conditions + 0 limits).
    unit_b = make_unit("unit-b")
    unit_a = make_unit("unit-a")
    # Insertion order is b-then-a on purpose; tie-break must pick a anyway.
    engine = GovernanceEngine(
        authority_units=[unit_b, unit_a],
        composition_contracts=[],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.scope_evaluated == "unit-a"
    assert finding.reason == "scope_match:unit-a"


def test_tiebreak_with_equal_specificity_three_units() -> None:
    # Three units with identical specificity; smallest unit_id wins.
    u1 = make_unit("unit-m")
    u2 = make_unit("unit-a")
    u3 = make_unit("unit-z")
    engine = GovernanceEngine(
        authority_units=[u1, u2, u3],
        composition_contracts=[],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.scope_evaluated == "unit-a"


# ---------------------------------------------------------------------------
# AC3 — single covering unit + no contract => PERMIT scope_match
# ---------------------------------------------------------------------------


def test_single_covering_unit_produces_scope_match_permit() -> None:
    unit = make_unit("unit-only")
    engine = GovernanceEngine(
        authority_units=[unit], composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason.startswith("scope_match:")
    assert finding.reason == "scope_match:unit-only"
    assert finding.scope_evaluated == "unit-only"


def test_wildcard_agent_id_unit_covers_any_requester() -> None:
    # agent_id == '*' platform-wide coverage.
    unit = make_unit("unit-global", agent="*")
    engine = GovernanceEngine(
        authority_units=[unit], composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(make_request(requester="someone-else"))

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.scope_evaluated == "unit-global"


# ---------------------------------------------------------------------------
# AC4 — constitutional violation overrides a permit to DENY
# ---------------------------------------------------------------------------


def test_constitutional_eq_violation_overrides_permit() -> None:
    unit = make_unit("unit-ok")
    layer = ConstitutionalLayer(
        layer_id="global-constitution",
        layer_type="global",
        rules=[{"field": "x", "operator": "eq", "value": True}],
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer],
    )
    # context has x=False → the rule's expected True does not match.
    finding = engine.evaluate(make_request(ctx={"x": False}))

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason.startswith("constitutional_review:")
    assert finding.reason == (
        "constitutional_review:global-constitution:invariant_violated:x"
    )
    # The overridden permit's scope_evaluated is preserved.
    assert finding.scope_evaluated == "unit-ok"


def test_constitutional_review_returns_none_when_all_rules_pass() -> None:
    unit = make_unit("unit-ok")
    layer = ConstitutionalLayer(
        layer_id="global-constitution",
        layer_type="global",
        rules=[{"field": "x", "operator": "eq", "value": True}],
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer],
    )
    finding = engine.evaluate(make_request(ctx={"x": True}))

    # Rule satisfied → original PERMIT stands.
    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "scope_match:unit-ok"


@pytest.mark.parametrize(
    "operator,ctx_value,rule_value,should_deny",
    [
        # eq — denies on mismatch
        ("eq", 1, 2, True),
        ("eq", 1, 1, False),
        # neq — denies on match
        ("neq", 1, 1, True),
        ("neq", 1, 2, False),
        # exists — denies when field absent
        ("exists", None, None, True),
        ("exists", "anything", None, False),
        # not_exists — denies when field present
        ("not_exists", "present", None, True),
        ("not_exists", None, None, False),
        # gt — denies when actual is None or not > expected
        ("gt", None, 5, True),
        ("gt", 4, 5, True),
        ("gt", 5, 5, True),   # equal is NOT strictly greater
        ("gt", 6, 5, False),
        # lt — denies when actual is None or not < expected
        ("lt", None, 5, True),
        ("lt", 6, 5, True),
        ("lt", 5, 5, True),
        ("lt", 4, 5, False),
    ],
)
def test_constitutional_operators(operator, ctx_value, rule_value, should_deny) -> None:
    unit = make_unit("u")
    layer = ConstitutionalLayer(
        layer_id="layer-1",
        layer_type="global",
        rules=[{"field": "metric", "operator": operator, "value": rule_value}],
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer],
    )
    ctx: dict = {}
    if ctx_value is not None:
        ctx["metric"] = ctx_value
    finding = engine.evaluate(make_request(ctx=ctx))

    if should_deny:
        assert finding.decision == ArbitrationDecision.DENY
        assert finding.reason.startswith("constitutional_review:")
    else:
        assert finding.decision == ArbitrationDecision.PERMIT


# ---------------------------------------------------------------------------
# AC5 — specificity dominates; tie-break is secondary
# ---------------------------------------------------------------------------


def test_higher_specificity_wins_even_when_unit_id_is_larger() -> None:
    # Lower-specificity unit with lexicographically smaller unit_id.
    a = make_unit("unit-a", scope=make_scope(conds={}))  # specificity 0
    # Higher-specificity unit with lexicographically larger unit_id.
    b = make_unit(
        "unit-b",
        scope=make_scope(conds={"tier": "gold"}, lims={"amount": 1000}),
    )  # specificity 2
    engine = GovernanceEngine(
        authority_units=[a, b], composition_contracts=[], case_law=[]
    )
    # Make both units cover the request (tier=gold, amount <= 1000).
    finding = engine.evaluate(make_request(ctx={"tier": "gold", "amount": 500}))

    assert finding.decision == ArbitrationDecision.PERMIT
    # b wins despite unit-b > unit-a because specificity is primary.
    assert finding.scope_evaluated == "unit-b"


# ---------------------------------------------------------------------------
# AC6 — case-law PERMIT still passes through constitutional review
# ---------------------------------------------------------------------------


def test_case_law_permit_is_reviewed_by_constitution() -> None:
    # Case-law pattern matches any invoke_agent into 'payment'.
    case = CaseLawEntry(
        case_id="case-42",
        pattern={"action_type": "invoke_agent", "domain": "payment"},
        resolution=ArbitrationDecision.PERMIT,
        encoded_at=0.0,
        encoded_by="human-operator",
        precedence=10,
    )
    layer = ConstitutionalLayer(
        layer_id="safety-layer",
        layer_type="global",
        rules=[{"field": "safety_checked", "operator": "eq", "value": True}],
    )
    engine = GovernanceEngine(
        authority_units=[],
        composition_contracts=[],
        case_law=[case],
        constitutional_layers=[layer],
    )

    # Context violates the constitutional rule.
    finding = engine.evaluate(make_request(ctx={"safety_checked": False}))

    # Case-law matched and said PERMIT, but constitutional review overrides.
    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason.startswith("constitutional_review:")


def test_case_law_permit_survives_when_constitution_passes() -> None:
    case = CaseLawEntry(
        case_id="case-7",
        pattern={"action_type": "invoke_agent", "domain": "payment"},
        resolution=ArbitrationDecision.PERMIT,
        encoded_at=0.0,
        encoded_by="human-operator",
        precedence=10,
    )
    layer = ConstitutionalLayer(
        layer_id="safety-layer",
        layer_type="global",
        rules=[{"field": "safety_checked", "operator": "eq", "value": True}],
    )
    engine = GovernanceEngine(
        authority_units=[],
        composition_contracts=[],
        case_law=[case],
        constitutional_layers=[layer],
    )
    finding = engine.evaluate(make_request(ctx={"safety_checked": True}))

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "case_law:case-7"


def test_case_law_deny_does_not_run_constitutional_review() -> None:
    # Case-law DENY is final at step 1; no need for constitutional review.
    case = CaseLawEntry(
        case_id="case-deny",
        pattern={"action_type": "invoke_agent"},
        resolution=ArbitrationDecision.DENY,
        encoded_at=0.0,
        encoded_by="human-operator",
        precedence=10,
    )
    # Add a constitutional rule that WOULD pass — but we never reach it.
    layer = ConstitutionalLayer(
        layer_id="layer-1",
        layer_type="global",
        rules=[{"field": "x", "operator": "eq", "value": True}],
    )
    engine = GovernanceEngine(
        authority_units=[make_unit("u")],
        composition_contracts=[],
        case_law=[case],
        constitutional_layers=[layer],
    )
    finding = engine.evaluate(make_request(ctx={"x": False}))

    assert finding.decision == ArbitrationDecision.DENY
    # Reason comes from case-law, not from constitutional review.
    assert finding.reason == "case_law:case-deny"


def test_case_law_precedence_order() -> None:
    # Higher-precedence case is evaluated first.
    low = CaseLawEntry(
        case_id="case-low",
        pattern={"action_type": "invoke_agent"},
        resolution=ArbitrationDecision.DENY,
        encoded_at=0.0,
        encoded_by="op",
        precedence=1,
    )
    high = CaseLawEntry(
        case_id="case-high",
        pattern={"action_type": "invoke_agent"},
        resolution=ArbitrationDecision.PERMIT,
        encoded_at=0.0,
        encoded_by="op",
        precedence=100,
    )
    # Pass them in low-first insertion order; precedence sort must fix it.
    engine = GovernanceEngine(
        authority_units=[],
        composition_contracts=[],
        case_law=[low, high],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "case_law:case-high"


# ---------------------------------------------------------------------------
# Hypothesis strategies for property tests
# ---------------------------------------------------------------------------


_AGENT_IDS = st.sampled_from(["alice", "bob", "carol", "*"])
_ACTION_TYPES = st.sampled_from(["invoke_agent", "execute_tool", "create_agent"])
_DOMAINS = st.sampled_from(["payment", "fraud", "identity", "*"])


@st.composite
def _scope_strategy(draw) -> AuthorityScope:
    dt = draw(_ACTION_TYPES.map(str) | st.just("*"))
    dom = draw(_DOMAINS.map(str) | st.just("*"))
    # Small, governance-neutral conditions/limits so covers() is well-defined.
    num_conds = draw(st.integers(min_value=0, max_value=3))
    num_lims = draw(st.integers(min_value=0, max_value=3))
    conds = {f"c{i}": draw(st.integers(0, 5)) for i in range(num_conds)}
    lims = {f"l{i}": draw(st.integers(10, 100)) for i in range(num_lims)}
    return AuthorityScope(decision_type=dt, domain=dom, conditions=conds, limits=lims)


@st.composite
def _unit_strategy(draw) -> AuthorityUnit:
    # unit_ids drawn from a fixed pool so collisions are possible and the
    # tie-break logic actually gets exercised.
    uid = draw(
        st.sampled_from(
            [
                "unit-aaa",
                "unit-aab",
                "unit-aac",
                "unit-bbb",
                "unit-zzz",
            ]
        )
    )
    agent = draw(_AGENT_IDS)
    scope = draw(_scope_strategy())
    revoked = draw(st.booleans())
    return AuthorityUnit(
        unit_id=uid,
        agent_id=agent,
        scope=scope,
        revoked=revoked,
        expiry_timestamp=None,
    )


@st.composite
def _request_strategy(draw) -> DispatchRequest:
    action = draw(_ACTION_TYPES)
    dom = draw(_DOMAINS)
    requester = draw(_AGENT_IDS)
    ctx_keys = draw(st.integers(min_value=0, max_value=3))
    ctx = {f"c{i}": draw(st.integers(0, 5)) for i in range(ctx_keys)}
    return DispatchRequest(
        requesting_agent_id=requester,
        target_agent_id="bob",
        action_type=action,
        domain=dom,
        workflow_id="wf",
        agent_use_id="use",
        context=ctx,
    )


# ---------------------------------------------------------------------------
# Property A — evaluate never raises and always returns a GovernanceFinding
# ---------------------------------------------------------------------------


@given(
    units=st.lists(_unit_strategy(), max_size=8),
    request=_request_strategy(),
)
@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_property_evaluate_is_total(units, request) -> None:
    engine = GovernanceEngine(
        authority_units=units, composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(request)
    assert finding is not None
    assert isinstance(finding, GovernanceFinding)
    assert finding.decision in (
        ArbitrationDecision.PERMIT,
        ArbitrationDecision.DENY,
        ArbitrationDecision.HALT,
        ArbitrationDecision.ESCALATE,
    )


# ---------------------------------------------------------------------------
# Property B — _select_tightest_scope is deterministic across invocations
# ---------------------------------------------------------------------------


@given(units=st.lists(_unit_strategy(), min_size=1, max_size=8))
@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_property_select_tightest_scope_is_deterministic(units) -> None:
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    first = engine._select_tightest_scope(units)
    for _ in range(9):
        assert engine._select_tightest_scope(units) is first


# ---------------------------------------------------------------------------
# Property C — scope_evaluated is a covering unit with max specificity (Req 5.8)
# ---------------------------------------------------------------------------


@st.composite
def _covering_population(draw):
    """Emit (units, request) where at least one valid unit covers the request.

    The guaranteed-coverage unit uses a wildcard scope (``*``/``*``) bound to
    whatever requester the strategy draws, so coverage is certain regardless
    of the other randomly-drawn units in the population.
    """
    request = draw(_request_strategy())
    # Force coverage: a wildcard, non-revoked unit on the requesting agent.
    guaranteed_id = draw(
        st.sampled_from(
            ["unit-guarantee-a", "unit-guarantee-b", "unit-guarantee-c"]
        )
    )
    guaranteed = AuthorityUnit(
        unit_id=guaranteed_id,
        agent_id=request.requesting_agent_id,
        scope=AuthorityScope(decision_type="*", domain="*"),
        revoked=False,
        expiry_timestamp=None,
    )
    other = draw(st.lists(_unit_strategy(), max_size=6))
    return (other + [guaranteed], request)


@given(pop=_covering_population())
@settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])
def test_property_scope_evaluated_is_maximal_covering_unit(pop) -> None:
    units, request = pop
    engine = GovernanceEngine(
        authority_units=units, composition_contracts=[], case_law=[]
    )
    finding = engine.evaluate(request)

    # Compute covering set the same way the engine does so the assertion is
    # exactly the engine's contract, not a looser approximation. The engine
    # filters candidates by agent_id (requester or '*') BEFORE applying
    # is_valid() and scope.covers() — replicate that filtering here.
    agent_bound = [
        u
        for u in units
        if u.agent_id == request.requesting_agent_id or u.agent_id == "*"
    ]
    covering = [u for u in agent_bound if u.is_valid() and u.scope.covers(request)]
    assert covering, "strategy must guarantee at least one covering unit"

    # Case-law is empty and composition stub returns None, so the engine must
    # land on PERMIT at step 7 (or DENY at step 8 if a constitutional layer
    # were present — we don't pass any, so PERMIT is the only outcome).
    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.scope_evaluated is not None

    covering_ids = {u.unit_id for u in covering}
    assert finding.scope_evaluated in covering_ids

    # Specificity invariant (Req 5.8): there must be at least one covering
    # unit whose unit_id matches the finding AND whose specificity equals
    # the maximum across all covering units. Duplicate unit_ids (same id,
    # different specificities) can appear in random populations — the engine
    # picks the maximal instance, so we check existence, not first-match.
    max_spec = max(u.scope.specificity for u in covering)
    matches = [u for u in covering if u.unit_id == finding.scope_evaluated]
    assert matches, "scope_evaluated must resolve to at least one covering unit"
    assert max(u.scope.specificity for u in matches) == max_spec


# ---------------------------------------------------------------------------
# Smoke tests on the engine's construction-time indexing
# ---------------------------------------------------------------------------


def test_engine_indexes_units_by_agent_id() -> None:
    a1 = make_unit("u1", agent="alice")
    a2 = make_unit("u2", agent="alice")
    b1 = make_unit("u3", agent="bob")
    engine = GovernanceEngine(
        authority_units=[a1, a2, b1],
        composition_contracts=[],
        case_law=[],
    )
    assert len(engine.agent_units["alice"]) == 2
    assert len(engine.agent_units["bob"]) == 1
    assert engine.authority_units["u1"] is a1


def test_engine_pre_sorts_case_law_by_precedence_descending() -> None:
    low = CaseLawEntry(
        case_id="low", pattern={}, resolution=ArbitrationDecision.DENY,
        encoded_at=0.0, encoded_by="op", precedence=1,
    )
    high = CaseLawEntry(
        case_id="high", pattern={}, resolution=ArbitrationDecision.DENY,
        encoded_at=0.0, encoded_by="op", precedence=100,
    )
    mid = CaseLawEntry(
        case_id="mid", pattern={}, resolution=ArbitrationDecision.DENY,
        encoded_at=0.0, encoded_by="op", precedence=50,
    )
    engine = GovernanceEngine(
        authority_units=[],
        composition_contracts=[],
        case_law=[low, high, mid],
    )
    assert [e.case_id for e in engine.case_law] == ["high", "mid", "low"]
