/**
 * adaptStateForEngine tests
 *
 * Asserts the wire → engine projection rules called out in the slice
 * spec:
 *   - AuthorityScope.conditions / limits parse from JSON strings to objects
 *   - CompositionContract.conflictResolution string → ConflictResolution enum
 *     (verify all 3 mappings; default for unknown)
 *   - CaseLawEntry.pattern + scopeOfApplicability JSON strings → objects
 *   - ConstitutionalRule.value: JSON-parsed when non-null; null preserved
 *     for exists / not_exists operators
 */

import {
  adaptStateForEngine,
  type AdapterServiceData,
} from '@/hooks/useGovernanceEngine';
import {
  ArbitrationDecision,
  ConflictResolution,
} from '@/lib/governance-engine/models';
import type {
  AuthorityUnit as ServiceAuthorityUnit,
  CompositionContract as ServiceCompositionContract,
  ConstitutionalLayer as ServiceConstitutionalLayer,
  CaseLawEntry as ServiceCaseLawEntry,
} from '@/services/governanceService';

function makeServiceUnit(
  overrides: Partial<ServiceAuthorityUnit> = {},
): ServiceAuthorityUnit {
  return {
    unitId: 'unit-default',
    agentId: 'agent-default',
    scope: {
      decisionType: 'invoke_agent',
      domain: 'payment',
      conditions: '{}',
      limits: '{}',
      specificity: 0,
    },
    delegationSource: null,
    canRedelegate: false,
    expiryTimestamp: null,
    revoked: false,
    riskRating: 'low',
    registryId: null,
    isValid: true,
    ...overrides,
  };
}

function makeServiceContract(
  overrides: Partial<ServiceCompositionContract> = {},
): ServiceCompositionContract {
  return {
    contractId: 'contract-default',
    partyA: 'agent-a',
    partyB: 'agent-b',
    authorityPrecedence: 'agent-a',
    conflictResolution: 'default_deny',
    invariants: [],
    stopRights: [],
    scope: {
      decisionType: '*',
      domain: '*',
      conditions: '{}',
      limits: '{}',
      specificity: 0,
    },
    escalationPath: null,
    ...overrides,
  };
}

function makeServiceLayer(
  overrides: Partial<ServiceConstitutionalLayer> = {},
): ServiceConstitutionalLayer {
  return {
    layerId: 'layer-default',
    layerType: 'global',
    appliesTo: [],
    rules: [],
    parentLayerId: null,
    ...overrides,
  };
}

function makeServiceCase(
  overrides: Partial<ServiceCaseLawEntry> = {},
): ServiceCaseLawEntry {
  return {
    caseId: 'case-default',
    pattern: '{}',
    resolution: 'permit',
    encodedAt: '2026-01-01T00:00:00Z',
    encodedBy: 'human:test',
    scopeOfApplicability: '{}',
    precedence: 0,
    revoked: false,
    ...overrides,
  };
}

function makeData(overrides: Partial<AdapterServiceData> = {}): AdapterServiceData {
  return {
    authorityUnits: [],
    compositionContracts: [],
    constitutionalLayers: [],
    caseLaw: [],
    ...overrides,
  };
}

