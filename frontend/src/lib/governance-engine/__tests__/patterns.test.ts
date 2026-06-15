/**
 * Patterns tests — the four arbitration patterns.
 *
 * Tests exercise the helpers directly via the engine (which is the only
 * caller in production). For unconfirmed-state cases we set
 * `request.context['unconfirmed_X']` where X is in the authority unit's
 * scope conditions or limits; the engine's `_isStateConfirmed` returns
 * false → the pattern's first branch fires.
 */

import { evaluate } from '../engine';
import { ArbitrationDecision, ConflictResolution } from '../models';
import {
  frozenClock,
  makeContract,
  makeCountingUuidFactory,
  makeRequest,
  makeScope,
  makeState,
  makeUnit,
} from './fixtures';

describe('Pattern 1 — Deferred Authority (HALT_AND_ESCALATE)', () => {
  function buildState() {
    const unitA = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const unitB = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-b',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const contract = makeContract({
      contractId: 'contract-defer',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: 'none',
      conflictResolution: ConflictResolution.HALT_AND_ESCALATE,
      escalationPath: 'arn:aws:sns:::escalation',
    });
    return makeState({
      authorityUnits: [unitA, unitB],
      compositionContracts: [contract],
    });
  }

  it('both permit + state confirmed → PERMIT', () => {
    const state = buildState();
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('deferred_authority:both_permit');
    expect(finding.contractEvaluated).toBe('contract-defer');
  });

  it('one denies (target lacks coverage) → ESCALATE with escalation_target', () => {
    const state = buildState();
    // Strip target unit so target_permits=false.
    state.authorityUnits = state.authorityUnits.filter((u) => u.agentId !== 'agent-b');
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.ESCALATE);
    expect(finding.reason).toBe('deferred_authority:conflict:halt_and_escalate');
    expect(finding.escalationTarget).toBe('arn:aws:sns:::escalation');
  });

  it('unconfirmed state → DENY with unconfirmed_state reason', () => {
    const state = buildState();
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: {
          region: 'us-east-1',
          unconfirmed_region: true,
        },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('deferred_authority:unconfirmed_state');
  });
});

describe('Pattern 2 — Unilateral Sovereignty (DEFAULT_DENY)', () => {
  function buildState(opts: { sovereign: string; includeTarget: boolean }) {
    const unitA = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const unitB = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-b',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const contract = makeContract({
      contractId: 'contract-sovereign',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: opts.sovereign,
      conflictResolution: ConflictResolution.DEFAULT_DENY,
    });
    const units = opts.includeTarget ? [unitA, unitB] : [unitA];
    return makeState({
      authorityUnits: units,
      compositionContracts: [contract],
    });
  }

  it('sovereign is requester and permits → PERMIT', () => {
    const state = buildState({ sovereign: 'agent-a', includeTarget: true });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('unilateral_sovereignty:sovereign=agent-a');
  });

  it('sovereign is target and target denies (no covering unit) → DENY', () => {
    const state = buildState({ sovereign: 'agent-b', includeTarget: false });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('unilateral_sovereignty:sovereign=agent-b');
  });

  it('sovereign is neither requester nor target → DENY', () => {
    const state = buildState({ sovereign: 'agent-c', includeTarget: true });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('unilateral_sovereignty:sovereign=agent-c');
  });

  it('unconfirmed state → DENY with unconfirmed_state reason', () => {
    const state = buildState({ sovereign: 'agent-a', includeTarget: true });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: {
          region: 'us-east-1',
          unconfirmed_region: true,
        },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('unilateral_sovereignty:unconfirmed_state');
  });
});

describe('Pattern 3 — Rivalrous Claim (PRECEDENCE_RESOLUTION)', () => {
  function buildState(opts: { winner: string }) {
    const unitA = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const unitB = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-b',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const contract = makeContract({
      contractId: 'contract-rivalrous',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: opts.winner,
      conflictResolution: ConflictResolution.PRECEDENCE_RESOLUTION,
    });
    return makeState({
      authorityUnits: [unitA, unitB],
      compositionContracts: [contract],
    });
  }

  it('winner permits → PERMIT with attenuation reason', () => {
    const state = buildState({ winner: 'agent-a' });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe(
      'rivalrous_claim:winner=agent-a:loser=agent-b:attenuation',
    );
  });

  it('winner denies (no covering unit) → DENY', () => {
    const state = buildState({ winner: 'agent-a' });
    state.authorityUnits = state.authorityUnits.filter((u) => u.agentId !== 'agent-a');
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    // Without requester unit we residual-deny earlier (step 4); the
    // pattern is unreachable. Reaching here at all means the engine
    // short-circuits at step 4 — verify that.
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.residualAuthorityDenial).toBe(true);
  });

  it('winner is target and target denies → DENY (rivalrous reason)', () => {
    const state = buildState({ winner: 'agent-b' });
    state.authorityUnits = state.authorityUnits.filter((u) => u.agentId !== 'agent-b');
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe(
      'rivalrous_claim:winner=agent-b:loser=agent-a:attenuation',
    );
  });

  it('no named winner → DENY with no_precedence_winner reason', () => {
    const state = buildState({ winner: 'agent-c' });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('rivalrous_claim:no_precedence_winner');
  });

  it('unconfirmed state → DENY with unconfirmed_state reason', () => {
    const state = buildState({ winner: 'agent-a' });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: {
          region: 'us-east-1',
          unconfirmed_region: true,
        },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('rivalrous_claim:unconfirmed_state');
  });
});

describe('Pattern 4 — Collaborative Composition (any other conflict_resolution)', () => {
  function buildState(opts: { includeTarget: boolean }) {
    const unitA = makeUnit({
      unitId: 'unit-a',
      agentId: 'agent-a',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const unitB = makeUnit({
      unitId: 'unit-b',
      agentId: 'agent-b',
      scope: makeScope({
        decisionType: 'invoke_agent',
        domain: 'payment',
        conditions: { region: 'us-east-1' },
      }),
    });
    const contract = makeContract({
      contractId: 'contract-collab',
      partyA: 'agent-a',
      partyB: 'agent-b',
      authorityPrecedence: 'none',
      // String literal not in ConflictResolution → falls through to
      // collaborative composition.
      conflictResolution: 'collaborative' as unknown as ConflictResolution,
    });
    const units = opts.includeTarget ? [unitA, unitB] : [unitA];
    return makeState({
      authorityUnits: units,
      compositionContracts: [contract],
    });
  }

  it('both permit + state confirmed → PERMIT', () => {
    const state = buildState({ includeTarget: true });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.reason).toBe('collaborative_composition:both_permit');
  });

  it('one denies (target missing) → DENY with conjunction_failed', () => {
    const state = buildState({ includeTarget: false });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: { region: 'us-east-1' },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('collaborative_composition:conjunction_failed');
  });

  it('unconfirmed state → DENY with unconfirmed_state reason', () => {
    const state = buildState({ includeTarget: true });
    const finding = evaluate(
      state,
      makeRequest({
        actionType: 'invoke_agent',
        domain: 'payment',
        context: {
          region: 'us-east-1',
          unconfirmed_region: true,
        },
      }),
      { clock: frozenClock, uuidFactory: makeCountingUuidFactory() },
    );
    expect(finding.decision).toBe(ArbitrationDecision.DENY);
    expect(finding.reason).toBe('collaborative_composition:unconfirmed_state');
  });
});
