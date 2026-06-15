/**
 * tracer-decompose tests
 *
 * 5 hand-built findings covering each terminal step:
 *   1. case-law match
 *   2. residual-authority denial
 *   3. single-domain permit (scope_match)
 *   4. composition arbitration (rivalrous_claim with attenuation suffix)
 *   5. constitutional override
 *
 * Each test asserts the terminal step number + the per-step status array
 * + the constitutionalOverride / arbitrationPattern / scopeReduction
 * derived fields. Cross-checked against the backend resolver
 * (backend/src/lambda/governance-ui-resolver.ts → buildSteps); a future
 * slice will add a contract test asserting both produce identical output.
 */

import {
  ArbitrationDecision,
  type GovernanceFinding,
} from '@/lib/governance-engine/models';
import {
  decomposeFinding,
  PIPELINE_STEPS,
} from '@/pages/governance/tracerDecompose';

function makeFinding(overrides: Partial<GovernanceFinding> = {}): GovernanceFinding {
  return {
    findingId: 'f-1',
    workflowId: 'wf-1',
    decision: ArbitrationDecision.PERMIT,
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    reason: 'scope_match:unit-1',
    timestamp: 1_700_000_000,
    scopeEvaluated: 'unit-1',
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    ...overrides,
  };
}

function statusOf(
  trace: ReturnType<typeof decomposeFinding>,
  stepNumber: number,
): string {
  return trace.steps[stepNumber - 1].status;
}

describe('PIPELINE_STEPS', () => {
  it('declares 8 steps in order', () => {
    expect(PIPELINE_STEPS).toHaveLength(8);
    PIPELINE_STEPS.forEach((step, idx) => {
      expect(step.stepNumber).toBe(idx + 1);
      expect(typeof step.name).toBe('string');
      expect(step.name.length).toBeGreaterThan(0);
    });
  });
});

describe('decomposeFinding — case-law terminal (step 1)', () => {
  const finding = makeFinding({
    decision: ArbitrationDecision.PERMIT,
    reason: 'case_law:case-payment-precedent',
  });
  const trace = decomposeFinding(finding);

  it('terminal is step 1', () => {
    expect(trace.terminalStepNumber).toBe(1);
  });

  it('step 1 is matched, all other non-2 steps are skipped', () => {
    expect(statusOf(trace, 1)).toBe('matched');
    expect(statusOf(trace, 2)).toBe('pass-through');
    expect(statusOf(trace, 3)).toBe('skipped');
    expect(statusOf(trace, 4)).toBe('skipped');
    expect(statusOf(trace, 5)).toBe('skipped');
    expect(statusOf(trace, 6)).toBe('skipped');
    expect(statusOf(trace, 7)).toBe('skipped');
    expect(statusOf(trace, 8)).toBe('skipped');
  });

  it('step 1 outputs surfaces the case_id', () => {
    const step1 = trace.steps[0];
    expect(step1.outputs).not.toBeNull();
    expect(JSON.parse(step1.outputs as string).case_id).toBe(
      'case-payment-precedent',
    );
  });

  it('arbitrationPattern + scopeReduction null; constitutionalOverride false', () => {
    expect(trace.arbitrationPattern).toBeNull();
    expect(trace.scopeReduction).toBeNull();
    expect(trace.constitutionalOverride).toBe(false);
  });
});

describe('decomposeFinding — residual-authority denial terminal (step 4)', () => {
  const finding = makeFinding({
    decision: ArbitrationDecision.DENY,
    reason: 'residual_authority_denial:no_scope_covers_action',
    residualAuthorityDenial: true,
    scopeEvaluated: null,
  });
  const trace = decomposeFinding(finding);

  it('terminal is step 4', () => {
    expect(trace.terminalStepNumber).toBe(4);
  });

  it('steps 1/3 pass-through/matched and step 4 denied', () => {
    expect(statusOf(trace, 1)).toBe('pass-through');
    expect(statusOf(trace, 3)).toBe('matched');
    expect(statusOf(trace, 4)).toBe('denied');
    expect(statusOf(trace, 5)).toBe('skipped');
    expect(statusOf(trace, 6)).toBe('skipped');
    expect(statusOf(trace, 7)).toBe('skipped');
    expect(statusOf(trace, 8)).toBe('skipped');
  });

  it('step 4 outputs surfaces decision: deny', () => {
    const step4 = trace.steps[3];
    expect(step4.outputs).not.toBeNull();
    expect(JSON.parse(step4.outputs as string).decision).toBe('deny');
  });
});

describe('decomposeFinding — single-domain permit terminal (step 7)', () => {
  const finding = makeFinding({
    decision: ArbitrationDecision.PERMIT,
    reason: 'scope_match:unit-payment-a',
    scopeEvaluated: 'unit-payment-a',
  });
  const trace = decomposeFinding(finding);

  it('terminal is step 7', () => {
    expect(trace.terminalStepNumber).toBe(7);
  });

  it('steps 1/3/4/5/6 pass-through/matched and step 7 permitted', () => {
    expect(statusOf(trace, 1)).toBe('pass-through');
    expect(statusOf(trace, 3)).toBe('matched');
    expect(statusOf(trace, 4)).toBe('pass-through');
    expect(statusOf(trace, 5)).toBe('matched');
    expect(statusOf(trace, 6)).toBe('pass-through');
    expect(statusOf(trace, 7)).toBe('permitted');
    expect(statusOf(trace, 8)).toBe('skipped');
  });

  it('step 7 outputs carries scope_evaluated', () => {
    const step7 = trace.steps[6];
    expect(step7.outputs).not.toBeNull();
    const parsed = JSON.parse(step7.outputs as string);
    expect(parsed.decision).toBe('permit');
    expect(parsed.scope_evaluated).toBe('unit-payment-a');
  });
});

