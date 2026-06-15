/**
 * Engine tests — the 8-step pipeline.
 */

import { GovernanceEngine, evaluate } from '../engine';
import { ArbitrationDecision, ConflictResolution } from '../models';
import {
  fixtureCaseLawPermit,
  fixtureResidualDenial,
  fixtureSingleDomainPermit,
  frozenClock,
  makeCase,
  makeContract,
  makeLayer,
  makeRequest,
  makeScope,
  makeState,
  makeUnit,
  makeCountingUuidFactory,
} from './fixtures';

describe('GovernanceEngine — Step 1: case-law', () => {
  it('returns case-law finding when pattern matches', () => {
    const { state, request } = fixtureCaseLawPermit();
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('case_law:case-payment-precedent');
  });

  it('iterates case law in precedence-descending order', () => {
    const lowPrec = makeCase({
      caseId: 'low',
      pattern: { actionType: 'invoke_agent' },
      resolution: ArbitrationDecision.DENY,
      precedence: 1,
    });
    const highPrec = makeCase({
      caseId: 'high',
      pattern: { actionType: 'invoke_agent' },
      resolution: ArbitrationDecision.PERMIT,
      precedence: 100,
    });
    // Insert low first, high second; engine should sort by precedence desc
    // and pick `high` (PERMIT).
    const state = makeState({ caseLaw: [lowPrec, highPrec] });
    const finding = evaluate(state, makeRequest(), {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('case_law:high');
  });

  it('PERMIT case law passes through constitutional review and is overridden', () => {
    const { state, request } = fixtureCaseLawPermit();
    state.constitutionalLayers = [
      makeLayer({
        layerId: 'global-constitution',
        rules: [
          { field: 'risk_signoff', operator: 'exists', value: null },
        ],
      }),
    ];
    // request.context lacks `risk_signoff` → exists violated → DENY override.
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe(
      'constitutional_review:global-constitution:invariant_violated:risk_signoff',
    );
  });

  it('non-PERMIT case law does NOT run constitutional review', () => {
    const denyCase = makeCase({
      caseId: 'deny-case',
      pattern: { actionType: 'invoke_agent' },
      resolution: ArbitrationDecision.DENY,
      precedence: 1,
    });
    const state = makeState({
      caseLaw: [denyCase],
      constitutionalLayers: [
        makeLayer({
          rules: [{ field: 'risk_signoff', operator: 'exists', value: null }],
        }),
      ],
    });
    const finding = evaluate(state, makeRequest(), {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('case_law:deny-case');
  });
});

describe('GovernanceEngine — Step 4: residual denial', () => {
  it('returns DENY when no covering unit', () => {
    const { state, request } = fixtureResidualDenial();
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('residual_authority_denial:no_scope_covers_action');
    expect(finding.residualAuthorityDenial).toBe(true);
  });
});

describe('GovernanceEngine — Step 5: tightest-scope selection', () => {
  it('higher specificity wins', () => {
    const broad = makeUnit({
      unitId: 'unit-broad',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: '*', domain: '*' }),
    });
    const narrow = makeUnit({
      unitId: 'unit-narrow',
      agentId: 'agent-a',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
        limits: { amount: 100 },
      }),
    });
    const state = makeState({ authorityUnits: [broad, narrow] });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1', amount: 50 },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.scopeEvaluated).toBe('unit-narrow');
    expect(finding.reason).toBe('scope_match:unit-narrow');
  });

  it('tie-break on equal specificity: lex-smaller unitId wins', () => {
    const unitB = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
    });
    const unitA = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
    });
    // Insertion order puts 'unit-b' first, but lex-smaller 'unit-a' must win.
    const state = makeState({ authorityUnits: [unitB, unitA] });
    const finding = evaluate(
      state,
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.scopeEvaluated).toBe('unit-a');
  });
});

describe('GovernanceEngine — Step 7: single-domain permit', () => {
  it('returns PERMIT with scope_match reason when no contract', () => {
    const { state, request } = fixtureSingleDomainPermit();
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('scope_match:unit-payment-a');
    expect(finding.scopeEvaluated).toBe('unit-payment-a');
  });
});

describe('GovernanceEngine — Step 8: constitutional override on single-domain permit', () => {
  it('preserves scope_evaluated from the overridden permit', () => {
    const { state, request } = fixtureSingleDomainPermit();
    state.constitutionalLayers = [
      makeLayer({
        layerId: 'global-constitution',
        rules: [
          { field: 'amount', operator: 'lt', value: 100 },
        ],
      }),
    ];
    request.context = { amount: 200 };
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe(
      'constitutional_review:global-constitution:invariant_violated:amount',
    );
    // Override preserves scope_evaluated from the permit being overridden.
    expect(finding.scopeEvaluated).toBe('unit-payment-a');
  });
});

describe('GovernanceEngine — covering-unit edge cases', () => {
  it('wildcard agent_id == "*" units are included in the covering set', () => {
    const platformWide = makeUnit({
      unitId: 'unit-platform',
      agentId: '*',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
    });
    const state = makeState({ authorityUnits: [platformWide] });
    const finding = evaluate(
      state,
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.scopeEvaluated).toBe('unit-platform');
  });

  it('expired unit is NOT in the covering set', () => {
    const expired = makeUnit({
      unitId: 'unit-expired',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
      expiryTimestamp: 100,
    });
    const state = makeState({ authorityUnits: [expired] });
    const finding = evaluate(
      state,
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
      { clock: () => 200, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.residualAuthorityDenial).toBe(true);
  });

  it('revoked unit is NOT in the covering set', () => {
    const revoked = makeUnit({
      unitId: 'unit-revoked',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
      revoked: true,
    });
    const state = makeState({ authorityUnits: [revoked] });
    const finding = evaluate(
      state,
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.residualAuthorityDenial).toBe(true);
  });
});

describe('GovernanceEngine — class instantiation', () => {
  it('can be reused across requests without state mutation', () => {
    const unit = makeUnit({
      unitId: 'unit-x',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
    });
    const engine = new GovernanceEngine(
      makeState({ authorityUnits: [unit] }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    const f1 = engine.evaluate(
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
    );
    const f2 = engine.evaluate(
      makeRequest({ actionType: 'invoke_agent', domain: 'payment' }),
    );
    expect(f1.decision).toBe(ArbitrationDecision.PERMIT);
    expect(f2.decision).toBe(ArbitrationDecision.PERMIT);
    // Distinct finding IDs from the counting factory
    expect(f1.findingId).not.toBe(f2.findingId);
  });
});

describe('GovernanceEngine — composition + scope edge cases', () => {
  it('contract via direct agent-pair takes precedence over domain-pair fallback', () => {
    const requesterUnit = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'payment' }),
    });
    const targetUnit = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-b',
      scope: makeScope({ decisionType: 'invoke_agent', domain: 'fraud' }),
    });
    const directContract = makeContract({
      contractId: 'contract-direct',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: 'agent-a',
      conflictResolution: ConflictResolution.PRECEDENCE_RESOLUTION,
    });
    const domainContract = makeContract({
      contractId: 'contract-domain',
      partyA: 'payment',
      partyB: 'fraud',
      authorityPrecedence: 'payment',
      conflictResolution: ConflictResolution.DEFAULT_DENY,
    });
    const state = makeState({
      authorityUnits: [requesterUnit, targetUnit],
      compositionContracts: [directContract, domainContract],
    });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        requestingAgentId: 'agent-a',
        targetAgentId: 'agent-b',
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    // Direct contract is rivalrous; agent-a wins; finding cites that contract.
    expect(finding.contractEvaluated).toBe('contract-direct');
  });
});
