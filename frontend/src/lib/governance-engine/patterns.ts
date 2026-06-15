/**
 * The four arbitration patterns from "The Arbitration Patterns" companion.
 *
 * TypeScript port of the `_deferred_authority`, `_unilateral_sovereignty`,
 * `_rivalrous_claim`, and `_collaborative_composition` helpers in
 * `arbiter/governance/engine.py`. Reason strings match the Python verbatim.
 *
 * All functions are pure: state is passed in, a finding is returned. No I/O.
 */

import {
  ArbitrationDecision,
  ScopeReductionReason,
  createFinding,
  type AuthorityUnit,
  type CompositionContract,
  type DispatchRequest,
  type GovernanceFinding,
} from './models';

export interface PatternDeps {
  uuidFactory: () => string;
  clock: () => number;
}

export interface PatternInputs {
  request: DispatchRequest;
  contract: CompositionContract;
  bestUnit: AuthorityUnit;
  targetUnits: AuthorityUnit[];
  requesterPermits: boolean;
  targetPermits: boolean;
  stateConfirmed: boolean;
}

// ---------------------------------------------------------------------------
// Pattern 1: Deferred Authority (HALT_AND_ESCALATE)
// ---------------------------------------------------------------------------

/**
 * Both parties must PERMIT and state must be confirmed; otherwise escalate.
 * UNCONFIRMED_STATE forces a monotonic reduction to DENY.
 */
export function deferredAuthority(
  inputs: PatternInputs,
  deps: PatternDeps,
): GovernanceFinding {
  const { request, contract, bestUnit, requesterPermits, targetPermits, stateConfirmed } =
    inputs;

  if (!stateConfirmed) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.DENY,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: `deferred_authority:${ScopeReductionReason.UNCONFIRMED_STATE}`,
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  if (requesterPermits && targetPermits) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: 'deferred_authority:both_permit',
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  return createFinding({
    workflowId: request.workflowId,
    decision: ArbitrationDecision.ESCALATE,
    requestingAgent: request.requestingAgentId,
    targetAgent: request.targetAgentId,
    reason: 'deferred_authority:conflict:halt_and_escalate',
    scopeEvaluated: bestUnit.unitId,
    contractEvaluated: contract.contractId,
    escalationTarget: contract.escalationPath,
    uuidFactory: deps.uuidFactory,
    clock: deps.clock,
  });
}

// ---------------------------------------------------------------------------
// Pattern 2: Unilateral Sovereignty (DEFAULT_DENY)
// ---------------------------------------------------------------------------

/**
 * The sovereign (`contract.authorityPrecedence`) decides alone. Others
 * defer. Unconfirmed state forces a monotonic reduction to DENY.
 * Sovereign neither requester nor target → DENY.
 */
export function unilateralSovereignty(
  inputs: PatternInputs,
  deps: PatternDeps,
): GovernanceFinding {
  const {
    request,
    contract,
    bestUnit,
    targetUnits,
    requesterPermits,
    targetPermits,
    stateConfirmed,
  } = inputs;

  if (!stateConfirmed) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.DENY,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: `unilateral_sovereignty:${ScopeReductionReason.UNCONFIRMED_STATE}`,
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  const sovereign = contract.authorityPrecedence;
  let decision: ArbitrationDecision;
  let scopeEvaluated: string | null;

  if (sovereign === request.requestingAgentId) {
    decision = requesterPermits ? ArbitrationDecision.PERMIT : ArbitrationDecision.DENY;
    scopeEvaluated = bestUnit.unitId;
  } else if (sovereign === request.targetAgentId) {
    decision = targetPermits ? ArbitrationDecision.PERMIT : ArbitrationDecision.DENY;
    scopeEvaluated = targetUnits.length > 0 ? targetUnits[0].unitId : null;
  } else {
    decision = ArbitrationDecision.DENY;
    scopeEvaluated = bestUnit.unitId;
  }

  return createFinding({
    workflowId: request.workflowId,
    decision,
    requestingAgent: request.requestingAgentId,
    targetAgent: request.targetAgentId,
    reason: `unilateral_sovereignty:sovereign=${sovereign}`,
    scopeEvaluated,
    contractEvaluated: contract.contractId,
    uuidFactory: deps.uuidFactory,
    clock: deps.clock,
  });
}

// ---------------------------------------------------------------------------
// Pattern 3: Rivalrous Claim (PRECEDENCE_RESOLUTION)
// ---------------------------------------------------------------------------

/**
 * Higher-precedence party wins; loser is attenuated. Precedence is read
 * from `contract.authorityPrecedence`. Unconfirmed state forces a
 * monotonic reduction to DENY. No named winner → DENY.
 */
export function rivalrousClaim(
  inputs: PatternInputs,
  deps: PatternDeps,
): GovernanceFinding {
  const {
    request,
    contract,
    bestUnit,
    targetUnits,
    requesterPermits,
    targetPermits,
    stateConfirmed,
  } = inputs;

  if (!stateConfirmed) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.DENY,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: `rivalrous_claim:${ScopeReductionReason.UNCONFIRMED_STATE}`,
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  const winner = contract.authorityPrecedence;
  let decision: ArbitrationDecision;
  let scopeEvaluated: string | null;
  let loser: string;

  if (winner === request.requestingAgentId) {
    decision = requesterPermits ? ArbitrationDecision.PERMIT : ArbitrationDecision.DENY;
    scopeEvaluated = bestUnit.unitId;
    loser = request.targetAgentId;
  } else if (winner === request.targetAgentId) {
    decision = targetPermits ? ArbitrationDecision.PERMIT : ArbitrationDecision.DENY;
    scopeEvaluated = targetUnits.length > 0 ? targetUnits[0].unitId : null;
    loser = request.requestingAgentId;
  } else {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.DENY,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: 'rivalrous_claim:no_precedence_winner',
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  return createFinding({
    workflowId: request.workflowId,
    decision,
    requestingAgent: request.requestingAgentId,
    targetAgent: request.targetAgentId,
    reason:
      `rivalrous_claim:winner=${winner}:loser=${loser}:` +
      `${ScopeReductionReason.ATTENUATION}`,
    scopeEvaluated,
    contractEvaluated: contract.contractId,
    uuidFactory: deps.uuidFactory,
    clock: deps.clock,
  });
}

// ---------------------------------------------------------------------------
// Pattern 4: Collaborative Composition (any other conflict_resolution)
// ---------------------------------------------------------------------------

/**
 * State-gated conjunction: both must permit AND state must be confirmed.
 * Unconfirmed state forces a monotonic reduction to DENY.
 */
export function collaborativeComposition(
  inputs: PatternInputs,
  deps: PatternDeps,
): GovernanceFinding {
  const { request, contract, bestUnit, requesterPermits, targetPermits, stateConfirmed } =
    inputs;

  if (!stateConfirmed) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.DENY,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: `collaborative_composition:${ScopeReductionReason.UNCONFIRMED_STATE}`,
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  if (requesterPermits && targetPermits) {
    return createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: 'collaborative_composition:both_permit',
      scopeEvaluated: bestUnit.unitId,
      contractEvaluated: contract.contractId,
      uuidFactory: deps.uuidFactory,
      clock: deps.clock,
    });
  }

  return createFinding({
    workflowId: request.workflowId,
    decision: ArbitrationDecision.DENY,
    requestingAgent: request.requestingAgentId,
    targetAgent: request.targetAgentId,
    reason: 'collaborative_composition:conjunction_failed',
    scopeEvaluated: bestUnit.unitId,
    contractEvaluated: contract.contractId,
    uuidFactory: deps.uuidFactory,
    clock: deps.clock,
  });
}
