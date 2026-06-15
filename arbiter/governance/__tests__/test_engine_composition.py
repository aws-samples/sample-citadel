"""Unit + property tests for the four arbitration patterns (US-ARB-006).

Covers the four composition patterns wired through
``GovernanceEngine._evaluate_composition`` and the ``_is_state_confirmed``
helper. Core-pipeline behaviour (steps 1, 3, 4, 5, 7, 8) is exercised by
``test_engine.py`` from US-ARB-005 — this file focuses strictly on step 6.

Patterns (keyed on ``CompositionContract.conflict_resolution``):

* ``HALT_AND_ESCALATE``      — Deferred Authority
* ``DEFAULT_DENY``            — Unilateral Sovereignty
* ``PRECEDENCE_RESOLUTION``   — Rivalrous Claim
* (state-only)                — Collaborative Composition

Property test (Property D): for any generated (contract, request) pair,
``_evaluate_composition`` returns either ``None`` or a valid
``GovernanceFinding`` — never raises.
"""
from __future__ import annotations

import os
import sys

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

# Path bootstrap matches test_engine.py so `from arbiter.governance...` works
# when pytest is run from the repo root.
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
    CompositionContract,
    ConflictResolution,
    DispatchRequest,
    GovernanceFinding,
    ScopeReductionReason,
)


