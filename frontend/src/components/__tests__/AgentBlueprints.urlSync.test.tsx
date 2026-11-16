/**
 * AgentBlueprints — URL sync.
 * TDD Red Phase: tests for CIT-291 bug B — when a workflow becomes active on
 * the canvas (blueprint loaded / new workflow created), the browser URL should
 * update to /agentic-studio/workflows/<id> so a page reload re-opens it.
 */

import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('reactflow', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockNavigate = jest.fn();
const mockUseParams = jest.fn().mockReturnValue({});
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useParams: (...args: unknown[]) => mockUseParams(...args),
}));

jest.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: ({ nodes, setNodes }: { nodes: { id: string }[]; setNodes: (fn: (prev: { id: string }[]) => { id: string }[]) => void }) => (
    <div>
      <div data-testid="canvas-nodes">{nodes.map((n) => n.id).join(',')}</div>
      <button
        data-testid="add-node"
        onClick={() =>
          setNodes((prev) => [
            ...prev,
            {
              id: 'node-new',
              type: 'agentNode',
              position: { x: 200, y: 0 },
              data: { agentId: 'agent-known', label: 'New', inputCount: 1, outputCount: 1, configuration: {} },
            } as unknown as { id: string },
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
  useOrganization: () => ({ selectedOrganization: 'org-1', currentUser: { organization: 'org-1' } }),
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

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn(),
  },
}));

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

const definition = {
  version: '1.0.0',
  id: 'def-1',
  name: 'Imported Flow',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  nodes: [
    { id: 'node-a', agentId: 'agent-known', position: { x: 0, y: 0 }, configuration: {} },
  ],
  edges: [],
};

describe('AgentBlueprints URL sync (CIT-291 bug B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      { agentId: 'agent-known', name: 'Known Agent', config: { name: 'Known Agent' }, state: 'active' },
    ]);
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('navigates to /agentic-studio/workflows/<id> when a workflow is loaded by id', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-42',
      orgId: 'org-1',
      name: 'Test Flow',
      status: 'DRAFT',
      version: 1,
      definition: JSON.stringify(definition),
    });

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    expect(mockNavigate).toHaveBeenCalledWith(
      '/agentic-studio/workflows/wf-42',
      expect.objectContaining({ replace: true }),
    );
  });

  it('does not navigate again when the route already provides the same workflowId', async () => {
    // Override useParams for this single test to return the matching id.
    mockUseParams.mockReturnValue({ workflowId: 'wf-42' });

    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-42',
      orgId: 'org-1',
      name: 'Test Flow',
      status: 'DRAFT',
      version: 1,
      definition: JSON.stringify(definition),
    });

    render(<AgentBlueprints workflowId="wf-42" />);
    await flush();

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
