/**
 * Constitutional review tests — six operators + override semantics.
 */

import { evaluate } from '../engine';
import { ArbitrationDecision } from '../models';
import {
  fixtureSingleDomainPermit,
  frozenClock,
  makeCountingUuidFactory,
  makeLayer,
} from './fixtures';

function runWith(
  context: Record<string, unknown>,
  rules: ReadonlyArray<{ field: string; operator: string; value: unknown }>,
) {
  const { state, request } = fixtureSingleDomainPermit();
  state.constitutionalLayers = [
    makeLayer({ layerId: 'layer-1', rules: rules.map((r) => ({ ...r })) }),
  ];
  request.context = { ...context };
  return evaluate(state, request, {
    clock: frozenClock,
    uuidFactory: makeCountingUuidFactory(),
  });
}

describe('Constitutional review — eq operator', () => {
  it('actual === expected does NOT violate', () => {
    const f = runWith({ tier: 'gold' }, [
      { field: 'tier', operator: 'eq', value: 'gold' },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('actual !== expected violates', () => {
    const f = runWith({ tier: 'silver' }, [
      { field: 'tier', operator: 'eq', value: 'gold' },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
    expect(f.reason).toBe('constitutional_review:layer-1:invariant_violated:tier');
  });

  it('missing actual (undefined → null) violates eq with non-null expected', () => {
    const f = runWith({}, [{ field: 'tier', operator: 'eq', value: 'gold' }]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });
});

describe('Constitutional review — neq operator', () => {
  it('actual === expected violates', () => {
    const f = runWith({ tier: 'gold' }, [
      { field: 'tier', operator: 'neq', value: 'gold' },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('actual !== expected does NOT violate', () => {
    const f = runWith({ tier: 'silver' }, [
      { field: 'tier', operator: 'neq', value: 'gold' },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });
});

describe('Constitutional review — exists operator', () => {
  it('present (non-null) does NOT violate', () => {
    const f = runWith({ risk_signoff: 'human:abc' }, [
      { field: 'risk_signoff', operator: 'exists', value: null },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('missing violates', () => {
    const f = runWith({}, [
      { field: 'risk_signoff', operator: 'exists', value: null },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('explicit null violates', () => {
    const f = runWith({ risk_signoff: null }, [
      { field: 'risk_signoff', operator: 'exists', value: null },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });
});

describe('Constitutional review — not_exists operator', () => {
  it('missing does NOT violate', () => {
    const f = runWith({}, [
      { field: 'override', operator: 'not_exists', value: null },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('present violates', () => {
    const f = runWith({ override: true }, [
      { field: 'override', operator: 'not_exists', value: null },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });
});

describe('Constitutional review — gt operator', () => {
  it('actual > expected does NOT violate', () => {
    const f = runWith({ score: 80 }, [
      { field: 'score', operator: 'gt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('actual === expected violates (strict >)', () => {
    const f = runWith({ score: 70 }, [
      { field: 'score', operator: 'gt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('actual < expected violates', () => {
    const f = runWith({ score: 50 }, [
      { field: 'score', operator: 'gt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('missing actual violates', () => {
    const f = runWith({}, [{ field: 'score', operator: 'gt', value: 70 }]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });
});

describe('Constitutional review — lt operator', () => {
  it('actual < expected does NOT violate', () => {
    const f = runWith({ score: 50 }, [
      { field: 'score', operator: 'lt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('actual === expected violates (strict <)', () => {
    const f = runWith({ score: 70 }, [
      { field: 'score', operator: 'lt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('actual > expected violates', () => {
    const f = runWith({ score: 80 }, [
      { field: 'score', operator: 'lt', value: 70 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });

  it('missing actual violates', () => {
    const f = runWith({}, [{ field: 'score', operator: 'lt', value: 70 }]);
    expect(f.decision).toBe(ArbitrationDecision.DENY);
  });
});

describe('Constitutional review — unknown operator', () => {
  it('treated as non-violation (PERMIT preserved)', () => {
    const f = runWith({ x: 1 }, [
      { field: 'x', operator: 'mystery_op', value: 1 },
    ]);
    expect(f.decision).toBe(ArbitrationDecision.PERMIT);
  });

  it('invokes the warn callback if provided', () => {
    const { state, request } = fixtureSingleDomainPermit();
    state.constitutionalLayers = [
      makeLayer({
        layerId: 'layer-1',
        rules: [{ field: 'x', operator: 'mystery_op', value: 1 }],
      }),
    ];
    request.context = { x: 1 };
    const messages: string[] = [];
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
      unknownOperatorWarn: (m) => messages.push(m),
    });
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('mystery_op');
    expect(messages[0]).toContain('layer-1');
  });
});

describe('Constitutional review — multi-layer + ordering', () => {
  it('first violated rule across all layers wins', () => {
    const { state, request } = fixtureSingleDomainPermit();
    state.constitutionalLayers = [
      makeLayer({
        layerId: 'layer-first',
        rules: [
          { field: 'a', operator: 'eq', value: 1 },
          { field: 'b', operator: 'eq', value: 2 }, // would also violate
        ],
      }),
      makeLayer({
        layerId: 'layer-second',
        rules: [{ field: 'c', operator: 'eq', value: 3 }],
      }),
    ];
    request.context = { a: 999, b: 999, c: 999 };
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe(
      'constitutional_review:layer-first:invariant_violated:a',
    );
  });

  it('no layers → no override', () => {
    const { state, request } = fixtureSingleDomainPermit();
    state.constitutionalLayers = [];
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
  });
});

describe('Constitutional review — override preserves provenance', () => {
  it('preserves scope_evaluated + contract_evaluated from the overridden permit', () => {
    const { state, request } = fixtureSingleDomainPermit();
    state.constitutionalLayers = [
      makeLayer({
        layerId: 'layer-1',
        rules: [{ field: 'tier', operator: 'eq', value: 'gold' }],
      }),
    ];
    request.context = { tier: 'silver' };
    const finding = evaluate(state, request, {
      clock: frozenClock,
      uuidFactory: makeCountingUuidFactory(),
    });
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    // Permit had scope_evaluated='unit-payment-a', contract_evaluated=null.
    expect(finding.scopeEvaluated).toBe('unit-payment-a');
    expect(finding.contractEvaluated).toBeNull();
  });
});
