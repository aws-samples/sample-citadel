/**
 * mapExecutionToNodeStatus — TDD Red Phase
 *
 * Tests for the pure mapper that converts execution subscription data
 * into per-node execution statuses for canvas badges.
 */

import '@testing-library/jest-dom';
import type { NodeResultEntry } from '../../components/ExecutionOverlay';
import type { WorkflowNode } from '../../types/workflow';
import {
  mapExecutionToNodeStatus,
  executionSummaryText,
  type NodeExecutionStatus,
} from '../../services/mapExecutionToNodeStatus';

/** Helper to build a minimal WorkflowNode */
function makeNode(id: string, label = id): WorkflowNode {
  return {
    id,
    type: 'agentNode',
    position: { x: 0, y: 0 },
    data: {
      agentId: `agent-${id}`,
      agentConfig: { agentId: `agent-${id}`, name: label, config: {}, state: 'active' as const },
      label,
      inputCount: 1,
      outputCount: 1,
    },
  };
}

describe('mapExecutionToNodeStatus', () => {
  const nodes: WorkflowNode[] = [
    makeNode('router', 'Router'),
    makeNode('branch-true', 'Branch True'),
    makeNode('branch-false', 'Branch False'),
    makeNode('merger', 'Merger'),
  ];

  it('maps completed nodes to completed', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'completed', output: '{}', error: null },
      'branch-false': { status: 'completed', output: '{}', error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map).toEqual({
      router: 'completed',
      'branch-true': 'completed',
      'branch-false': 'completed',
      merger: 'completed',
    });
  });

  it('maps running node to running', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'running', output: null, error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map.router).toBe('completed');
    expect(map['branch-true']).toBe('running');
    // Nodes not yet reached are pending
    expect(map['branch-false']).toBe('pending');
    expect(map.merger).toBe('pending');
  });

  it('maps skipped nodes to skipped', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'completed', output: '{}', error: null },
      'branch-false': { status: 'skipped', output: null, error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map['branch-false']).toBe('skipped');
  });

  it('maps unreachable nodes to skipped', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'completed', output: '{}', error: null },
      'branch-false': { status: 'unreachable', output: null, error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map['branch-false']).toBe('skipped');
  });

  it('maps failed nodes to failed', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'failed', output: null, error: 'timeout' },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map['branch-true']).toBe('failed');
  });

  it('maps pending nodes to pending', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'pending', output: null, error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map.router).toBe('pending');
  });

  it('drops unknown node ids not present on canvas', () => {
    const results: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'unknown-node': { status: 'completed', output: '{}', error: null },
    };
    const map = mapExecutionToNodeStatus(results, nodes);
    expect(map).not.toHaveProperty('unknown-node');
  });

  it('returns empty map when no nodes and no results', () => {
    const map = mapExecutionToNodeStatus({}, []);
    expect(map).toEqual({});
  });

  it('marks all canvas nodes as pending when results is empty', () => {
    const map = mapExecutionToNodeStatus({}, nodes);
    for (const node of nodes) {
      expect(map[node.id]).toBe('pending');
    }
  });
});

describe('executionSummaryText', () => {
  const nodes: WorkflowNode[] = [
    makeNode('router', 'Router'),
    makeNode('branch-true', 'Branch True'),
    makeNode('branch-false', 'Branch False'),
    makeNode('merger', 'Merger'),
  ];

  it('shows "Running step N of M" when one node is running', () => {
    const statusMap: Record<string, NodeExecutionStatus> = {
      router: 'completed',
      'branch-true': 'running',
      'branch-false': 'pending',
      merger: 'pending',
    };
    const text = executionSummaryText(statusMap, nodes);
    expect(text).toBe('Running step 2 of 4');
  });

  it('shows completed count and skipped count', () => {
    const statusMap: Record<string, NodeExecutionStatus> = {
      router: 'completed',
      'branch-true': 'completed',
      'branch-false': 'skipped',
      merger: 'completed',
    };
    const text = executionSummaryText(statusMap, nodes);
    expect(text).toBe('Completed 3/4, 1 skipped');
  });

  it('shows "Completed" when all nodes completed', () => {
    const statusMap: Record<string, NodeExecutionStatus> = {
      router: 'completed',
      'branch-true': 'completed',
      'branch-false': 'completed',
      merger: 'completed',
    };
    const text = executionSummaryText(statusMap, nodes);
    expect(text).toBe('Completed');
  });

  it('shows "Failed at <label>" for the first failed node', () => {
    const statusMap: Record<string, NodeExecutionStatus> = {
      router: 'completed',
      'branch-true': 'failed',
      'branch-false': 'pending',
      merger: 'pending',
    };
    const text = executionSummaryText(statusMap, nodes);
    expect(text).toBe('Failed at Branch True');
  });

  it('shows pending state for all-pending', () => {
    const statusMap: Record<string, NodeExecutionStatus> = {
      router: 'pending',
      'branch-true': 'pending',
      'branch-false': 'pending',
      merger: 'pending',
    };
    const text = executionSummaryText(statusMap, nodes);
    expect(text).toBe('Pending');
  });

  it('returns empty string for empty map', () => {
    const text = executionSummaryText({}, []);
    expect(text).toBe('');
  });
});
