/**
 * WorkflowCanvas drop-position regression test.
 *
 * @xyflow/react v13's screenToFlowPosition expects RAW screen coordinates
 * (it subtracts the container rect internally — see node_modules/@xyflow/react
 * dist/index.d.ts jsdoc on screenToFlowPosition). The v11 `project()`
 * convention of subtracting reactFlowWrapper's getBoundingClientRect() before
 * calling the API double-subtracts the offset and lands dropped nodes away
 * from the cursor. This test pins onDrop to pass raw event.clientX/clientY.
 *
 * `onDrop`/`onDragOver` are wired on the wrapper <div> (ref={reactFlowWrapper}),
 * not on the <ReactFlow> element itself, so the drop is fired as a real DOM
 * event on that wrapper via @testing-library/react's fireEvent.drop.
 */

// uuid ESM stub — must be declared before any import that transitively loads it.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const mockScreenToFlowPosition = jest.fn((p: { x: number; y: number }) => p);

// Full ReactFlow mock — avoids canvas/DOM issues in jsdom. @xyflow/react ships
// ESM-only, so jest.requireActual() cannot be used under ts-jest's CJS
// transform; every named export WorkflowCanvas.tsx or this test needs is
// stubbed explicitly instead of spreading the real module.
jest.mock('@xyflow/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    __esModule: true,
    ReactFlow: function MockReactFlow() {
      return React.createElement('div', { 'data-testid': 'mock-reactflow' });
    },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useReactFlow: () => ({ screenToFlowPosition: mockScreenToFlowPosition }),
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

afterEach(() => {
  jest.clearAllMocks();
});

describe('WorkflowCanvas drop position', () => {
  it('passes raw event.clientX/clientY to screenToFlowPosition, not bounds-adjusted coordinates', () => {
    render(
      <ReactFlowProvider>
        <WorkflowCanvas
          nodes={[]}
          edges={[]}
          setNodes={jest.fn()}
          setEdges={jest.fn()}
          onNodeDoubleClick={jest.fn()}
          validationResult={null}
        />
      </ReactFlowProvider>,
    );

    const wrapper = screen.getByTestId('mock-reactflow').parentElement as HTMLElement;

    // Non-zero offset: jsdom's default getBoundingClientRect() returns all
    // zeros, which would make `clientX - bounds.left` equal `clientX` and
    // mask the regression. Stub a realistic non-zero canvas offset so the
    // raw-vs-bounds-adjusted distinction is actually exercised.
    wrapper.getBoundingClientRect = jest.fn(() => ({
      left: 80,
      top: 40,
      right: 1000,
      bottom: 800,
      width: 920,
      height: 760,
      x: 80,
      y: 40,
      toJSON: () => ({}),
    }));

    const dataTransfer = {
      getData: () =>
        JSON.stringify({
          type: 'agent',
          agentId: 'agent-1',
          agentConfig: { agentId: 'agent-1', config: { name: 'Agent One' }, state: 'active' },
        }),
    };

    // jsdom's DragEvent constructor does not accept clientX/clientY in its
    // init dict (they are MouseEvent properties, read-only once constructed),
    // so build a real DragEvent and override the getters directly.
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(dropEvent, 'clientX', { value: 450, configurable: true });
    Object.defineProperty(dropEvent, 'clientY', { value: 275, configurable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer, configurable: true });

    fireEvent(wrapper, dropEvent);

    // Must receive the raw screen coordinates, not clientX/Y minus the
    // wrapper's bounding rect (that was the v11 project() convention).
    expect(mockScreenToFlowPosition).toHaveBeenCalledWith({ x: 450, y: 275 });
  });
});
