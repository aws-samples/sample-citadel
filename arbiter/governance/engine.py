"""
Deterministic governance engine (US-ARB-005 + US-ARB-006).

Pure Python. No I/O. No LLM. No external calls. All data is passed in through
the constructor; every decision is returned as a ``GovernanceFinding``. I/O
(DynamoDB reads of the authority graph, ledger writes, SQS dispatch) happens
in the Arbiter layer around this engine.

Pipeline (8 steps, from Architecting Autonomy Article 10 + the Arbitration
Patterns companion):

1. case-law lookup (first match by pre-sorted precedence)
2. composition arbitration — scaffolded in US-ARB-005; US-ARB-006 fills it
3. covering-unit discovery (``is_valid()`` + ``scope.covers(request)``)
4. residual-authority deny if no covering units
5. tightest-scope selection with deterministic tie-break on ``unit_id``
6. composition evaluation (four arbitration patterns; US-ARB-006)
7. single-domain permit when no contract matched
8. constitutional review (override permits to DENY on invariant violation)

US-ARB-006 implements the four arbitration patterns from the Architecting
Autonomy companion "The Arbitration Patterns", keyed on
``CompositionContract.conflict_resolution``:

* ``HALT_AND_ESCALATE``  — Deferred Authority: both parties must PERMIT and
  state must be confirmed; otherwise escalate. UNCONFIRMED_STATE reduction
  applies to the finding when state is unconfirmed.
* ``DEFAULT_DENY``        — Unilateral Sovereignty: the sovereign party (per
  ``authority_precedence``) alone decides. Others defer. Unconfirmed state
  forces a monotonic reduction to DENY.
* ``PRECEDENCE_RESOLUTION`` — Rivalrous Claim: both parties stake a claim;
  the higher-precedence party wins and the loser is attenuated
  (ATTENUATION reduction on the finding).
* Collaborative Composition is state-gated regardless of the conflict
  resolution primitive: if the state is unconfirmed, the permit is denied
  with UNCONFIRMED_STATE.

Ported from the Agentic Fabric reference (sample-agentic-fabric
``src/governance/engine.py``) with these Citadel-specific adaptations:

* Deterministic tie-break on equal ``scope.specificity`` — the unit whose
  ``unit_id`` is lexicographically smaller wins (backlog AC2 + Req 5.4).
* Reason strings for case-law entries use this codebase's ``case_id`` field
  (``entry_id`` in the reference was renamed during US-ARB-001).
* Pattern taxonomy keyed on ``conflict_resolution`` (Citadel's convention)
  rather than deriving Pattern 2/3 implicitly from ``authority_precedence``.
* Scope reduction reasons (``ScopeReductionReason.ATTENUATION`` /
  ``UNCONFIRMED_STATE``) are stamped onto the finding ``reason`` string so
  the ledger entry is self-describing.
* No public API here mutates the authority graph — the engine is a pure
  function of the four config collections it is constructed with.
"""

from __future__ import annotations

import logging

from .models import (
    ArbitrationDecision,
    AuthorityUnit,
    CaseLawEntry,
    CompositionContract,
    ConflictResolution,
    ConstitutionalLayer,
    DispatchRequest,
    GovernanceFinding,
    ScopeReductionReason,
)

logger = logging.getLogger(__name__)


