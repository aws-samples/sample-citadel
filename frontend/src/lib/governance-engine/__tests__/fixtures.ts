/**
 * Hand-built fixtures for the governance-engine TS port. Every fixture has
 * a JSDoc comment describing the canonical Python behaviour it mirrors.
 *
 * The Python equivalents live in `arbiter/governance/__tests__/`; the TS
 * port matches by construction — this file does NOT depend on Python at
 * runtime.
 */

import {
  ArbitrationDecision,
  ConflictResolution,
  type AuthorityScope,
  type AuthorityUnit,
  type CaseLawEntry,
  type CompositionContract,
  type ConstitutionalLayer,
  type DispatchRequest,
  type GovernanceState,
} from '../models';

// ---------------------------------------------------------------------------
// Time + UUID — frozen for deterministic finding output
// ---------------------------------------------------------------------------

export const FROZEN_NOW = 1_700_000_000;
export const FROZEN_UUID = '00000000-0000-4000-8000-000000000000';

export function frozenClock(): number {
  return FROZEN_NOW;
}

export function frozenUuidFactory(): string {
  return FROZEN_UUID;
}

/** Counter-based factory for tests that need distinct IDs in one engine run. */
export function makeCountingUuidFactory(): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function makeScope(overrides: Partial<AuthorityScope> = {}): AuthorityScope {
  return {
    decisionType: '*',
    domain: '*',
    conditions: {},
    limits: {},
    ...overrides,
  };
}

export function makeUnit(overrides: Partial<AuthorityUnit> = {}): AuthorityUnit {
  return {
    unitId: 'unit-default',
    agentId: 'agent-default',
    scope: makeScope(),
    delegationSource: null,
    canRedelegate: false,
    expiryTimestamp: null,
    revoked: false,
    riskRating: 'low',
    registryId: null,
    ...overrides,
  };
}

export function makeContract(
  overrides: Partial<CompositionContract> = {},
): CompositionContract {
  return {
    contractId: 'contract-default',
    partyA: 'agent-a',
    partyB: 'agent-b',
    authorityPrecedence: 'agent-a',
    invariants: [],
    conflictResolution: ConflictResolution.DEFAULT_DENY,
    stopRights: [],
    scope: makeScope(),
    escalationPath: null,
    ...overrides,
  };
}

export function makeRequest(
  overrides: Partial<DispatchRequest> = {},
): DispatchRequest {
  return {
    requestingAgentId: 'agent-a',
    targetAgentId: 'agent-b',
    actionType: 'invoke_agent',
    domain: 'payment',
    workflowId: 'wf-1',
    agentUseId: 'use-1',
    context: {},
    agentInput: {},
    ...overrides,
  };
}

export function makeCase(overrides: Partial<CaseLawEntry> = {}): CaseLawEntry {
  return {
    caseId: 'case-default',
    pattern: {},
    resolution: ArbitrationDecision.PERMIT,
    encodedAt: 0,
    encodedBy: 'human:test',
    scopeOfApplicability: {},
    precedence: 0,
    revoked: false,
    ...overrides,
  };
}

export function makeLayer(
  overrides: Partial<ConstitutionalLayer> = {},
): ConstitutionalLayer {
  return {
    layerId: 'layer-default',
    layerType: 'global',
    appliesTo: [],
    rules: [],
    parentLayerId: null,
    ...overrides,
  };
}

