/**
 * Maps execution subscription data to per-node status for canvas badges.
 *
 * Pure function — no side effects, no hooks, no React dependency.
 * Consumed by AgentBlueprints to merge `executionStatus` into node data.
 */

import type { NodeResultEntry } from '../components/ExecutionOverlay';
import type { WorkflowNode } from '../types/workflow';

export type NodeExecutionStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

/**
 * Normalise the subscription's raw status (which includes 'unreachable')
 * into the badge-friendly status set.
 */
function normaliseStatus(raw: NodeResultEntry['status']): NodeExecutionStatus {
  if (raw === 'unreachable' || raw === 'skipped') return 'skipped';
  if (raw === 'running' || raw === 'completed' || raw === 'failed' || raw === 'pending') return raw;
  return 'pending';
}

/**
 * Derive a per-node execution status map from the subscription's nodeResults
 * and the current canvas nodes.
 *
 * - Nodes present in `nodeResults` get their status mapped (unreachable → skipped).
 * - Nodes on the canvas but absent from `nodeResults` get 'pending'.
 * - Unknown nodeResult entries (id not on canvas) are silently dropped.
 */
export function mapExecutionToNodeStatus(
  nodeResults: Record<string, NodeResultEntry>,
  nodes: WorkflowNode[],
): Record<string, NodeExecutionStatus> {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const result: Record<string, NodeExecutionStatus> = {};

  // Mark every canvas node as pending by default
  for (const node of nodes) {
    result[node.id] = 'pending';
  }

  // Override with actual subscription statuses (drop unknown ids)
  for (const [nodeId, entry] of Object.entries(nodeResults)) {
    if (nodeIds.has(nodeId)) {
      result[nodeId] = normaliseStatus(entry.status);
    }
  }

  return result;
}

/**
 * Build a compact human-readable summary of execution progress.
 *
 * Examples:
 *   'Running step 2 of 4'
 *   'Completed 3/4, 1 skipped'
 *   'Failed at Router'
 *   'Completed'
 *   'Pending'
 */
export function executionSummaryText(
  statusMap: Record<string, NodeExecutionStatus>,
  nodes: WorkflowNode[],
): string {
  const entries = Object.entries(statusMap);
  const total = entries.length;
  if (total === 0) return '';

  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  let firstFailedId: string | null = null;
  let runningIndex = -1;

  for (let i = 0; i < entries.length; i++) {
    const [nodeId, status] = entries[i];
    switch (status) {
      case 'completed':
        completed++;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'failed':
        failed++;
        if (!firstFailedId) firstFailedId = nodeId;
        break;
      case 'running':
        running++;
        if (runningIndex < 0) runningIndex = i;
        break;
      default:
        pending++;
    }
  }

  // Failed — name the first failed node
  if (failed > 0 && firstFailedId) {
    const node = nodes.find((n) => n.id === firstFailedId);
    const label = node?.data?.label ?? firstFailedId;
    return `Failed at ${label}`;
  }

  // Running — show step position
  if (running > 0) {
    // Step number = completed + current running position (1-indexed)
    const stepNumber = completed + 1;
    return `Running step ${stepNumber} of ${total}`;
  }

  // All pending
  if (pending === total) return 'Pending';

  // Terminal: completed (possibly with skips)
  if (skipped > 0) {
    return `Completed ${completed}/${total}, ${skipped} skipped`;
  }

  return 'Completed';
}
