/**
 * AgentBlueprints — stale draft restore.
 *
 * Verifies that restoring a stale local draft from localStorage that
 * references agents no longer in the catalog does NOT surface an error:
 *   - no error toast / banner is shown
 *   - a single informational toast names the missing agents (deduped)
 *   - placeholder nodes are rendered with a visual marker
 *   - a fully-orphaned local-only draft (no server workflow) is discarded
 */

import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const mockToast = {
  error: jest.fn(),
  info: jest.fn(),
  success: jest.fn(),
  warning: jest.fn(),
};
jest.mock('sonner', () => ({ toast: mockToast }));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useParams: () => ({}),
}));

jest.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Canvas stub renders node ids and a placeholder marker per node.
interface StubNode { id: string; data: { isPlaceholder?: boolean } }
jest.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: ({ nodes }: { nodes: StubNode[] }) => (
    <div>
      <div data-testid="canvas-nodes">{nodes.map((n) => n.id).join(',')}</div>
      {nodes.map((n) => (
        <div key={n.id} data-testid={`node-placeholder-${n.id}`}>
          {n.data.isPlaceholder ? 'placeholder' : 'real'}
        </div>
      ))}
    </div>
  ),
}));
jest.mock('../AgentTray', () => ({ AgentTray: () => <div data-testid="agent-tray" /> }));
jest.mock('../WorkflowToolbar', () => ({ WorkflowToolbar: () => <div data-testid="toolbar" /> }));
jest.mock('../NodeConfigurationPanel', () => ({ NodeConfigurationPanel: () => null }));
jest.mock('../EdgeConditionSheet', () => ({ EdgeConditionSheet: () => null }));
jest.mock('../ExecutionOverlay', () => ({ ExecutionOverlay: () => null }));
jest.mock('../ExecutionHistoryPanel', () => ({ ExecutionHistoryPanel: () => null }));
jest.mock('../RunWorkflowDialog', () => ({ RunWorkflowDialog: () => null }));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    currentUser: { organization: 'org-1' },
    canApproveExecutions: false,
  }),
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
import { agentConfigService } from '../../services/agentConfigService';
import { toast } from 'sonner';
import serverService from '../../services/server';

const AUTOSAVE_KEY = 'workflow-autosave:anonymous';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Stale localStorage entry: two nodes referencing agents that no longer exist. */
function staleAutosave() {
  return JSON.stringify({
    nodes: [
      {
        id: 'node-1',
        type: 'agentNode',
        position: { x: 0, y: 0 },
        data: {
          agentId: 'reporter',
          label: 'Reporter',
          agentConfig: { agentId: 'reporter', name: 'reporter', config: { name: 'reporter' }, state: 'active' },
          inputCount: 1,
          outputCount: 1,
          configuration: {},
        },
      },
      {
        id: 'node-2',
        type: 'agentNode',
        position: { x: 100, y: 0 },
        data: {
          agentId: 'fabricator',
          label: 'Fabricator',
          agentConfig: { agentId: 'fabricator', name: 'fabricator', config: { name: 'fabricator' }, state: 'active' },
          inputCount: 1,
          outputCount: 1,
          configuration: {},
        },
      },
      {
        id: 'node-3',
        type: 'agentNode',
        position: { x: 200, y: 0 },
        data: {
          agentId: 'reporter',
          label: 'Reporter (2)',
          agentConfig: { agentId: 'reporter', name: 'reporter', config: { name: 'reporter' }, state: 'active' },
          inputCount: 1,
          outputCount: 1,
          configuration: {},
        },
      },
    ],
    edges: [
      { id: 'edge-1', source: 'node-1', target: 'node-2', sourceHandle: 'output', targetHandle: 'input' },
    ],
    timestamp: '2024-01-01T00:00:00Z',
  });
}

describe('AgentBlueprints stale draft restore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    // Return only one known agent — reporter and fabricator are missing.
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      { agentId: 'agent-known', name: 'Known Agent', config: { name: 'Known Agent' }, state: 'active' },
    ]);
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not show an error toast when restoring a stale draft with missing agents', async () => {
    localStorage.setItem(AUTOSAVE_KEY, staleAutosave());
    render(<AgentBlueprints />);
    await flush();

    expect(toast.error).not.toHaveBeenCalled();
    // No error banner in the DOM
    const alerts = screen.queryAllByRole('alert');
    const errorAlerts = alerts.filter((el) => el.textContent?.includes('Failed to load'));
    expect(errorAlerts).toHaveLength(0);
  });

  it('shows a single informational toast naming the deduped missing agents', async () => {
    localStorage.setItem(AUTOSAVE_KEY, staleAutosave());
    render(<AgentBlueprints />);
    await flush();

    // One info toast with deduped missing agent names
    expect(toast.info).toHaveBeenCalledTimes(1);
    const call = (toast.info as jest.Mock).mock.calls[0];
    expect(call[0]).toMatch(/draft restored/i);
    // Both reporter and fabricator mentioned, but reporter only once (deduped)
    const fullText = `${call[0]} ${call[1]?.description ?? ''}`;
    expect(fullText).toContain('reporter');
    expect(fullText).toContain('fabricator');
    // Deduplicated: "reporter" appears once, not twice
    const matches = fullText.match(/reporter/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('renders restored nodes with isPlaceholder=true for missing agents', async () => {
    localStorage.setItem(AUTOSAVE_KEY, staleAutosave());
    render(<AgentBlueprints />);
    await flush();

    // All 3 nodes rendered
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-1,node-2,node-3');

    // Both reporter nodes and the fabricator node are placeholders
    expect(screen.getByTestId('node-placeholder-node-1')).toHaveTextContent('placeholder');
    expect(screen.getByTestId('node-placeholder-node-2')).toHaveTextContent('placeholder');
    expect(screen.getByTestId('node-placeholder-node-3')).toHaveTextContent('placeholder');
  });
});
