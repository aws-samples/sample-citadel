/**
 * Models tests — dataclass + enum invariants and the createFinding factory.
 */

import {
  ArbitrationDecision,
  ConflictResolution,
  ScopeReductionReason,
  createFinding,
  isAuthorityUnitValid,
} from '../models';
import { makeUnit } from './fixtures';

describe('isAuthorityUnitValid', () => {
  it('returns false when revoked is true (clean expiry)', () => {
    const unit = makeUnit({ revoked: true, expiryTimestamp: null });
    expect(isAuthorityUnitValid(unit, 100)).toBe(false);
  });

  it('returns false when expiry is in the past', () => {
    const unit = makeUnit({ revoked: false, expiryTimestamp: 50 });
    expect(isAuthorityUnitValid(unit, 100)).toBe(false);
  });

  it('returns false when both revoked and expired', () => {
    const unit = makeUnit({ revoked: true, expiryTimestamp: 50 });
    expect(isAuthorityUnitValid(unit, 100)).toBe(false);
  });

  it('returns true when not revoked and no expiry set', () => {
    const unit = makeUnit({ revoked: false, expiryTimestamp: null });
    expect(isAuthorityUnitValid(unit, 100)).toBe(true);
  });

  it('returns true when not revoked and expiry is in the future', () => {
    const unit = makeUnit({ revoked: false, expiryTimestamp: 200 });
    expect(isAuthorityUnitValid(unit, 100)).toBe(true);
  });

  it('returns true when expiry equals now (strict > comparison)', () => {
    // Mirrors Python: `time.time() > self.expiry_timestamp` — strict >
    const unit = makeUnit({ revoked: false, expiryTimestamp: 100 });
    expect(isAuthorityUnitValid(unit, 100)).toBe(true);
  });
});

describe('Enum string values match the Python', () => {
  it('ConflictResolution', () => {
    expect(ConflictResolution.HALT_AND_ESCALATE).toBe('halt_and_escalate');
    expect(ConflictResolution.DEFAULT_DENY).toBe('default_deny');
    expect(ConflictResolution.PRECEDENCE_RESOLUTION).toBe('precedence_resolution');
  });

  it('ArbitrationDecision', () => {
    expect(ArbitrationDecision.PERMIT).toBe('permit');
    expect(ArbitrationDecision.DENY).toBe('deny');
    expect(ArbitrationDecision.ESCALATE).toBe('escalate');
    expect(ArbitrationDecision.HALT).toBe('halt');
  });

  it('ScopeReductionReason', () => {
    expect(ScopeReductionReason.UNCONFIRMED_STATE).toBe('unconfirmed_state');
    expect(ScopeReductionReason.DOMAIN_BOUNDARY).toBe('domain_boundary');
    expect(ScopeReductionReason.ATTENUATION).toBe('attenuation');
  });
});

describe('createFinding', () => {
  it('stamps a UUID and an epoch-seconds timestamp', () => {
    const finding = createFinding({
      workflowId: 'wf-1',
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: 'agent-a',
      targetAgent: 'agent-b',
      reason: 'test',
      uuidFactory: () => 'fixed-uuid',
      clock: () => 12345,
    });
    expect(finding.findingId).toBe('fixed-uuid');
    expect(finding.timestamp).toBe(12345);
    expect(finding.workflowId).toBe('wf-1');
    expect(finding.decision).toBe(ArbitrationDecision.PERMIT);
    expect(finding.requestingAgent).toBe('agent-a');
    expect(finding.targetAgent).toBe('agent-b');
    expect(finding.reason).toBe('test');
  });

  it('defaults optional fields to null/false', () => {
    const finding = createFinding({
      workflowId: 'wf-1',
      decision: ArbitrationDecision.DENY,
      requestingAgent: 'agent-a',
      targetAgent: 'agent-b',
      reason: 'test',
      uuidFactory: () => 'u',
      clock: () => 1,
    });
    expect(finding.scopeEvaluated).toBeNull();
    expect(finding.contractEvaluated).toBeNull();
    expect(finding.escalationTarget).toBeNull();
    expect(finding.residualAuthorityDenial).toBe(false);
  });

  it('uses default uuid factory when not provided (UUID-shaped string)', () => {
    const finding = createFinding({
      workflowId: 'wf-1',
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: 'a',
      targetAgent: 'b',
      reason: 'test',
      clock: () => 1,
    });
    // RFC4122 v4-ish: 8-4-4-4-12 hex with version nibble 4 in pos 14.
    expect(finding.findingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('uses default clock when not provided (positive number)', () => {
    const finding = createFinding({
      workflowId: 'wf-1',
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: 'a',
      targetAgent: 'b',
      reason: 'test',
      uuidFactory: () => 'u',
    });
    expect(typeof finding.timestamp).toBe('number');
    expect(finding.timestamp).toBeGreaterThan(0);
  });
});
