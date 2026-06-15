"""
Authority model data structures for the Citadel governance layer.

Ported from the Agentic Fabric reference implementation (sample-agentic-fabric
src/governance/models.py) with Python 3.14-style type hints (PEP 604, PEP 585).

Implements the authority model from the Architecting Autonomy series:
- Authority Unit (Article 8: The Unit of Authority)
- Composition Contract (Article 9: Authority Composition)
- Control-Surface Band types (Article 11: Governance at Machine Speed)
- Arbitration patterns (Companion: The Arbitration Patterns)

All evaluation is deterministic. No LLM calls. No interpretation.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


# --- Enums ---


class ConflictResolution(str, Enum):
    HALT_AND_ESCALATE = "halt_and_escalate"
    DEFAULT_DENY = "default_deny"
    PRECEDENCE_RESOLUTION = "precedence_resolution"


class ArbitrationDecision(str, Enum):
    PERMIT = "permit"
    DENY = "deny"
    ESCALATE = "escalate"
    HALT = "halt"


class ScopeReductionReason(str, Enum):
    UNCONFIRMED_STATE = "unconfirmed_state"
    DOMAIN_BOUNDARY = "domain_boundary"
    ATTENUATION = "attenuation"


# --- Authority Scope (4-tuple) ---


@dataclass
class AuthorityScope:
    """
    Encodes what an agent is authorised to do.
    Four dimensions: decision_type, domain, conditions, limits.
    All fields must be evaluable without interpretation at runtime.
    """

    decision_type: str          # e.g. "invoke_agent", "execute_tool", "create_agent"
    domain: str                 # e.g. "payment", "fraud", "*" for wildcard
    conditions: dict = field(default_factory=dict)   # key-value predicates
    limits: dict = field(default_factory=dict)        # quantitative upper bounds

    def covers(self, request: "DispatchRequest") -> bool:
        """Deterministic scope evaluation (matches reference models.py:L49-L68)."""
        if self.decision_type != request.action_type and self.decision_type != "*":
            return False
        if self.domain != request.domain and self.domain != "*":
            return False
        for key, expected in self.conditions.items():
            actual = request.context.get(key)
            if actual != expected:
                return False
        for key, limit in self.limits.items():
            actual = request.context.get(key)
            if actual is not None and isinstance(actual, (int, float)) and actual > limit:
                return False
        return True

    @property
    def specificity(self) -> int:
        """How specific this scope is. Higher = more conditions + limits defined."""
        return len(self.conditions) + len(self.limits)


# --- Authority Unit (graph node) ---


@dataclass
class AuthorityUnit:
    """
    A single node in the authority graph.
    Six properties from Article 8: explicit, scoped, enforceable, delegable, observable, terminable.

    The ``registry_id`` field (Citadel-specific, per D2) scopes the unit to an
    application; ``"*GLOBAL*"`` denotes platform-wide authority.
    """

    unit_id: str
    agent_id: str
    scope: AuthorityScope
    delegation_source: str | None = None     # unit_id of the grantor
    can_redelegate: bool = False
    expiry_timestamp: float | None = None    # unix timestamp, None = no expiry
    revoked: bool = False
    risk_rating: Literal["low", "medium", "high"] = "low"
    registry_id: str | None = None                # per D2 and #9; '*GLOBAL*' for platform-wide. Renamed from app_id in PR 1 of AgentCore Registry governance retrofit.

    def is_valid(self) -> bool:
        """
        Check if authority unit is currently in force.

        Returns ``False`` if revoked OR ``expiry_timestamp`` is set and lies in
        the past. Revocation and expiry are independent invalidation sources.
        """
        if self.revoked:
            return False
        if self.expiry_timestamp is not None and time.time() > self.expiry_timestamp:
            return False
        return True


# --- Delegation Edge ---


@dataclass
class DelegationEdge:
    """
    Attenuation relationship between authority units.
    Delegated scope must be a subset of grantor's scope (monotonic).
    """

    edge_id: str
    grantor_unit_id: str
    grantee_agent_id: str
    delegated_scope: AuthorityScope
    allow_redelegation: bool = False
    attenuation_rules: list = field(default_factory=list)


# --- Composition Contract ---


@dataclass
class CompositionContract:
    """
    Governs what happens when two authority domains intersect.
    Four primitives from Article 9: conjunction, disjunction, delegation, precedence.
    """

    contract_id: str
    party_a: str                                # agent_id
    party_b: str                                # agent_id
    authority_precedence: str                   # party_a | party_b | "none"
    invariants: list = field(default_factory=list)
    conflict_resolution: ConflictResolution = ConflictResolution.DEFAULT_DENY
    stop_rights: list = field(default_factory=list)     # agent_ids with unilateral halt
    scope: AuthorityScope = field(default_factory=lambda: AuthorityScope("*", "*"))
    escalation_path: str | None = None          # SNS topic ARN or queue URL


# --- Constitutional Layer ---


@dataclass
class ConstitutionalLayer:
    """
    One level of the constitutional hierarchy:
    global constitution -> domain contracts -> pairwise contracts.
    Evaluated in order: pairwise first, then domain, then global.
    """

    layer_id: str
    layer_type: Literal["global", "domain", "pairwise"]
    applies_to: list = field(default_factory=list)    # agent_ids or domain names
    rules: list = field(default_factory=list)          # deterministic rule set
    parent_layer_id: str | None = None


# --- Dispatch Request (governance engine input) ---


@dataclass
class DispatchRequest:
    """
    What the Arbiter is about to dispatch.
    The governance engine evaluates this before any SQS message is sent.
    """

    requesting_agent_id: str        # "arbiter" for initial dispatch
    target_agent_id: str
    action_type: str                # "invoke_agent" | "execute_tool" | "create_agent"
    domain: str
    workflow_id: str
    agent_use_id: str
    context: dict = field(default_factory=dict)
    agent_input: dict = field(default_factory=dict)


# --- Governance Finding (legibility record) ---


@dataclass
class GovernanceFinding:
    """
    The legibility record produced by every governance evaluation.
    Produced at evaluation time, not reconstructed after.
    Satisfies Article 10: attributable, traceable, interpretable.
    """

    workflow_id: str
    decision: ArbitrationDecision
    requesting_agent: str
    target_agent: str
    reason: str
    finding_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)
    scope_evaluated: str | None = None           # unit_id
    contract_evaluated: str | None = None        # contract_id
    escalation_target: str | None = None
    residual_authority_denial: bool = False

    @classmethod
    def create(
        cls,
        workflow_id: str,
        decision: ArbitrationDecision,
        requesting_agent: str,
        target_agent: str,
        reason: str,
        **kwargs,
    ) -> "GovernanceFinding":
        """Factory that stamps a fresh UUID and current timestamp on the finding."""
        return cls(
            workflow_id=workflow_id,
            decision=decision,
            requesting_agent=requesting_agent,
            target_agent=target_agent,
            reason=reason,
            finding_id=str(uuid.uuid4()),
            timestamp=time.time(),
            **kwargs,
        )


# --- Case Law Entry ---


@dataclass
class CaseLawEntry:
    """
    Encoded resolution from a prior human-adjudicated escalation.
    Once encoded, handled deterministically without re-escalation.

    US-ARB-013: ``encoded_at`` accepts both float (legacy unix-timestamp
    rows already in older test fixtures) and str (ISO-8601 strings written
    by the case-law admin CLI to match the CDK ``CaseLawTable`` schema
    where ``createdAt`` is a string attribute). Downstream consumers must
    not reason about ordering by ``encoded_at`` — ``precedence`` is the
    deterministic ordering key.

    ``revoked`` is the soft-delete flag written by the admin CLI
    (``revoke`` subcommand). The hierarchy loader drops revoked rows at
    load time so they never reach the engine.
    """

    case_id: str
    pattern: dict                   # conditions that identify this conflict class
    resolution: ArbitrationDecision
    encoded_at: str | float
    encoded_by: str                 # human identifier or "auto-promoted"
    scope_of_applicability: dict = field(default_factory=dict)
    precedence: int = 0             # higher = evaluated first
    revoked: bool = False           # US-ARB-013: soft-delete flag (filtered at load)
