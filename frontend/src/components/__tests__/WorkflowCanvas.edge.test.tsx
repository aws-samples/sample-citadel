/**
 * WorkflowCanvas edge-click wiring tests.
 * TDD Red Phase — tests written before implementation.
 *
 * CIT-291: Double-click on edge opens EdgeConditionSheet via onEdgeDoubleClick.
 * Single click on edge does NOT open the sheet.
 *
 * Strategy: mock uuid (ESM), then import the real WorkflowCanvas. The mock
 * of ReactFlow exposes synthetic trigger buttons so tests can simulate
 * ReactFlow's onEdgeDoubleClick / onEdgeClick callbacks.
 */

// uuid ESM stub — must be declared before any import that transitively loads it.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

// Full ReactFlow mock — avoids canvas/DOM issues in jsdom. @xyflow/react ships
// ESM-only, so jest.requireActual() cannot be used under ts-jest's CJS
// transform; every named export WorkflowCanvas.tsx or this test needs is
// stubbed explicitly instead of spreading the real module.
jest.mock('@xyflow/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    __esModule: true,
    ReactFlow: function MockReactFlow(props: Record<string, (...args: unknown[]) => void>) {
      return React.createElement('div', { 'data-testid': 'mock-reactflow' },
        React.createElement('button', {
          'data-testid': 'fire-edge-double-click',
          onClick: () => props.onEdgeDoubleClick?.({}, { id: 'e1' }),
        }),
        React.createElement('button', {
          'data-testid': 'fire-edge-click',
          onClick: () => props.onEdgeClick?.({}, { id: 'e1' }),
        }),
      );
    },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
  };
});

// Stub modules that WorkflowCanvas imports transitively
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../AgentNode', () => ({ AgentNode: () => null }));
jest.mock('../../services/workflowService', () => ({
  wouldCreateCycle: () => false,
}));
jest.mock('../../hooks/useScreenReader', () => ({
  useScreenReader: () => ({ announce: jest.fn() }),
}));
jest.mock('../../utils/resolveToolBindings', () => ({
  resolveToolBindings: () => Promise.resolve([]),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { WorkflowCanvas } from '../WorkflowCanvas';
import type { WorkflowNode, WorkflowEdge } from '../../types/workflow';

const node1: WorkflowNode = {
  id: 'n1',
  type: 'agentNode',
  position: { x: 0, y: 0 },
  data: {
    agentId: 'a1',
    agentConfig: {} as WorkflowNode['data']['agentConfig'],
    label: 'Node 1',
    inputCount: 1,
    outputCount: 1,
  },
};

const node2: WorkflowNode = {
  id: 'n2',
  type: 'agentNode',
  position: { x: 200, y: 0 },
  data: {
    agentId: 'a2',
    agentConfig: {} as WorkflowNode['data']['agentConfig'],
    label: 'Node 2',
    inputCount: 1,
    outputCount: 1,
  },
};

const edge: WorkflowEdge = {
  id: 'e1',
  source: 'n1',
  target: 'n2',
  sourceHandle: 'output',
  targetHandle: 'input',
  type: 'smoothstep',
  data: { sourceHandle: 'output', targetHandle: 'input' },
};

describe('WorkflowCanvas edge double-click wiring', () => {
  it('calls onEdgeDoubleClick when an edge is double-clicked', () => {
    const onEdgeDoubleClick = jest.fn();
    render(
      <ReactFlowProvider>
        <WorkflowCanvas
          nodes={[node1, node2]}
          edges={[edge]}
          setNodes={jest.fn()}
          setEdges={jest.fn()}
          onNodeDoubleClick={jest.fn()}
          onEdgeDoubleClick={onEdgeDoubleClick}
          validationResult={null}
        />
      </ReactFlowProvider>,
    );
    fireEvent.click(screen.getByTestId('fire-edge-double-click'));
    expect(onEdgeDoubleClick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'e1' }),
    );
  });

  it('does NOT call onEdgeDoubleClick on single click', () => {
    const onEdgeDoubleClick = jest.fn();
    render(
      <ReactFlowProvider>
        <WorkflowCanvas
          nodes={[node1, node2]}
          edges={[edge]}
          setNodes={jest.fn()}
          setEdges={jest.fn()}
          onNodeDoubleClick={jest.fn()}
          onEdgeDoubleClick={onEdgeDoubleClick}
          validationResult={null}
        />
      </ReactFlowProvider>,
    );
    fireEvent.click(screen.getByTestId('fire-edge-click'));
    expect(onEdgeDoubleClick).not.toHaveBeenCalled();
  });
});