# ---------------------------------------------------------------------------
# Construction helpers (mirrors test_engine.py shape for readability)
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
) -> AuthorityUnit:
    return AuthorityUnit(
        unit_id=uid,
        agent_id=agent,
        scope=scope if scope is not None else make_scope(),
        revoked=revoked,
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


def make_contract(
    cid: str = "c-1",
    a: str = "alice",
    b: str = "bob",
    precedence: str = "alice",
    resolution: ConflictResolution = ConflictResolution.DEFAULT_DENY,
    scope: AuthorityScope | None = None,
    escalation: str | None = None,
) -> CompositionContract:
    return CompositionContract(
        contract_id=cid,
        party_a=a,
        party_b=b,
        authority_precedence=precedence,
        conflict_resolution=resolution,
        scope=scope if scope is not None else AuthorityScope("*", "*"),
        escalation_path=escalation,
    )


# ---------------------------------------------------------------------------
# Pattern 1 — Deferred Authority (HALT_AND_ESCALATE)
# ---------------------------------------------------------------------------


def test_deferred_authority_both_permit_and_state_confirmed_permits() -> None:
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(resolution=ConflictResolution.HALT_AND_ESCALATE)
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason.startswith("deferred_authority:")
    assert finding.reason == "deferred_authority:both_permit"
    assert finding.scope_evaluated == "u-alice"
    assert finding.contract_evaluated == "c-1"


def test_deferred_authority_target_has_no_unit_escalates() -> None:
    # Only alice has a covering unit; bob does not → target denies.
    alice_unit = make_unit("u-alice", agent="alice")
    contract = make_contract(
        resolution=ConflictResolution.HALT_AND_ESCALATE,
        escalation="arn:aws:sns:us-east-1:000000000000:escalate",
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.ESCALATE
    assert finding.reason == "deferred_authority:conflict:halt_and_escalate"
    assert finding.contract_evaluated == "c-1"
    assert finding.escalation_target == (
        "arn:aws:sns:us-east-1:000000000000:escalate"
    )


def test_deferred_authority_requester_denied_escalates() -> None:
    # Directly invoke _evaluate_composition with a population where the
    # requester has no covering units but the target does. The engine's
    # public evaluate() would short-circuit at step 4 (residual authority
    # denial) before composition; we want to validate the ESCALATE branch
    # inside _deferred_authority itself.
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        resolution=ConflictResolution.HALT_AND_ESCALATE,
        escalation="arn:escalate",
    )
    engine = GovernanceEngine(
        authority_units=[bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    # Synthesise a best_unit for the composition call — the ESCALATE branch
    # uses best_unit.unit_id for scope_evaluated tracing only.
    synthetic = make_unit("u-synthetic", agent="alice")
    finding = engine._evaluate_composition(make_request(), synthetic)

    assert finding is not None
    assert finding.decision == ArbitrationDecision.ESCALATE
    assert finding.reason == "deferred_authority:conflict:halt_and_escalate"
    assert finding.escalation_target == "arn:escalate"
    assert finding.contract_evaluated == "c-1"
    assert finding.scope_evaluated == "u-synthetic"


def test_deferred_authority_unconfirmed_state_denies_with_reduction() -> None:
    # Contract scope requires 'tier'; request context carries unconfirmed_tier.
    alice_unit = make_unit(
        "u-alice",
        agent="alice",
        scope=make_scope(conds={"tier": "gold"}),
    )
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        resolution=ConflictResolution.HALT_AND_ESCALATE,
        scope=AuthorityScope("*", "*", conditions={"tier": "gold"}),
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    # tier=gold AND unconfirmed_tier → scope covers, state is unconfirmed.
    finding = engine.evaluate(
        make_request(ctx={"tier": "gold", "unconfirmed_tier": True})
    )

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == (
        f"deferred_authority:{ScopeReductionReason.UNCONFIRMED_STATE.value}"
    )
    assert finding.contract_evaluated == "c-1"


# ---------------------------------------------------------------------------
# Pattern 2 — Unilateral Sovereignty (DEFAULT_DENY)
# ---------------------------------------------------------------------------


def test_unilateral_sovereignty_sovereign_permits_permits() -> None:
    alice_unit = make_unit("u-alice", agent="alice")
    contract = make_contract(
        precedence="alice",
        resolution=ConflictResolution.DEFAULT_DENY,
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit],  # bob has no units — irrelevant
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "unilateral_sovereignty:sovereign=alice"
    assert finding.scope_evaluated == "u-alice"
    assert finding.contract_evaluated == "c-1"


def test_unilateral_sovereignty_non_sovereign_units_are_irrelevant() -> None:
    # Bob has plenty of units; only alice (the sovereign) decides.
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit_1 = make_unit("u-bob-1", agent="bob")
    bob_unit_2 = make_unit("u-bob-2", agent="bob")
    contract = make_contract(
        precedence="alice",
        resolution=ConflictResolution.DEFAULT_DENY,
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit_1, bob_unit_2],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "unilateral_sovereignty:sovereign=alice"


def test_unilateral_sovereignty_sovereign_denies_denies() -> None:
    # Alice is sovereign but her only unit is revoked → requester denies.
    # Use a target-held unit so step 4 (residual denial) does NOT trigger
    # and we actually reach the composition step.
    alice_revoked = make_unit("u-alice", agent="alice", revoked=True)
    wildcard = make_unit("u-wild", agent="*", revoked=True)  # no coverage
    # Put request requester on bob's side so covering-units check still has
    # *some* result — flip requester to bob, target to alice, sovereign alice.
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        a="bob",
        b="alice",
        precedence="alice",
        resolution=ConflictResolution.DEFAULT_DENY,
    )
    engine = GovernanceEngine(
        authority_units=[alice_revoked, wildcard, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    # requester=bob (has u-bob), target=alice (only revoked unit).
    finding = engine.evaluate(make_request(requester="bob", target="alice"))

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason.startswith("unilateral_sovereignty:")
    assert finding.reason == "unilateral_sovereignty:sovereign=alice"
    assert finding.contract_evaluated == "c-1"


def test_unilateral_sovereignty_unconfirmed_state_denies_with_reduction() -> None:
    alice_unit = make_unit(
        "u-alice",
        agent="alice",
        scope=make_scope(conds={"tier": "gold"}),
    )
    contract = make_contract(
        precedence="alice",
        resolution=ConflictResolution.DEFAULT_DENY,
        scope=AuthorityScope("*", "*", conditions={"tier": "gold"}),
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(
        make_request(ctx={"tier": "gold", "unconfirmed_tier": True})
    )

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == (
        f"unilateral_sovereignty:"
        f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
    )


# ---------------------------------------------------------------------------
# Pattern 3 — Rivalrous Claim (PRECEDENCE_RESOLUTION)
# ---------------------------------------------------------------------------


def test_rivalrous_claim_winner_gets_permit_loser_attenuated() -> None:
    # Both alice and bob have covering units → both stake a claim.
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit = make_unit("u-bob", agent="bob")
    # authority_precedence names the WINNER. Test: alice wins.
    contract = make_contract(
        precedence="alice",
        resolution=ConflictResolution.PRECEDENCE_RESOLUTION,
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    # Finding reason encodes the attenuation reduction for the loser.
    assert finding.reason.startswith("rivalrous_claim:")
    assert "winner=alice" in finding.reason
    assert "loser=bob" in finding.reason
    assert ScopeReductionReason.ATTENUATION.value in finding.reason
    assert finding.scope_evaluated == "u-alice"
    assert finding.contract_evaluated == "c-1"


def test_rivalrous_claim_winner_bob_returns_bob_scope() -> None:
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        precedence="bob",
        resolution=ConflictResolution.PRECEDENCE_RESOLUTION,
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert "winner=bob" in finding.reason
    assert "loser=alice" in finding.reason
    assert finding.scope_evaluated == "u-bob"


def test_rivalrous_claim_no_named_winner_denies() -> None:
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        precedence="none",
        resolution=ConflictResolution.PRECEDENCE_RESOLUTION,
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == "rivalrous_claim:no_precedence_winner"
    assert finding.contract_evaluated == "c-1"


def test_rivalrous_claim_unconfirmed_state_denies_with_reduction() -> None:
    alice_unit = make_unit(
        "u-alice",
        agent="alice",
        scope=make_scope(conds={"tier": "gold"}),
    )
    bob_unit = make_unit("u-bob", agent="bob")
    contract = make_contract(
        precedence="alice",
        resolution=ConflictResolution.PRECEDENCE_RESOLUTION,
        scope=AuthorityScope("*", "*", conditions={"tier": "gold"}),
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(
        make_request(ctx={"tier": "gold", "unconfirmed_tier": True})
    )

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == (
        f"rivalrous_claim:{ScopeReductionReason.UNCONFIRMED_STATE.value}"
    )


# ---------------------------------------------------------------------------
# Pattern 4 — Collaborative Composition (state-only gate)
# ---------------------------------------------------------------------------


# ConflictResolution only has three values; "Collaborative Composition" is
# triggered by constructing a contract whose conflict_resolution is anything
# outside the three handled cases. Since the enum is closed, we emulate this
# by patching a fresh enum instance — done by monkey-patching a contract's
# attribute to a sentinel string, which the engine's pattern match falls
# through on. The test's purpose is to document semantics; the property test
# (below) also exercises collaborative behaviour via unconfirmed state.


def _make_collab_contract(
    cid: str = "c-collab",
    a: str = "alice",
    b: str = "bob",
    scope: AuthorityScope | None = None,
) -> CompositionContract:
    """Build a contract whose conflict_resolution is outside the three known
    enum values, so the engine routes it through _collaborative_composition.

    Uses a sentinel string that bypasses enum equality with the three
    handled ConflictResolution members.
    """
    contract = make_contract(cid=cid, a=a, b=b, scope=scope)
    # Replace with a string sentinel that doesn't match any known enum
    # comparison — the engine's if/elif chain compares against enum members,
    # so any non-matching value falls through to collaborative.
    contract.conflict_resolution = "__collaborative_sentinel__"  # type: ignore[assignment]
    return contract


def test_collaborative_composition_both_permit_state_confirmed_permits() -> None:
    alice_unit = make_unit("u-alice", agent="alice")
    bob_unit = make_unit("u-bob", agent="bob")
    contract = _make_collab_contract()
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "collaborative_composition:both_permit"
    assert finding.contract_evaluated == "c-collab"


def test_collaborative_composition_unconfirmed_state_denies_with_reduction() -> None:
    alice_unit = make_unit(
        "u-alice",
        agent="alice",
        scope=make_scope(conds={"tier": "gold"}),
    )
    bob_unit = make_unit("u-bob", agent="bob")
    contract = _make_collab_contract(
        scope=AuthorityScope("*", "*", conditions={"tier": "gold"})
    )
    engine = GovernanceEngine(
        authority_units=[alice_unit, bob_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(
        make_request(ctx={"tier": "gold", "unconfirmed_tier": True})
    )

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == (
        f"collaborative_composition:"
        f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
    )


def test_collaborative_composition_one_party_denies_denies() -> None:
    # Only alice has a covering unit; bob has none.
    alice_unit = make_unit("u-alice", agent="alice")
    contract = _make_collab_contract()
    engine = GovernanceEngine(
        authority_units=[alice_unit],
        composition_contracts=[contract],
        case_law=[],
    )
    finding = engine.evaluate(make_request())

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason == "collaborative_composition:conjunction_failed"


# ---------------------------------------------------------------------------
# No-contract fall-through
# ---------------------------------------------------------------------------


def test_no_contract_matches_returns_none_internally() -> None:
    # Expose the internal fall-through: _evaluate_composition returns None
    # when no contract governs the request, so the engine lands at step 7
    # (single-domain permit).
    alice_unit = make_unit("u-alice", agent="alice")
    # Contract is between carol and dave — not alice/bob.
    unrelated = make_contract(a="carol", b="dave", precedence="carol")
    engine = GovernanceEngine(
        authority_units=[alice_unit],
        composition_contracts=[unrelated],
        case_law=[],
    )
    request = make_request()

    # Direct check on the internal contract lookup — this is the contract
    # that _evaluate_composition relies on to decide whether to act.
    assert engine._find_contract(request) is None

    # Full pipeline lands on scope_match (step 7), confirming step 6 returned
    # None and fell through.
    finding = engine.evaluate(request)
    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "scope_match:u-alice"


# ---------------------------------------------------------------------------
# _is_state_confirmed helper — unit-tested directly
# ---------------------------------------------------------------------------


def test_is_state_confirmed_no_unconfirmed_keys_is_true() -> None:
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    request = make_request(ctx={"tier": "gold"})
    unit = make_unit("u", scope=make_scope(conds={"tier": "gold"}))
    contract = make_contract()
    assert engine._is_state_confirmed(request, unit, contract) is True


def test_is_state_confirmed_unrelated_unconfirmed_key_is_true() -> None:
    # unconfirmed_weather is not a condition/limit anywhere → state is fine.
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    request = make_request(ctx={"unconfirmed_weather": "rainy"})
    unit = make_unit("u", scope=make_scope(conds={"tier": "gold"}))
    contract = make_contract()
    assert engine._is_state_confirmed(request, unit, contract) is True


def test_is_state_confirmed_relevant_unconfirmed_key_is_false() -> None:
    # unconfirmed_tier matches a condition on the authority unit.
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    request = make_request(ctx={"unconfirmed_tier": True})
    unit = make_unit("u", scope=make_scope(conds={"tier": "gold"}))
    contract = make_contract()
    assert engine._is_state_confirmed(request, unit, contract) is False


def test_is_state_confirmed_contract_scope_triggers_reduction() -> None:
    # The unconfirmed key is only on the contract's scope, not the unit.
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    request = make_request(ctx={"unconfirmed_region": "us-east-1"})
    unit = make_unit("u")  # no conditions
    contract = make_contract(
        scope=AuthorityScope("*", "*", conditions={"region": "us-east-1"}),
    )
    assert engine._is_state_confirmed(request, unit, contract) is False


def test_is_state_confirmed_handles_null_unit_and_contract() -> None:
    # Defensive: helper must accept None for both.
    engine = GovernanceEngine(
        authority_units=[], composition_contracts=[], case_law=[]
    )
    request = make_request(ctx={"unconfirmed_x": True})
    assert engine._is_state_confirmed(request, None, None) is True


# ---------------------------------------------------------------------------
# Property D — _evaluate_composition is total (never raises)
# ---------------------------------------------------------------------------


_AGENT_IDS = st.sampled_from(["alice", "bob", "carol"])
_DOMAINS = st.sampled_from(["payment", "fraud", "identity", "*"])
_ACTION_TYPES = st.sampled_from(
    ["invoke_agent", "execute_tool", "create_agent"]
)
_RESOLUTIONS = st.sampled_from(list(ConflictResolution))


@st.composite
def _scope_strategy(draw) -> AuthorityScope:
    dt = draw(_ACTION_TYPES | st.just("*"))
    dom = draw(_DOMAINS | st.just("*"))
    num_conds = draw(st.integers(min_value=0, max_value=2))
    num_lims = draw(st.integers(min_value=0, max_value=2))
    conds = {f"c{i}": draw(st.integers(0, 3)) for i in range(num_conds)}
    lims = {f"l{i}": draw(st.integers(10, 100)) for i in range(num_lims)}
    return AuthorityScope(decision_type=dt, domain=dom, conditions=conds, limits=lims)


@st.composite
def _unit_strategy(draw) -> AuthorityUnit:
    uid = draw(st.sampled_from(["u-a", "u-b", "u-c", "u-d"]))
    agent = draw(_AGENT_IDS)
    scope = draw(_scope_strategy())
    return AuthorityUnit(
        unit_id=uid,
        agent_id=agent,
        scope=scope,
        revoked=draw(st.booleans()),
    )


@st.composite
def _contract_strategy(draw) -> CompositionContract:
    a = draw(_AGENT_IDS)
    b = draw(_AGENT_IDS)
    # Precedence names one of the parties, the other, or neither.
    precedence = draw(st.sampled_from([a, b, "none"]))
    resolution = draw(_RESOLUTIONS)
    scope = draw(_scope_strategy())
    return CompositionContract(
        contract_id="c-prop",
        party_a=a,
        party_b=b,
        authority_precedence=precedence,
        conflict_resolution=resolution,
        scope=scope,
    )


@st.composite
def _request_strategy(draw) -> DispatchRequest:
    ctx_size = draw(st.integers(min_value=0, max_value=3))
    ctx: dict = {}
    for i in range(ctx_size):
        # Mix of plain and ``unconfirmed_`` keys so the state-confirmation
        # branch gets exercised.
        key = draw(st.sampled_from([f"c{i}", f"unconfirmed_c{i}"]))
        ctx[key] = draw(st.integers(0, 3))
    return DispatchRequest(
        requesting_agent_id=draw(_AGENT_IDS),
        target_agent_id=draw(_AGENT_IDS),
        action_type=draw(_ACTION_TYPES),
        domain=draw(_DOMAINS),
        workflow_id="wf",
        agent_use_id="use",
        context=ctx,
    )


@given(
    units=st.lists(_unit_strategy(), max_size=6),
    contract=_contract_strategy(),
    request=_request_strategy(),
)
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
def test_property_evaluate_composition_is_total(units, contract, request) -> None:
    """For any (units, contract, request), _evaluate_composition returns
    either None or a valid GovernanceFinding — never raises."""
    engine = GovernanceEngine(
        authority_units=units,
        composition_contracts=[contract],
        case_law=[],
    )
    # Pick any covering unit to feed as best_unit; fall back to a synthetic
    # one if nothing covers. The property is about totality, not correctness
    # of the best_unit selection (that is validated in test_engine.py).
    covering = engine._find_covering_units(request)
    if covering:
        best = engine._select_tightest_scope(covering)
    else:
        best = AuthorityUnit(
            unit_id="u-fallback",
            agent_id=request.requesting_agent_id,
            scope=AuthorityScope("*", "*"),
        )

    result = engine._evaluate_composition(request, best)

    # Totality: must be None or a GovernanceFinding.
    assert result is None or isinstance(result, GovernanceFinding)
    if result is not None:
        # All decisions must be a valid member of the enum.
        assert result.decision in (
            ArbitrationDecision.PERMIT,
            ArbitrationDecision.DENY,
            ArbitrationDecision.HALT,
            ArbitrationDecision.ESCALATE,
        )
        # Traceability: every composition finding cites the contract.
        assert result.contract_evaluated == contract.contract_id
