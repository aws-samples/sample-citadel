/**
 * CIT-123 slice 1 (data/type only): optional per-node `compensation` block.
 *
 * Covers the TS type guard `isCompensationBlock` and the extension of
 * `isWorkflowNodeDefinition` to accept an optional, well-formed
 * `compensation` block and reject a malformed one. No renderer/executor
 * behaviour — template syntax validation lives on the Python side
 * (`normalize_compensation_block` in arbiter/common/workflow_contract.py).
 */
import {
  isCompensationBlock,
  isWorkflowNodeDefinition,
  type WorkflowNodeDefinition,
} from '../workflow';

const baseNode = {
  id: 'node-1',
  agentId: 'agent-1',
  position: { x: 0, y: 0 },
  configuration: {},
};

describe('isCompensationBlock', () => {
  it('accepts a well-formed block with tool + args', () => {
    expect(
      isCompensationBlock({ tool: 'close_ticket', args: { ticketId: '${output.ticketId}' } })
    ).toBe(true);
  });

  it('accepts an explicit sideEffecting boolean', () => {
    expect(isCompensationBlock({ tool: 'noop', args: {}, sideEffecting: false })).toBe(true);
  });

  it('rejects a missing tool', () => {
    expect(isCompensationBlock({ args: {} })).toBe(false);
  });

  it('rejects an empty-string tool', () => {
    expect(isCompensationBlock({ tool: '', args: {} })).toBe(false);
  });

  it('rejects a non-string tool', () => {
    expect(isCompensationBlock({ tool: 123, args: {} })).toBe(false);
  });

  it('rejects a missing args', () => {
    expect(isCompensationBlock({ tool: 'close_ticket' })).toBe(false);
  });

  it('rejects a non-object args', () => {
    expect(isCompensationBlock({ tool: 'close_ticket', args: 'nope' })).toBe(false);
  });

  it('rejects an array args', () => {
    expect(isCompensationBlock({ tool: 'close_ticket', args: [] })).toBe(false);
  });

  it('rejects a non-boolean sideEffecting', () => {
    expect(isCompensationBlock({ tool: 'close_ticket', args: {}, sideEffecting: 'yes' })).toBe(
      false
    );
  });

  it('rejects null and non-objects', () => {
    expect(isCompensationBlock(null)).toBe(false);
    expect(isCompensationBlock('not-an-object')).toBe(false);
  });
});

describe('isWorkflowNodeDefinition with optional compensation', () => {
  it('accepts a node with no compensation key (absent-block equivalence)', () => {
    expect(isWorkflowNodeDefinition(baseNode)).toBe(true);
  });

  it('accepts a node with a well-formed compensation block', () => {
    const node: WorkflowNodeDefinition = {
      ...baseNode,
      compensation: { tool: 'close_ticket', args: { ticketId: '${output.ticketId}' } },
    };
    expect(isWorkflowNodeDefinition(node)).toBe(true);
  });

  it('rejects a node whose compensation block is malformed', () => {
    const node = { ...baseNode, compensation: { args: {} } };
    expect(isWorkflowNodeDefinition(node)).toBe(false);
  });

  it('rejects a node whose compensation block is not an object', () => {
    const node = { ...baseNode, compensation: 'not-a-block' };
    expect(isWorkflowNodeDefinition(node)).toBe(false);
  });
});