export function makeState(overrides: Partial<GovernanceState> = {}): GovernanceState {
  return {
    authorityUnits: [],
    compositionContracts: [],
    caseLaw: [],
    constitutionalLayers: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cross-language fidelity fixtures
// ---------------------------------------------------------------------------

/**
 * Fixture 1 — Residual denial.
 *
 * Python equivalent: `arbiter/governance/__tests__/test_engine.py` —
 * any test whose state has no covering unit; `evaluate` returns DENY
 * with `reason='residual_authority_denial:no_scope_covers_action'` and
 * `residual_authority_denial=True`.
 */
export function fixtureResidualDenial(): {
  state: GovernanceState;
  request: DispatchRequest;
} {
  return {
    state: makeState({ authorityUnits: [] }),
    request: makeRequest(),
  };
}

/**
 * Fixture 2 — Single-domain permit.
 *
 * Python equivalent: a single covering unit, no contract, no layers.
 * `evaluate` returns PERMIT with `reason='scope_match:<unit_id>'` and
 * `scope_evaluated=<unit_id>`.
 */
export function fixtureSingleDomainPermit(): {
  state: GovernanceState;
  request: DispatchRequest;
} {
  const unit = makeUnit({
    unitId: 'unit-payment-a',
    agentId: 'agent-a',
    scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
  });
  return {
    state: makeState({ authorityUnits: [unit] }),
    request: makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
  };
}

/**
 * Fixture 3 — Case-law match, PERMIT resolution.
 *
 * Python equivalent: a case-law entry whose pattern matches the request;
 * `evaluate` returns the case-law resolution with `reason='case_law:<case_id>'`.
 * The PERMIT is then run through constitutional review (none configured,
 * so no override).
 */
export function fixtureCaseLawPermit(): {
  state: GovernanceState;
  request: DispatchRequest;
} {
  const entry = makeCase({
    caseId: 'case-payment-precedent',
    pattern: { actionType: 'invoke_agent', domain: 'payment' },
    resolution: ArbitrationDecision.PERMIT,
    precedence: 100,
  });
  return {
    state: makeState({ caseLaw: [entry] }),
    request: makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
  };
}

/**
 * Fixture 4 — Rivalrous claim, winner permits.
 *
 * Python equivalent: PRECEDENCE_RESOLUTION contract where
 * `authority_precedence == requesting_agent_id`; both parties have
 * covering units; state confirmed; `evaluate` returns PERMIT with
 * `reason='rivalrous_claim:winner=<w>:loser=<l>:attenuation'`.
 */
export function fixtureRivalrousClaimWinnerPermits(): {
  state: GovernanceState;
  request: DispatchRequest;
} {
  const requesterUnit = makeUnit({
    unitId: 'unit-a',
    agentId: 'agent-a',
    scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
  });
  const targetUnit = makeUnit({
    unitId: 'unit-b',
    agentId: 'agent-b',
    scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
  });
  const contract = makeContract({
    contractId: 'contract-rivalrous',
    partyA: 'agent-a',
    partyB: 'agent-b',
    authorityPrecedence: 'agent-a',
    conflictResolution: ConflictResolution.PRECEDENCE_RESOLUTION,
  });
  return {
    state: makeState({
      authorityUnits: [requesterUnit, targetUnit],
      compositionContracts: [contract],
    }),
    request: makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
  };
}

/**
 * Fixture 5 — Collaborative composition, one denies.
 *
 * Python equivalent: contract with neither HALT_AND_ESCALATE,
 * DEFAULT_DENY, nor PRECEDENCE_RESOLUTION (any other value falls through
 * to collaborative composition). Requester has a covering unit, target
 * does NOT — so `target_permits` is false → DENY with
 * `reason='collaborative_composition:conjunction_failed'`.
 *
 * In the TS port, `ConflictResolution` is an enum with three members; to
 * exercise the "any other" branch we use a string literal that is NOT
 * one of the known members, cast through `unknown` to bypass the enum
 * type. This matches the Python branch where conflict_resolution may be
 * an unrecognised value.
 */
export function fixtureCollaborativeOneDeny(): {
  state: GovernanceState;
  request: DispatchRequest;
} {
  const requesterUnit = makeUnit({
    unitId: 'unit-a',
    agentId: 'agent-a',
    scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
  });
  // No target unit → target_permits=false → conjunction fails.
  const contract = makeContract({
    contractId: 'contract-collab',
    partyA: 'agent-a',
    partyB: 'agent-b',
    authorityPrecedence: 'none',
    // 'collaborative' is not a member of ConflictResolution; the engine's
    // dispatch falls through to collaborativeComposition. Cast keeps the
    // public interface honest — patterns.ts is the unit under test.
    conflictResolution: 'collaborative' as unknown as ConflictResolution,
  });
  return {
    state: makeState({
      authorityUnits: [requesterUnit],
      compositionContracts: [contract],
    }),
    request: makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
  };
}

// ---------------------------------------------------------------------------
// Smoke test — Jest's `**/__tests__/**/*.ts` glob picks this file up, so a
// single sanity-check spec keeps the file lint-clean. Each fixture is
// exercised end-to-end via the engine and asserted to produce the decision
// documented in its JSDoc — this also catches drift between fixture
// builders and the engine without re-implementing the cross-language
// fidelity tests in the dedicated suites.
// ---------------------------------------------------------------------------

if (typeof describe === 'function') {
  // Lazy-import to avoid a top-of-file circular dep on the engine module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { evaluate } = require('../engine') as typeof import('../engine');
  describe('fixtures — smoke', () => {
    const opts = { clock: frozenClock, uuidFactory: makeCountingUuidFactory() };
    it('residual-denial fixture produces DENY', () => {
      const { state, request } = fixtureResidualDenial();
      const f = evaluate(state, request, opts);
      expect(f.decision).toBe(ArbitrationDecision.DENY);
      expect(f.residualAuthorityDenial).toBe(true);
    });
    it('single-domain-permit fixture produces PERMIT', () => {
      const { state, request } = fixtureSingleDomainPermit();
      const f = evaluate(state, request, opts);
      expect(f.decision).toBe(ArbitrationDecision.PERMIT);
    });
    it('case-law-permit fixture produces PERMIT via case_law reason', () => {
      const { state, request } = fixtureCaseLawPermit();
      const f = evaluate(state, request, opts);
      expect(f.decision).toBe(ArbitrationDecision.PERMIT);
      expect(f.reason).toMatch(/^case_law:/);
    });
    it('rivalrous-claim fixture produces PERMIT (winner permits)', () => {
      const { state, request } = fixtureRivalrousClaimWinnerPermits();
      const f = evaluate(state, request, opts);
      expect(f.decision).toBe(ArbitrationDecision.PERMIT);
      expect(f.reason).toMatch(/^rivalrous_claim:winner=/);
    });
    it('collaborative-one-deny fixture produces DENY', () => {
      const { state, request } = fixtureCollaborativeOneDeny();
      const f = evaluate(state, request, opts);
      expect(f.decision).toBe(ArbitrationDecision.DENY);
      expect(f.reason).toBe('collaborative_composition:conjunction_failed');
    });
  });
}
