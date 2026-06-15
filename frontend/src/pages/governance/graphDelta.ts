/**
 * Authority graph delta helpers
 *
 * Pure functions used by the time scrubber to surface what was added
 * vs removed between a historical snapshot and the live (current)
 * authority graph. Kept in a separate module so the logic can be
 * unit-tested in isolation from the React component.
 *
 * Direction convention:
 *   * `addedX` = present in CURRENT but not in SNAPSHOT (added since
 *     the snapshot was captured).
 *   * `removedX` = present in SNAPSHOT but not in CURRENT (removed
 *     between the snapshot capture and now).
 *
 * The graph view renders the SNAPSHOT data as the primary
 * scene; "added since" units / contracts / agents may be overlaid as
 * faded ghost markers when the operator turns on `Show delta vs Now`.
 */

import type {
  AuthorityUnit,
  CompositionContract,
} from '../../services/governanceService';

export interface GraphDelta {
  /** unitId present in current but not snapshot. */
  addedUnits: Set<string>;
  /** unitId present in snapshot but not current. */
  removedUnits: Set<string>;
  /** contractId present in current but not snapshot. */
  addedContracts: Set<string>;
  /** contractId present in snapshot but not current. */
  removedContracts: Set<string>;
  /** agentId derived from unit.agentId + contract.partyA/B. */
  addedAgents: Set<string>;
  removedAgents: Set<string>;
}

/**
 * Derive the union of agent IDs from a unit list + contract list.
 * Matches the graph builder semantics: every unit's
 * `agentId` and every contract's `partyA` / `partyB` is an agent
 * node candidate.
 */
function deriveAgentIds(
  units: AuthorityUnit[],
  contracts: CompositionContract[],
): Set<string> {
  const ids = new Set<string>();
  for (const u of units) {
    if (u.agentId && u.agentId.length > 0) ids.add(u.agentId);
  }
  for (const c of contracts) {
    if (c.partyA && c.partyA.length > 0) ids.add(c.partyA);
    if (c.partyB && c.partyB.length > 0) ids.add(c.partyB);
  }
  return ids;
}

/**
 * Compute the per-set diff between a historical snapshot's units +
 * contracts and the current (live) data.
 *
 * The function is pure: equal inputs always produce equal Sets. It
 * does NOT compare deeper than identifiers — a unit whose `unitId`
 * is the same in both inputs but whose scope changed is treated as
 * UNCHANGED. intentionally limits delta highlighting to
 * presence/absence; field-level diff is out of scope.
 */
export function computeGraphDelta(
  snapshotUnits: AuthorityUnit[],
  snapshotContracts: CompositionContract[],
  currentUnits: AuthorityUnit[],
  currentContracts: CompositionContract[],
): GraphDelta {
  const snapshotUnitIds = new Set(snapshotUnits.map((u) => u.unitId));
  const currentUnitIds = new Set(currentUnits.map((u) => u.unitId));
  const snapshotContractIds = new Set(
    snapshotContracts.map((c) => c.contractId),
  );
  const currentContractIds = new Set(
    currentContracts.map((c) => c.contractId),
  );
  const snapshotAgents = deriveAgentIds(snapshotUnits, snapshotContracts);
  const currentAgents = deriveAgentIds(currentUnits, currentContracts);

  const addedUnits = new Set<string>();
  for (const id of currentUnitIds) {
    if (!snapshotUnitIds.has(id)) addedUnits.add(id);
  }
  const removedUnits = new Set<string>();
  for (const id of snapshotUnitIds) {
    if (!currentUnitIds.has(id)) removedUnits.add(id);
  }
  const addedContracts = new Set<string>();
  for (const id of currentContractIds) {
    if (!snapshotContractIds.has(id)) addedContracts.add(id);
  }
  const removedContracts = new Set<string>();
  for (const id of snapshotContractIds) {
    if (!currentContractIds.has(id)) removedContracts.add(id);
  }
  const addedAgents = new Set<string>();
  for (const id of currentAgents) {
    if (!snapshotAgents.has(id)) addedAgents.add(id);
  }
  const removedAgents = new Set<string>();
  for (const id of snapshotAgents) {
    if (!currentAgents.has(id)) removedAgents.add(id);
  }

  return {
    addedUnits,
    removedUnits,
    addedContracts,
    removedContracts,
    addedAgents,
    removedAgents,
  };
}