describe('decomposeFinding — composition arbitration terminal (step 6)', () => {
  const finding = makeFinding({
    decision: ArbitrationDecision.PERMIT,
    reason: 'rivalrous_claim:winner=agent-a:loser=agent-b:attenuation',
    scopeEvaluated: 'unit-a',
    contractEvaluated: 'contract-rivalrous',
  });
  const trace = decomposeFinding(finding);

  it('terminal is step 6', () => {
    expect(trace.terminalStepNumber).toBe(6);
  });

  it('arbitrationPattern detected as rivalrous_claim', () => {
    expect(trace.arbitrationPattern).toBe('rivalrous_claim');
  });

  it('scopeReduction detected as attenuation suffix', () => {
    expect(trace.scopeReduction).toBe('attenuation');
  });

  it('steps 1/3/4/5 pass-through/matched and step 6 matched', () => {
    expect(statusOf(trace, 1)).toBe('pass-through');
    expect(statusOf(trace, 3)).toBe('matched');
    expect(statusOf(trace, 4)).toBe('pass-through');
    expect(statusOf(trace, 5)).toBe('matched');
    expect(statusOf(trace, 6)).toBe('matched');
    expect(statusOf(trace, 7)).toBe('skipped');
    expect(statusOf(trace, 8)).toBe('skipped');
  });

  it('step 6 outputs carries the contract id + arbitration metadata', () => {
    const step6 = trace.steps[5];
    expect(step6.outputs).not.toBeNull();
    const parsed = JSON.parse(step6.outputs as string);
    expect(parsed.contract_evaluated).toBe('contract-rivalrous');
    expect(parsed.arbitrationPattern).toBe('rivalrous_claim');
    expect(parsed.scopeReduction).toBe('attenuation');
  });

  it('unconfirmed_state suffix maps to scope reduction', () => {
    const altFinding = makeFinding({
      decision: ArbitrationDecision.DENY,
      reason: 'collaborative_composition:unconfirmed_state',
      contractEvaluated: 'contract-collab',
    });
    const altTrace = decomposeFinding(altFinding);
    expect(altTrace.terminalStepNumber).toBe(6);
    expect(altTrace.arbitrationPattern).toBe('collaborative_composition');
    expect(altTrace.scopeReduction).toBe('unconfirmed_state');
    expect(statusOf(altTrace, 6)).toBe('denied');
  });
});

describe('decomposeFinding — constitutional override terminal (step 8)', () => {
  const finding = makeFinding({
    decision: ArbitrationDecision.DENY,
    reason: 'constitutional_review:layer-global:invariant_violated:max_tokens',
  });
  const trace = decomposeFinding(finding);

  it('terminal is step 8', () => {
    expect(trace.terminalStepNumber).toBe(8);
  });

  it('constitutionalOverride is true', () => {
    expect(trace.constitutionalOverride).toBe(true);
  });

  it('intermediate steps 1/3/4/5/6/7 are pass-through and step 8 is overridden', () => {
    expect(statusOf(trace, 1)).toBe('pass-through');
    expect(statusOf(trace, 3)).toBe('pass-through');
    expect(statusOf(trace, 4)).toBe('pass-through');
    expect(statusOf(trace, 5)).toBe('pass-through');
    expect(statusOf(trace, 6)).toBe('pass-through');
    expect(statusOf(trace, 7)).toBe('pass-through');
    expect(statusOf(trace, 8)).toBe('overridden');
  });

  it('step 8 outputs surfaces override layer and field', () => {
    const step8 = trace.steps[7];
    expect(step8.outputs).not.toBeNull();
    const parsed = JSON.parse(step8.outputs as string);
    expect(parsed.override_layer).toBe('layer-global');
    expect(parsed.override_field).toBe('max_tokens');
    expect(parsed.decision).toBe('deny');
  });

  it('reasonTokens preserves the colon-split sequence', () => {
    expect(trace.reasonTokens).toEqual([
      'constitutional_review',
      'layer-global',
      'invariant_violated',
      'max_tokens',
    ]);
  });
});

describe('decomposeFinding — projected finding shape', () => {
  it('coerces engine ArbitrationDecision enum value to string in trace.finding', () => {
    const finding = makeFinding({
      decision: ArbitrationDecision.ESCALATE,
      reason: 'deferred_authority:conflict:halt_and_escalate',
      contractEvaluated: 'contract-x',
    });
    const trace = decomposeFinding(finding);
    expect(typeof trace.finding.decision).toBe('string');
    expect(trace.finding.decision).toBe('escalate');
  });
});
