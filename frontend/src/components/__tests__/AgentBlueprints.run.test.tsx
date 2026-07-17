/**
 * AgentBlueprints — server persistence, publish gating, and run/subscription wiring.
 *
 * Verifies the canvas builder is wired to server-side persistence and the live
 * execution experience:
 *   - a canvas change creates a server workflow (yielding a workflowId)
 *   - publishing calls publishWorkflow and enables Run only when PUBLISHED
 *   - Run starts an execution and per-node badges update as progress arrives
 *   - publish validation errors are surfaced and keep Run disabled
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

// Heavy children are stubbed. The canvas stub exposes a button that drives
// setNodes so we can simulate a user building a workflow.
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

async function buildWorkflowOnCanvas() {
  render(<AgentBlueprints />);
  fireEvent.click(screen.getByTestId('add-node'));
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  await flush();
}

describe('AgentBlueprints run experience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'DRAFT',
      version: 1,
    });
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('saving a canvas workflow calls createWorkflow and yields a workflowId', async () => {
    render(<AgentBlueprints />);

    // Publish is gated on having a server workflowId.
    expect(screen.getByRole('button', { name: /publish/i })).toBeDisabled();

    fireEvent.click(screen.getByTestId('add-node'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await flush();

    expect(workflowApiService.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', definition: expect.any(String) })
    );
    // workflowId acquired → publish becomes available.
    expect(screen.getByRole('button', { name: /publish/i })).toBeEnabled();
  });

  it('does not call createWorkflow for an empty canvas', async () => {
    render(<AgentBlueprints />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await flush();
    expect(workflowApiService.createWorkflow).not.toHaveBeenCalled();
  });

  it('publishing calls publishWorkflow and enables Run', async () => {
    await buildWorkflowOnCanvas();
    (workflowApiService.publishWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'PUBLISHED',
      version: 2,
    });

    // Run is disabled while the workflow is a DRAFT.
    expect(screen.getByRole('button', { name: /run workflow/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    await flush();

    expect(workflowApiService.publishWorkflow).toHaveBeenCalledWith('wf-1');
    expect(screen.getByRole('button', { name: /run workflow/i })).toBeEnabled();
  });

  it('clicking Run calls startExecution and node badges update as progress arrives', async () => {
    await buildWorkflowOnCanvas();
    (workflowApiService.publishWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'PUBLISHED',
      version: 2,
    });
    (executionApiService.startExecution as jest.Mock).mockResolvedValue({
      executionId: 'exec-1',
      status: 'running',
    });

    let capturedCallback: (data: any) => void = () => {};
    (serverService.subscribe as jest.Mock).mockImplementation(
      (_query: string, _vars: any, cb: (data: any) => void) => {
        capturedCallback = cb;
        return jest.fn();
      }
    );

    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /run workflow/i }));
    await flush();

    expect(executionApiService.startExecution).toHaveBeenCalledWith('wf-1');
    expect(serverService.subscribe).toHaveBeenCalledWith(
      expect.stringContaining('onWorkflowProgress'),
      { executionId: 'exec-1' },
      expect.any(Function)
    );

    // A live progress event flips the node badge to running.
    act(() => {
      capturedCallback({
        onWorkflowProgress: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          eventType: 'workflow.node.started',
          nodeId: 'node-1',
          status: 'running',
          output: null,
          error: null,
          timestamp: '2024-01-01T00:00:00Z',
        },
      });
    });

    const badge = screen.getByTestId('node-status-node-1');
    expect(badge).toHaveClass('bg-primary');
  });

  it('surfaces publish validation errors and keeps Run disabled', async () => {
    await buildWorkflowOnCanvas();
    (workflowApiService.publishWorkflow as jest.Mock).mockRejectedValue(
      new Error('Validation failed: node node-1 is disconnected')
    );

    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(/validation failed/i);
    expect(screen.getByRole('button', { name: /run workflow/i })).toBeDisabled();
  });
});
