/**
 * AgentBlueprints — execution history mounting.
 *
 * Verifies the canvas builder mounts the execution history panel beside the
 * canvas, keyed by the active workflowId. Opening the panel lists past
 * executions for that workflow and expanding an entry renders per-node status.
 */

import { render, screen, fireEvent, act, within } from '@testing-library/react';
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

// The canvas stub exposes a button that drives setNodes so we can simulate a
// user building a workflow (which triggers the server create → workflowId).
jest.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: ({ setNodes }: any) => (
    <button
      data-testid="add-node"
      onClick={() =>
        setNodes(() => [
          {
            id: 'node-1',
            type: 'agentNode',
            position: { x: 0, y: 0 },
            data: { agentId: 'a1', label: 'A1', inputCount: 1, outputCount: 1, configuration: {} },
          },
        ])
      }
    >
      add node
    </button>
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
    listExecutions: jest.fn(),
  },
}));

// useExecutionSubscription is real; the underlying subscription transport is mocked.
jest.mock('../../services/server', () => ({
  __esModule: true,
  default: { subscribe: jest.fn() },
}));

import { AgentBlueprints } from '../AgentBlueprints';
import { workflowApiService } from '../../services/workflowApiService';
import { executionApiService } from '../../services/executionApiService';
import serverService from '../../services/server';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const historyItems = [
  {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    status: 'completed',
    workflowVersion: 1,
    startedAt: '2024-03-01T12:00:00Z',
    completedAt: '2024-03-01T12:05:00Z',
    nodeResults: JSON.stringify({
      'node-1': {
        nodeId: 'node-1',
        agentId: 'a1',
        status: 'completed',
        startedAt: '2024-03-01T12:00:00Z',
        completedAt: '2024-03-01T12:02:00Z',
        output: '{"result":"ok"}',
        error: null,
        retryCount: 0,
      },
    }),
  },
];

async function buildWorkflowOnCanvas() {
  render(<AgentBlueprints />);
  fireEvent.click(screen.getByTestId('add-node'));
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  await flush();
}

describe('AgentBlueprints execution history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'DRAFT',
      version: 1,
    });
    (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'DRAFT',
      version: 2,
    });
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
      items: historyItems,
      nextToken: null,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('gates the history control until a workflow exists', async () => {
    render(<AgentBlueprints />);
    expect(screen.getByRole('button', { name: /history/i })).toBeDisabled();
  });

  it('lists executions for the active workflowId and renders per-node status', async () => {
    await buildWorkflowOnCanvas();

    const historyButton = screen.getByRole('button', { name: /history/i });
    expect(historyButton).toBeEnabled();

    // Open the panel beside the canvas.
    fireEvent.click(historyButton);
    await flush();

    // The panel fetched executions keyed by the active workflow.
    expect(executionApiService.listExecutions).toHaveBeenCalledWith('wf-1');
    expect(screen.getByTestId('execution-history-panel')).toBeInTheDocument();

    const entry = screen.getByTestId('execution-entry-exec-1');
    expect(entry).toBeInTheDocument();
    // Execution-level status badge is rendered.
    expect(screen.getByTestId('status-badge-exec-1')).toHaveClass('bg-chart-2');

    // Expanding the entry renders per-node status.
    fireEvent.click(entry);
    await flush();
    expect(screen.getByTestId('node-result-node-1')).toBeInTheDocument();
    expect(within(screen.getByTestId('node-result-node-1')).getByText('node-1')).toBeInTheDocument();
  });

  it('closes the panel via its close control', async () => {
    await buildWorkflowOnCanvas();

    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    await flush();
    expect(screen.getByTestId('execution-history-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await flush();
    expect(screen.queryByTestId('execution-history-panel')).not.toBeInTheDocument();
  });
});
