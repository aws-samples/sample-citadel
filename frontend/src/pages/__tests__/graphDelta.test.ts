/**
 * graphDelta unit tests
 */

import { computeGraphDelta } from '../governance/graphDelta';
import type {
  AuthorityUnit,
  CompositionContract,
} from '../../services/governanceService';

function makeUnit(unitId: string, agentId: string): AuthorityUnit {
  return {
    unitId,
    agentId,
    scope: {
      decisionType: '*',
      domain: '*',
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
  };
}

function makeContract(
  contractId: string,
  partyA: string,
  partyB: string,
): CompositionContract {
  return {
    contractId,
    partyA,
    partyB,
    authorityPrecedence: partyA,
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
  };
}

describe('computeGraphDelta', () => {
  test('empty inputs return empty sets', () => {
    const delta = computeGraphDelta([], [], [], []);
    expect(delta.addedUnits.size).toBe(0);
    expect(delta.removedUnits.size).toBe(0);
    expect(delta.addedContracts.size).toBe(0);
    expect(delta.removedContracts.size).toBe(0);
    expect(delta.addedAgents.size).toBe(0);
    expect(delta.removedAgents.size).toBe(0);
  });

  test('unit added: appears in addedUnits, not in removedUnits', () => {
    const snapshot = [makeUnit('u-old', 'agent-a')];
    const current = [
      makeUnit('u-old', 'agent-a'),
      makeUnit('u-new', 'agent-a'),
    ];
    const delta = computeGraphDelta(snapshot, [], current, []);
    expect(delta.addedUnits.has('u-new')).toBe(true);
    expect(delta.addedUnits.has('u-old')).toBe(false);
    expect(delta.removedUnits.has('u-new')).toBe(false);
  });

  test('unit removed: appears in removedUnits, not in addedUnits', () => {
    const snapshot = [
      makeUnit('u-old', 'agent-a'),
      makeUnit('u-gone', 'agent-b'),
    ];
    const current = [makeUnit('u-old', 'agent-a')];
    const delta = computeGraphDelta(snapshot, [], current, []);
    expect(delta.removedUnits.has('u-gone')).toBe(true);
    expect(delta.addedUnits.has('u-gone')).toBe(false);
  });

  test('unit unchanged: in neither set', () => {
    const u = makeUnit('u-1', 'agent-a');
    const delta = computeGraphDelta([u], [], [u], []);
    expect(delta.addedUnits.size).toBe(0);
    expect(delta.removedUnits.size).toBe(0);
  });

  test('contracts: same logic as units', () => {
    const snapshot = [makeContract('c-old', 'a', 'b')];
    const current = [
      makeContract('c-old', 'a', 'b'),
      makeContract('c-new', 'a', 'b'),
    ];
    const delta = computeGraphDelta([], snapshot, [], current);
    expect(delta.addedContracts.has('c-new')).toBe(true);
    expect(delta.removedContracts.has('c-new')).toBe(false);

    const reverseDelta = computeGraphDelta([], current, [], snapshot);
    expect(reverseDelta.removedContracts.has('c-new')).toBe(true);
    expect(reverseDelta.addedContracts.has('c-new')).toBe(false);
  });

  test('agents derived from union of unit.agentId + contract.partyA/B', () => {
    const snapshot = [makeUnit('u-1', 'agent-a')];
    const snapshotContracts = [makeContract('c-1', 'agent-a', 'agent-b')];
    const current = [makeUnit('u-1', 'agent-a')];
    const currentContracts = [
      makeContract('c-1', 'agent-a', 'agent-b'),
      // New contract introduces 'agent-c' — must surface as addedAgents.
      makeContract('c-2', 'agent-a', 'agent-c'),
    ];
    const delta = computeGraphDelta(
      snapshot,
      snapshotContracts,
      current,
      currentContracts,
    );
    expect(delta.addedAgents.has('agent-c')).toBe(true);
    expect(delta.addedAgents.has('agent-a')).toBe(false);
    expect(delta.addedAgents.has('agent-b')).toBe(false);
  });

  test('agent removed (no longer referenced by any unit or contract)', () => {
    const snapshot = [
      makeUnit('u-1', 'agent-a'),
      makeUnit('u-2', 'agent-x'),
    ];
    const current = [makeUnit('u-1', 'agent-a')];
    const delta = computeGraphDelta(snapshot, [], current, []);
    expect(delta.removedAgents.has('agent-x')).toBe(true);
    expect(delta.removedAgents.has('agent-a')).toBe(false);
  });

  test('non-overlapping sets: no agent appears in both addedAgents and removedAgents', () => {
    const snapshot = [makeUnit('u-1', 'agent-only-snapshot')];
    const current = [makeUnit('u-2', 'agent-only-current')];
    const delta = computeGraphDelta(snapshot, [], current, []);
    for (const a of delta.addedAgents) {
      expect(delta.removedAgents.has(a)).toBe(false);
    }
    for (const a of delta.removedAgents) {
      expect(delta.addedAgents.has(a)).toBe(false);
    }
  });

  test('skips empty agent ids when deriving from contract parties', () => {
    const snapshotContracts = [makeContract('c-empty', '', 'agent-b')];
    const currentContracts = [makeContract('c-empty', '', 'agent-b')];
    const delta = computeGraphDelta(
      [],
      snapshotContracts,
      [],
      currentContracts,
    );
    expect(delta.addedAgents.has('')).toBe(false);
    expect(delta.removedAgents.has('')).toBe(false);
  });
});