describe('adaptStateForEngine — AuthorityUnit', () => {
  it('parses scope.conditions JSON string into an object', () => {
    const data = makeData({
      authorityUnits: [
        makeServiceUnit({
          scope: {
            decisionType: 'invoke_agent',
            domain: 'payment',
            conditions: '{"region":"us-east-1","tier":"gold"}',
            limits: '{}',
            specificity: 2,
          },
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.authorityUnits).toHaveLength(1);
    expect(state.authorityUnits[0].scope.conditions).toEqual({
      region: 'us-east-1',
      tier: 'gold',
    });
  });

  it('parses scope.limits JSON string and drops non-numeric values', () => {
    const data = makeData({
      authorityUnits: [
        makeServiceUnit({
          scope: {
            decisionType: '*',
            domain: '*',
            conditions: '{}',
            limits: '{"max_amount":1000,"label":"ignored","fraction":2.5}',
            specificity: 3,
          },
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    // Only the numeric values survive; `label: 'ignored'` is dropped.
    expect(state.authorityUnits[0].scope.limits).toEqual({
      max_amount: 1000,
      fraction: 2.5,
    });
  });

  it('falls back to {} on malformed conditions / limits JSON', () => {
    const data = makeData({
      authorityUnits: [
        makeServiceUnit({
          scope: {
            decisionType: '*',
            domain: '*',
            conditions: 'not json',
            limits: '[1,2,3]', // array, not object — should fall back
            specificity: 0,
          },
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.authorityUnits[0].scope.conditions).toEqual({});
    expect(state.authorityUnits[0].scope.limits).toEqual({});
  });

  it('clamps unrecognised riskRating to low', () => {
    const data = makeData({
      authorityUnits: [makeServiceUnit({ riskRating: 'super-critical' })],
    });
    const state = adaptStateForEngine(data);
    expect(state.authorityUnits[0].riskRating).toBe('low');
  });

  it('preserves recognised riskRating values verbatim', () => {
    const data = makeData({
      authorityUnits: [
        makeServiceUnit({ unitId: 'u-low', riskRating: 'low' }),
        makeServiceUnit({ unitId: 'u-mid', riskRating: 'medium' }),
        makeServiceUnit({ unitId: 'u-high', riskRating: 'high' }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.authorityUnits.map((u) => u.riskRating)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });
});

describe('adaptStateForEngine — CompositionContract.conflictResolution mapping', () => {
  it('maps halt_and_escalate string to ConflictResolution.HALT_AND_ESCALATE', () => {
    const data = makeData({
      compositionContracts: [
        makeServiceContract({ conflictResolution: 'halt_and_escalate' }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.compositionContracts[0].conflictResolution).toBe(
      ConflictResolution.HALT_AND_ESCALATE,
    );
  });

  it('maps default_deny string to ConflictResolution.DEFAULT_DENY', () => {
    const data = makeData({
      compositionContracts: [
        makeServiceContract({ conflictResolution: 'default_deny' }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.compositionContracts[0].conflictResolution).toBe(
      ConflictResolution.DEFAULT_DENY,
    );
  });

  it('maps precedence_resolution string to ConflictResolution.PRECEDENCE_RESOLUTION', () => {
    const data = makeData({
      compositionContracts: [
        makeServiceContract({ conflictResolution: 'precedence_resolution' }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.compositionContracts[0].conflictResolution).toBe(
      ConflictResolution.PRECEDENCE_RESOLUTION,
    );
  });

  it('passes unknown conflictResolution values through (engine falls back to collaborative)', () => {
    const data = makeData({
      compositionContracts: [
        makeServiceContract({ conflictResolution: 'collaborative' }),
      ],
    });
    const state = adaptStateForEngine(data);
    // The pass-through preserves the literal so the engine sees the
    // same string the wire delivered. The engine's evaluate() falls
    // back to collaborative composition for any non-matched value.
    expect(state.compositionContracts[0].conflictResolution).toBe(
      'collaborative',
    );
  });
});

describe('adaptStateForEngine — CaseLawEntry pattern + scope JSON', () => {
  it('parses pattern JSON string into an object', () => {
    const data = makeData({
      caseLaw: [
        makeServiceCase({
          pattern: '{"actionType":"invoke_agent","domain":"payment"}',
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.caseLaw[0].pattern).toEqual({
      actionType: 'invoke_agent',
      domain: 'payment',
    });
  });

  it('parses scopeOfApplicability JSON string into an object', () => {
    const data = makeData({
      caseLaw: [
        makeServiceCase({
          scopeOfApplicability: '{"region":"us-east-1"}',
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.caseLaw[0].scopeOfApplicability).toEqual({
      region: 'us-east-1',
    });
  });

  it('coerces unknown resolution values to DENY (defensive)', () => {
    const data = makeData({
      caseLaw: [
        makeServiceCase({
          // Resolver coerces malformed wire values to 'unknown' — we
          // want the engine to err on the side of denial so a
          // malformed precedent never silently permits.
          resolution: 'unknown',
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.caseLaw[0].resolution).toBe(ArbitrationDecision.DENY);
  });

  it('maps the four canonical resolution strings to their engine enum members', () => {
    const data = makeData({
      caseLaw: [
        makeServiceCase({ caseId: 'p', resolution: 'permit' }),
        makeServiceCase({ caseId: 'd', resolution: 'deny' }),
        makeServiceCase({ caseId: 'e', resolution: 'escalate' }),
        makeServiceCase({ caseId: 'h', resolution: 'halt' }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.caseLaw.map((c) => c.resolution)).toEqual([
      ArbitrationDecision.PERMIT,
      ArbitrationDecision.DENY,
      ArbitrationDecision.ESCALATE,
      ArbitrationDecision.HALT,
    ]);
  });
});

describe('adaptStateForEngine — ConstitutionalRule.value parsing', () => {
  it('JSON-parses non-null values into typed primitives', () => {
    const data = makeData({
      constitutionalLayers: [
        makeServiceLayer({
          rules: [
            { field: 'max_tokens', operator: 'lt', value: '1000' },
            { field: 'tier', operator: 'eq', value: '"gold"' },
            { field: 'config', operator: 'eq', value: '{"region":"us-east-1"}' },
          ],
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    const layer = state.constitutionalLayers[0];
    expect(layer.rules[0].value).toBe(1000);
    expect(layer.rules[1].value).toBe('gold');
    expect(layer.rules[2].value).toEqual({ region: 'us-east-1' });
  });

  it('preserves null value for exists / not_exists operators', () => {
    const data = makeData({
      constitutionalLayers: [
        makeServiceLayer({
          rules: [
            { field: 'risk_signoff', operator: 'exists', value: null },
            { field: 'denylist_match', operator: 'not_exists', value: null },
          ],
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.constitutionalLayers[0].rules[0].value).toBeNull();
    expect(state.constitutionalLayers[0].rules[1].value).toBeNull();
  });

  it('falls back to literal string when wire value is non-JSON', () => {
    const data = makeData({
      constitutionalLayers: [
        makeServiceLayer({
          rules: [
            // 'gold' is not valid JSON (no quotes). The adapter
            // preserves the literal so the engine can still compare it.
            { field: 'tier', operator: 'eq', value: 'gold' },
          ],
        }),
      ],
    });
    const state = adaptStateForEngine(data);
    expect(state.constitutionalLayers[0].rules[0].value).toBe('gold');
  });
});

describe('adaptStateForEngine — empty inputs round-trip', () => {
  it('empty arrays produce an empty engine state', () => {
    const state = adaptStateForEngine(makeData());
    expect(state.authorityUnits).toHaveLength(0);
    expect(state.compositionContracts).toHaveLength(0);
    expect(state.constitutionalLayers).toHaveLength(0);
    expect(state.caseLaw).toHaveLength(0);
  });
});