class GovernanceEngine:
    """Pure, deterministic governance engine.

    All evaluation is side-effect-free. The engine's only state is the
    indexed views of the four config collections built in ``__init__``; none
    of these are mutated by ``evaluate`` or any helper.
    """

    def __init__(
        self,
        authority_units: list[AuthorityUnit],
        composition_contracts: list[CompositionContract],
        case_law: list[CaseLawEntry],
        constitutional_layers: list[ConstitutionalLayer] | None = None,
    ) -> None:
        # Unit-id index — useful for downstream lookups (US-ARB-006 uses it).
        self.authority_units: dict[str, AuthorityUnit] = {
            u.unit_id: u for u in authority_units
        }

        # Agent-id index for fast covering-unit discovery. ``'*'`` is the
        # wildcard bucket for platform-wide coverage (agent_id == '*').
        self.agent_units: dict[str, list[AuthorityUnit]] = {}
        for u in authority_units:
            self.agent_units.setdefault(u.agent_id, []).append(u)

        # Contracts indexed by both party orderings so lookup is symmetric.
        self.contracts: dict[tuple[str, str], CompositionContract] = {}
        for c in composition_contracts:
            self.contracts[(c.party_a, c.party_b)] = c
            self.contracts[(c.party_b, c.party_a)] = c

        # Case law is pre-sorted so _check_case_law can stop at the first hit.
        # Stable sort on precedence descending — ties preserve insertion order.
        self.case_law: list[CaseLawEntry] = sorted(
            case_law, key=lambda e: -e.precedence
        )

        self.constitutional_layers: list[ConstitutionalLayer] = (
            constitutional_layers or []
        )

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def evaluate(self, request: DispatchRequest) -> GovernanceFinding:
        """Run the 8-step governance pipeline and return a finding.

        Never raises on governance-logical conditions — every path produces a
        ``GovernanceFinding``. A raise here indicates a bug in the engine or
        a malformed input, which should fail the dispatch upstream.
        """
        # --- Step 1: Case law -------------------------------------------------
        case_match = self._check_case_law(request)
        if case_match is not None:
            finding = GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=case_match.resolution,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason=f"case_law:{case_match.case_id}",
            )
            # Case law cannot bypass the constitution (Req 5.3).
            if finding.decision == ArbitrationDecision.PERMIT:
                override = self._constitutional_review(request, finding)
                if override is not None:
                    return override
            return finding

        # --- Step 3: Covering units ------------------------------------------
        covering = self._find_covering_units(request)

        # --- Step 4: Residual-authority deny ---------------------------------
        if not covering:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason="residual_authority_denial:no_scope_covers_action",
                residual_authority_denial=True,
            )

        # --- Step 5: Tightest-scope selection --------------------------------
        best = self._select_tightest_scope(covering)

        # --- Step 6: Composition evaluation (US-ARB-006) --------------------
        contract_result = self._evaluate_composition(request, best)
        if contract_result is not None:
            # The composition evaluator runs its own constitutional review
            # on any PERMIT it produces, so the finding is already final.
            if contract_result.decision == ArbitrationDecision.PERMIT:
                override = self._constitutional_review(
                    request, contract_result
                )
                if override is not None:
                    return override
            return contract_result

        # --- Step 7: Single-domain permit ------------------------------------
        permit = GovernanceFinding.create(
            workflow_id=request.workflow_id,
            decision=ArbitrationDecision.PERMIT,
            requesting_agent=request.requesting_agent_id,
            target_agent=request.target_agent_id,
            reason=f"scope_match:{best.unit_id}",
            scope_evaluated=best.unit_id,
        )

        # --- Step 8: Constitutional review -----------------------------------
        override = self._constitutional_review(request, permit)
        return override if override is not None else permit

    # ------------------------------------------------------------------
    # Step 3: covering-unit discovery
    # ------------------------------------------------------------------

    def _find_covering_units(
        self, request: DispatchRequest
    ) -> list[AuthorityUnit]:
        """Return in-force units that cover ``request``.

        Candidates are the union of units bound to the requesting agent and
        platform-wide units (``agent_id == '*'``). Each candidate is filtered
        by ``is_valid()`` (not revoked, not expired) and ``scope.covers``.
        """
        candidates = (
            self.agent_units.get(request.requesting_agent_id, [])
            + self.agent_units.get("*", [])
        )
        return [u for u in candidates if u.is_valid() and u.scope.covers(request)]

    # ------------------------------------------------------------------
    # Step 5: tightest-scope selection
    # ------------------------------------------------------------------

    def _select_tightest_scope(
        self, units: list[AuthorityUnit]
    ) -> AuthorityUnit:
        """Return the unit with the highest specificity.

        Primary key: higher ``scope.specificity`` wins.
        Tie-break (AC2): lexicographically smaller ``unit_id`` wins.

        Using ``min`` with the composite key ``(-specificity, unit_id)``
        encodes both rules in a single deterministic pass: the negation of
        specificity means higher specificity sorts first, and ``unit_id``
        breaks ties ascending.
        """
        return min(units, key=lambda u: (-u.scope.specificity, u.unit_id))

    # ------------------------------------------------------------------
    # Step 6: composition evaluation (US-ARB-006)
    # ------------------------------------------------------------------

    def _find_contract(
        self, request: DispatchRequest
    ) -> CompositionContract | None:
        """Return the composition contract governing this request, or ``None``.

        Lookup is agent-pair first (most specific), falling back to a
        domain-pair lookup derived from the parties' most-specific authority
        units. Symmetry of ``(party_a, party_b)`` is established at
        construction time.
        """
        contract = self.contracts.get(
            (request.requesting_agent_id, request.target_agent_id)
        )
        if contract is not None:
            return contract

        requester_domain = self._get_agent_domain(
            request.requesting_agent_id, request
        )
        target_domain = self._get_agent_domain(
            request.target_agent_id, request
        )
        if (
            requester_domain is not None
            and target_domain is not None
            and requester_domain != target_domain
        ):
            return self.contracts.get((requester_domain, target_domain))

        return None

    def _get_agent_domain(
        self,
        agent_id: str,
        request: DispatchRequest | None = None,
    ) -> str | None:
        """Derive an agent's domain from its tightest non-wildcard unit.

        If ``request`` is supplied, candidates are filtered to units whose
        scope covers that request — so domain derivation is request-aware
        (an agent in multiple domains resolves to the one relevant here).
        """
        units = self.agent_units.get(agent_id, [])
        if request is not None:
            valid = [
                u
                for u in units
                if u.is_valid()
                and u.scope.domain != "*"
                and u.scope.covers(request)
            ]
        else:
            valid = [
                u
                for u in units
                if u.is_valid() and u.scope.domain != "*"
            ]
        if valid:
            # Same tie-break as _select_tightest_scope so domain derivation
            # is deterministic across equal-specificity units.
            return min(
                valid, key=lambda u: (-u.scope.specificity, u.unit_id)
            ).scope.domain
        return None

    def _evaluate_composition(
        self,
        request: DispatchRequest,
        best_unit: AuthorityUnit,
    ) -> GovernanceFinding | None:
        """Composition arbitration (US-ARB-006).

        Dispatches to the four named patterns based on
        ``contract.conflict_resolution``. Returns ``None`` when no contract
        governs this request, signalling the caller to fall through to step
        7 (single-domain permit).
        """
        contract = self._find_contract(request)
        if contract is None:
            return None

        # Gather target-side covering units once; every pattern needs them
        # to know whether the target is permitted to act in this domain.
        target_units = [
            u
            for u in self.agent_units.get(request.target_agent_id, [])
            if u.is_valid() and u.scope.covers(request)
        ]
        requester_permits = len(self._find_covering_units(request)) > 0
        target_permits = len(target_units) > 0
        state_confirmed = self._is_state_confirmed(
            request, best_unit, contract
        )

        # Pattern dispatch is keyed on conflict_resolution (Citadel convention).
        if contract.conflict_resolution == ConflictResolution.HALT_AND_ESCALATE:
            return self._deferred_authority(
                request,
                contract,
                best_unit,
                target_units,
                requester_permits,
                target_permits,
                state_confirmed,
            )

        if contract.conflict_resolution == ConflictResolution.DEFAULT_DENY:
            return self._unilateral_sovereignty(
                request,
                contract,
                best_unit,
                target_units,
                requester_permits,
                target_permits,
                state_confirmed,
            )

        if contract.conflict_resolution == ConflictResolution.PRECEDENCE_RESOLUTION:
            return self._rivalrous_claim(
                request,
                contract,
                best_unit,
                target_units,
                requester_permits,
                target_permits,
                state_confirmed,
            )

        # Any other conflict_resolution value → Collaborative Composition:
        # a state-gated conjunction with no conflict-resolution primitive.
        return self._collaborative_composition(
            request,
            contract,
            best_unit,
            target_units,
            requester_permits,
            target_permits,
            state_confirmed,
        )

    # --- Pattern 1: Deferred Authority ---------------------------------

    def _deferred_authority(
        self,
        request: DispatchRequest,
        contract: CompositionContract,
        best_unit: AuthorityUnit,
        target_units: list[AuthorityUnit],
        requester_permits: bool,
        target_permits: bool,
        state_confirmed: bool,
    ) -> GovernanceFinding:
        """HALT_AND_ESCALATE: both parties must PERMIT and state must be confirmed.

        If state is unconfirmed, the permit is denied under UNCONFIRMED_STATE
        monotonic reduction. If both sides permit, PERMIT. If either denies,
        escalate via ``contract.escalation_path``.
        """
        if not state_confirmed:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason=(
                    f"deferred_authority:"
                    f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
                ),
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        if requester_permits and target_permits:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.PERMIT,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason="deferred_authority:both_permit",
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        # Either side denied → halt and escalate.
        return GovernanceFinding.create(
            workflow_id=request.workflow_id,
            decision=ArbitrationDecision.ESCALATE,
            requesting_agent=request.requesting_agent_id,
            target_agent=request.target_agent_id,
            reason="deferred_authority:conflict:halt_and_escalate",
            scope_evaluated=best_unit.unit_id,
            contract_evaluated=contract.contract_id,
            escalation_target=contract.escalation_path,
        )

    # --- Pattern 2: Unilateral Sovereignty ----------------------------

    def _unilateral_sovereignty(
        self,
        request: DispatchRequest,
        contract: CompositionContract,
        best_unit: AuthorityUnit,
        target_units: list[AuthorityUnit],
        requester_permits: bool,
        target_permits: bool,
        state_confirmed: bool,
    ) -> GovernanceFinding:
        """DEFAULT_DENY: the sovereign (``authority_precedence``) decides alone.

        Others defer. Unconfirmed state forces a monotonic reduction to
        DENY regardless of the sovereign's disposition.
        """
        if not state_confirmed:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason=(
                    f"unilateral_sovereignty:"
                    f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
                ),
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        sovereign = contract.authority_precedence

        if sovereign == request.requesting_agent_id:
            decision = (
                ArbitrationDecision.PERMIT
                if requester_permits
                else ArbitrationDecision.DENY
            )
            scope_evaluated = best_unit.unit_id
        elif sovereign == request.target_agent_id:
            decision = (
                ArbitrationDecision.PERMIT
                if target_permits
                else ArbitrationDecision.DENY
            )
            scope_evaluated = (
                target_units[0].unit_id if target_units else None
            )
        else:
            # Sovereign is neither requester nor target — no party qualified
            # to decide, so default_deny fires.
            decision = ArbitrationDecision.DENY
            scope_evaluated = best_unit.unit_id

        return GovernanceFinding.create(
            workflow_id=request.workflow_id,
            decision=decision,
            requesting_agent=request.requesting_agent_id,
            target_agent=request.target_agent_id,
            reason=f"unilateral_sovereignty:sovereign={sovereign}",
            scope_evaluated=scope_evaluated,
            contract_evaluated=contract.contract_id,
        )

    # --- Pattern 3: Rivalrous Claim -----------------------------------

    def _rivalrous_claim(
        self,
        request: DispatchRequest,
        contract: CompositionContract,
        best_unit: AuthorityUnit,
        target_units: list[AuthorityUnit],
        requester_permits: bool,
        target_permits: bool,
        state_confirmed: bool,
    ) -> GovernanceFinding:
        """PRECEDENCE_RESOLUTION: higher-precedence party wins; loser attenuated.

        Precedence is read from ``contract.authority_precedence`` naming the
        winner. The loser's authority is attenuated (ATTENUATION reduction
        stamped into the finding reason). Unconfirmed state forces a
        monotonic reduction to DENY.
        """
        if not state_confirmed:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason=(
                    f"rivalrous_claim:"
                    f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
                ),
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        winner = contract.authority_precedence

        if winner == request.requesting_agent_id:
            decision = (
                ArbitrationDecision.PERMIT
                if requester_permits
                else ArbitrationDecision.DENY
            )
            scope_evaluated = best_unit.unit_id
            loser = request.target_agent_id
        elif winner == request.target_agent_id:
            decision = (
                ArbitrationDecision.PERMIT
                if target_permits
                else ArbitrationDecision.DENY
            )
            scope_evaluated = (
                target_units[0].unit_id if target_units else None
            )
            loser = request.requesting_agent_id
        else:
            # No named winner → rivalrous claim cannot be resolved; deny.
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason="rivalrous_claim:no_precedence_winner",
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        return GovernanceFinding.create(
            workflow_id=request.workflow_id,
            decision=decision,
            requesting_agent=request.requesting_agent_id,
            target_agent=request.target_agent_id,
            reason=(
                f"rivalrous_claim:winner={winner}:loser={loser}:"
                f"{ScopeReductionReason.ATTENUATION.value}"
            ),
            scope_evaluated=scope_evaluated,
            contract_evaluated=contract.contract_id,
        )

    # --- Pattern 4: Collaborative Composition -------------------------

    def _collaborative_composition(
        self,
        request: DispatchRequest,
        contract: CompositionContract,
        best_unit: AuthorityUnit,
        target_units: list[AuthorityUnit],
        requester_permits: bool,
        target_permits: bool,
        state_confirmed: bool,
    ) -> GovernanceFinding:
        """State-gated conjunction: both must permit AND state must be confirmed.

        If state is unconfirmed, DENY with UNCONFIRMED_STATE. Otherwise a
        standard conjunction: both parties permit → PERMIT, else DENY.
        """
        if not state_confirmed:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.DENY,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason=(
                    f"collaborative_composition:"
                    f"{ScopeReductionReason.UNCONFIRMED_STATE.value}"
                ),
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        if requester_permits and target_permits:
            return GovernanceFinding.create(
                workflow_id=request.workflow_id,
                decision=ArbitrationDecision.PERMIT,
                requesting_agent=request.requesting_agent_id,
                target_agent=request.target_agent_id,
                reason="collaborative_composition:both_permit",
                scope_evaluated=best_unit.unit_id,
                contract_evaluated=contract.contract_id,
            )

        return GovernanceFinding.create(
            workflow_id=request.workflow_id,
            decision=ArbitrationDecision.DENY,
            requesting_agent=request.requesting_agent_id,
            target_agent=request.target_agent_id,
            reason="collaborative_composition:conjunction_failed",
            scope_evaluated=best_unit.unit_id,
            contract_evaluated=contract.contract_id,
        )

    # --- State-confirmation helper ------------------------------------

    def _is_state_confirmed(
        self,
        request: DispatchRequest,
        authority_unit: AuthorityUnit | None = None,
        contract: CompositionContract | None = None,
    ) -> bool:
        """Return ``True`` iff runtime state required by governance is confirmed.

        The request's ``context`` may carry keys prefixed ``unconfirmed_`` to
        signal state the Arbiter has not yet validated. State is considered
        unconfirmed only when one of those keys (minus the prefix) names a
        condition or limit the governance layer actually evaluates — i.e.,
        a key on the authority unit's scope or the contract's scope.
        Unrelated ``unconfirmed_*`` keys do not trigger monotonic reduction.
        """
        unconfirmed_keys = {
            k for k in request.context.keys() if k.startswith("unconfirmed_")
        }
        if not unconfirmed_keys:
            return True

        relevant_keys: set[str] = set()
        if authority_unit is not None:
            relevant_keys.update(authority_unit.scope.conditions.keys())
            relevant_keys.update(authority_unit.scope.limits.keys())
        if contract is not None and contract.scope is not None:
            relevant_keys.update(contract.scope.conditions.keys())
            relevant_keys.update(contract.scope.limits.keys())

        unconfirmed_base = {
            k[len("unconfirmed_"):] for k in unconfirmed_keys
        }
        return not bool(unconfirmed_base & relevant_keys)

    # ------------------------------------------------------------------
    # Step 1: case-law lookup
    # ------------------------------------------------------------------

    def _check_case_law(
        self, request: DispatchRequest
    ) -> CaseLawEntry | None:
        """Return the first case-law entry whose pattern matches, or ``None``.

        ``self.case_law`` is pre-sorted by ``-precedence`` at construction, so
        iterating yields entries in precedence order.
        """
        for entry in self.case_law:
            if self._matches_pattern(request, entry.pattern):
                return entry
        return None

    @staticmethod
    def _matches_pattern(request: DispatchRequest, pattern: dict) -> bool:
        """Deterministic conjunctive pattern match.

        Every key in ``pattern`` must match either a direct attribute on
        ``request`` or an entry in ``request.context``. A missing key on both
        surfaces is treated as a mismatch (``None != expected`` for any
        non-``None`` expected value).
        """
        for key, expected in pattern.items():
            actual = getattr(request, key, request.context.get(key))
            if actual != expected:
                return False
        return True

    # ------------------------------------------------------------------
    # Step 8: constitutional review
    # ------------------------------------------------------------------

    def _constitutional_review(
        self,
        request: DispatchRequest,
        permit_finding: GovernanceFinding,
    ) -> GovernanceFinding | None:
        """Override a PERMIT to DENY if any constitutional invariant is violated.

        Rules are conjunctive: the first violated rule in the first layer
        produces the override. Six operators are supported:

            eq         — actual == expected
            neq        — actual != expected
            exists     — actual is not None
            not_exists — actual is None
            gt         — actual is not None and actual > expected
            lt         — actual is not None and actual < expected

        The returned DENY preserves ``scope_evaluated`` and
        ``contract_evaluated`` from the overridden permit so downstream
        legibility records show both the scope that would have permitted
        and the constitutional rule that blocked it.
        """
        if not self.constitutional_layers:
            return None

        for layer in self.constitutional_layers:
            for rule in layer.rules:
                field = rule.get("field")
                operator = rule.get("operator", "eq")
                expected = rule.get("value")
                actual = request.context.get(field)

                violated = False
                if operator == "eq" and actual != expected:
                    violated = True
                elif operator == "neq" and actual == expected:
                    violated = True
                elif operator == "exists" and actual is None:
                    violated = True
                elif operator == "not_exists" and actual is not None:
                    violated = True
                elif operator == "gt" and (
                    actual is None or actual <= expected
                ):
                    violated = True
                elif operator == "lt" and (
                    actual is None or actual >= expected
                ):
                    violated = True
                elif operator not in (
                    "eq", "neq", "exists", "not_exists", "gt", "lt"
                ):
                    # Unknown operator → safe default: treat as non-violation
                    # and warn so ops can tighten the layer spec rather than
                    # allow silent pass-through.
                    violated = False
                    logger.warning(
                        "Unknown constitutional operator %r in layer %s "
                        "rule %r; treating as non-violation. Tighten the "
                        "layer spec to avoid silent pass-through.",
                        operator, layer.layer_id, rule,
                    )

                if violated:
                    return GovernanceFinding.create(
                        workflow_id=request.workflow_id,
                        decision=ArbitrationDecision.DENY,
                        requesting_agent=request.requesting_agent_id,
                        target_agent=request.target_agent_id,
                        reason=(
                            f"constitutional_review:{layer.layer_id}:"
                            f"invariant_violated:{field}"
                        ),
                        scope_evaluated=permit_finding.scope_evaluated,
                        contract_evaluated=permit_finding.contract_evaluated,
                    )

        return None
