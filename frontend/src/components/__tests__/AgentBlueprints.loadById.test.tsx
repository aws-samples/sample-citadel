/**
 * AgentBlueprints — load-by-id hydration.
 *
 * Verifies the canvas builder can open an existing server workflow (e.g. one
 * imported into an app) via an optional `workflowId` prop:
 *   - the workflow definition is deserialized into canvas nodes/edges
 *   - a PUBLISHED workflow enables Run immediately (Publish shows Published)
 *   - a DRAFT workflow keeps Run gated and Publish available
 *   - subsequent autosave UPDATES the loaded workflow (never re-creates)
 *   - a failed load surfaces a visible error and falls back to a blank canvas
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// uuid v13 is ESM-only and not in jest's transform whitelist; stub it so the
// workflow serializer (which pulls in uuid) can be parsed under ts-jest.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

// ReactFlowProvider is a lightweight context wrapper; pass children through so
// we never mount the heavy canvas in jsdom.
jest.mock('reactflow', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The canvas stub echoes the node ids it receives (to observe hydration) and
// exposes a button that appends a node (to simulate a user edit after load).
jest.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: ({ nodes, setNodes }: any) => (
    <div>
      <div data-testid="canvas-nodes">{nodes.map((n: any) => n.id).join(',')}</div>
      <button
        data-testid="add-node"
        onClick={() =>
          setNodes((prev: any[]) => [
            ...prev,
            {
              id: 'node-new',
              type: 'agentNode',
              position: { x: 200, y: 0 },
              data: { agentId: 'agent-known', label: 'New', inputCount: 1, outputCount: 1, configuration: {} },
            },
          ])
        }
      >
        add node
      </button>
    </div>
  ),
}));
jest.mock('../AgentTray', () => ({ AgentTray: () => <div data-testid="agent-tray" /> }));
jest.mock('../WorkflowToolbar', () => ({ WorkflowToolbar: () => <div data-testid="toolbar" /> }));
jest.mock('../NodeConfigurationPanel', () => ({ NodeConfigurationPanel: () => null }));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));

jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    createWorkflow: jest.fn(),
    updateWorkflow: jest.fn(),
    getWorkflow: jest.fn(),
    publishWorkflow: jest.fn(),
  },
}));

jest.mock('../../services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    cancelExecution: jest.fn(),
  },
}));

// The deserializer resolves agent configs; return one known agent so the
// placeholder path (app-bound/imported agent ids) is exercised too.
jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn(),
  },
}));

// useExecutionSubscription is real; the underlying subscription transport is mocked.
jest.mock('../../services/server', () => ({
  __esModule: true,
  default: { subscribe: jest.fn() },
}));

import { AgentBlueprints } from '../AgentBlueprints';
import { workflowApiService } from '../../services/workflowApiService';
import { agentConfigService } from '../../services/agentConfigService';
import serverService from '../../services/server';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** A serialized definition as stored on the server (AWSJSON string). */
const definition = {
  version: '1.0.0',
  id: 'def-1',
  name: 'Imported Flow',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  nodes: [
    { id: 'node-a', agentId: 'agent-known', position: { x: 0, y: 0 }, configuration: {} },
    // References an app-bound agent id that is NOT in the org agent catalog.
    { id: 'node-b', agentId: 'agent-appbound', position: { x: 100, y: 0 }, configuration: {} },
  ],
  edges: [
    { id: 'edge-1', source: 'node-a', target: 'node-b', sourceHandle: 'output', targetHandle: 'input' },
  ],
};

function serverWorkflow(status: 'DRAFT' | 'PUBLISHED') {
  return {
    workflowId: 'wf-42',
    orgId: 'org-1',
    name: 'Imported Flow',
    status,
    version: 3,
    definition: JSON.stringify(definition),
  };
}

describe('AgentBlueprints load-by-id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      { agentId: 'agent-known', name: 'Known Agent', config: { name: 'Known Agent' }, state: 'active' },
    ]);
    (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-42',
      status: 'DRAFT',
      version: 4,
    });
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hydrates canvas nodes from the server definition, including app-bound agent ids', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(serverWorkflow('DRAFT'));

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    expect(workflowApiService.getWorkflow).toHaveBeenCalledWith('wf-42');
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-a,node-b');
  });

  it('a PUBLISHED workflow enables Run immediately and shows Published', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(serverWorkflow('PUBLISHED'));

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    expect(screen.getByRole('button', { name: /run workflow/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /published/i })).toBeDisabled();
  });

  it('a DRAFT workflow keeps Run gated and Publish available', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(serverWorkflow('DRAFT'));

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    expect(screen.getByRole('button', { name: /run workflow/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeEnabled();
  });

  it('hydration alone does not autosave; an edit updates the SAME workflow (no create)', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(serverWorkflow('DRAFT'));

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    // No save should be scheduled just from loading the workflow.
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();
    expect(workflowApiService.updateWorkflow).not.toHaveBeenCalled();

    // A user edit autosaves via updateWorkflow against the loaded id.
    fireEvent.click(screen.getByTestId('add-node'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flush();

    expect(workflowApiService.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-42' })
    );
    expect(workflowApiService.createWorkflow).not.toHaveBeenCalled();
  });

  it('shows a visible error and falls back to a blank canvas when the load fails', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockRejectedValue(
      new Error('Workflow not found')
    );

    render(<AgentBlueprints workflowId="wf-missing" />);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(/workflow not found/i);
    // Blank canvas fallback: no nodes, and publish stays gated (no workflowId).
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('');
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled();
  });
});
