/**
 * AgentNode — execution status badge rendering
 * TDD Red Phase
 *
 * Tests that each execution status renders the correct badge with
 * accessible aria-labels, icons, and border tints.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Stub ReactFlow so AgentNode can mount in JSDOM
jest.mock('@xyflow/react', () => ({
  Handle: ({ 'aria-label': al, ...rest }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': `handle-${rest.id}`, 'aria-label': al }),
  Position: { Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({
    setNodes: jest.fn(),
    setEdges: jest.fn(),
  }),
}));

// Stub lucide-react icons used by AgentNode
jest.mock('lucide-react', () => ({
  Trash2: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'trash-icon', ...props }),
  Settings: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'settings-icon', ...props }),
  CheckCircle2: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'check-icon', ...props }),
  XCircle: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'x-icon', ...props }),
  MinusCircle: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'minus-icon', ...props }),
  Loader2: (props: Record<string, unknown>) => React.createElement('svg', { 'data-testid': 'loader-icon', ...props }),
}));

// Stub ui components
jest.mock('../ui/card', () => ({
  Card: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', rest, children),
}));
jest.mock('../ui/button', () => ({
  Button: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('button', rest, children),
}));
jest.mock('../ResourceBadge', () => ({
  ResourceBadge: () => null,
}));

import { AgentNode } from '../AgentNode';
import type { AgentNodeData, WorkflowNode } from '../../types/workflow';
import type { NodeProps } from '@xyflow/react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- memo wrapping changes the component type; cast once here
const AgentNodeCmp = AgentNode as React.ComponentType<NodeProps<WorkflowNode>>;

function makeData(overrides: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    agentId: 'a1',
    agentConfig: { agentId: 'a1', name: 'Test Agent', config: {}, state: 'active' as const },
    label: 'Test Agent',
    inputCount: 1,
    outputCount: 1,
    ...overrides,
  };
}

describe('AgentNode execution status badge', () => {
  it('renders a spinner badge with aria-label "Running" when executionStatus is running', () => {
    const data = makeData({ executionStatus: 'running' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const badge = screen.getByLabelText('Running');
    expect(badge).toBeInTheDocument();
    // Should have animate-spin class (or contain a spinning element)
    expect(badge.className || badge.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders a green check badge with aria-label "Completed" when executionStatus is completed', () => {
    const data = makeData({ executionStatus: 'completed' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const badge = screen.getByLabelText('Completed');
    expect(badge).toBeInTheDocument();
  });

  it('renders a red X badge with aria-label "Failed" when executionStatus is failed', () => {
    const data = makeData({ executionStatus: 'failed' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const badge = screen.getByLabelText('Failed');
    expect(badge).toBeInTheDocument();
  });

  it('renders a muted skip badge with aria-label "Skipped" when executionStatus is skipped', () => {
    const data = makeData({ executionStatus: 'skipped' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const badge = screen.getByLabelText('Skipped');
    expect(badge).toBeInTheDocument();
  });

  it('does not render a badge when executionStatus is undefined', () => {
    const data = makeData();
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Skipped')).not.toBeInTheDocument();
  });

  it('does not render a badge when executionStatus is pending', () => {
    const data = makeData({ executionStatus: 'pending' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Skipped')).not.toBeInTheDocument();
  });

  it('applies a green border tint when completed', () => {
    const data = makeData({ executionStatus: 'completed' });
    const { container } = render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const node = container.querySelector('[role="button"]')!;
    expect(node.className).toMatch(/border-green|border-chart-2/);
  });

  it('applies a red border tint when failed', () => {
    const data = makeData({ executionStatus: 'failed' });
    const { container } = render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const node = container.querySelector('[role="button"]')!;
    expect(node.className).toMatch(/border-red|border-destructive/);
  });

  it('honours reduced motion for the running spinner', () => {
    const data = makeData({ executionStatus: 'running' });
    render(React.createElement(AgentNodeCmp, { id: 'n1', data, selected: false, type: 'agentNode', positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0, isConnectable: true, dragging: false, selectable: true, deletable: true, draggable: true }));

    const badge = screen.getByLabelText('Running');
    // The Loader2 icon inside the badge carries the motion-safe/motion-reduce classes
    const spinEl = badge.querySelector('[class]');
    expect(spinEl).toBeTruthy();
    expect(spinEl!.getAttribute('class')).toMatch(/motion-reduce:animate-none/);
    expect(spinEl!.getAttribute('class')).toMatch(/motion-safe:animate-spin/);
  });
});
