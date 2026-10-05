/**
 * AgentBlueprints — execution approval action wiring (host-level).
 *
 * Verifies the host page passes canApproveExecutions / onPause / onApprove /
 * onDeny to ExecutionOverlay so the buttons actually render and call the
 * execution API service.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('reactflow', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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

// --- Organization mock — swapped per test via mockUseOrganization ---
const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
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
    pauseExecution: jest.fn(),
    approveExecution: jest.fn(),
    denyExecution: jest.fn(),
    getExecution: jest.fn(),
  },
}));

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

/** Helper: build canvas, publish, start execution, return subscription callback. */
async function buildAndRun() {
  (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
    workflowId: 'wf-1',
    status: 'DRAFT',
    version: 1,
  });
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
    (_q: string, _v: any, cb: (data: any) => void) => {
      capturedCallback = cb;
      return jest.fn();
    },
  );

  render(<AgentBlueprints />);
  fireEvent.click(screen.getByTestId('add-node'));
  await act(async () => { jest.advanceTimersByTime(2000); });
  await flush();

  fireEvent.click(screen.getByRole('button', { name: /publish/i }));
  await flush();

  fireEvent.click(screen.getByRole('button', { name: /run workflow/i }));
  await flush();

  return capturedCallback;
}

function emitStatus(cb: (data: any) => void, status: string) {
  act(() => {
    // First emit workflow.started so the hook sets executionStatus='running'
    if (status === 'running') {
      cb({
        onWorkflowProgress: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          eventType: 'workflow.started',
          nodeId: null,
          status: 'running',
          output: null,
          error: null,
          timestamp: '2024-01-01T00:00:00Z',
        },
      });
    } else if (status === 'awaiting_approval') {
      // The hook must recognize this event to set executionStatus
      cb({
        onWorkflowProgress: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          eventType: 'workflow.awaiting_approval',
          nodeId: null,
          status: 'awaiting_approval',
          output: null,
          error: null,
          timestamp: '2024-01-01T00:00:01Z',
        },
      });
    }
  });
}

describe('AgentBlueprints approval wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('architect / admin context (canApproveExecutions = true)', () => {
    beforeEach(() => {
      mockUseOrganization.mockReturnValue({
        selectedOrganization: 'org-1',
        currentUser: { organization: 'org-1', role: 'architect' },
        canApproveExecutions: true,
      });
    });

    it('shows Pause button when execution is running', async () => {
      const cb = await buildAndRun();
      emitStatus(cb, 'running');
      await flush();

      expect(screen.getByTestId('pause-execution')).toBeInTheDocument();
    });

    it('shows Approve and Deny buttons when execution is awaiting_approval', async () => {
      const cb = await buildAndRun();
      emitStatus(cb, 'awaiting_approval');
      await flush();

      expect(screen.getByTestId('approve-execution')).toBeInTheDocument();
      expect(screen.getByTestId('deny-execution')).toBeInTheDocument();
    });

    it('Pause calls executionApiService.pauseExecution', async () => {
      (executionApiService.pauseExecution as jest.Mock).mockResolvedValue({ status: 'paused' });
      const cb = await buildAndRun();
      emitStatus(cb, 'running');
      await flush();

      fireEvent.click(screen.getByTestId('pause-execution'));
      await flush();

      expect(executionApiService.pauseExecution).toHaveBeenCalledWith('exec-1', 'Paused by user');
    });

    it('Approve calls executionApiService.approveExecution with currentNode', async () => {
      (executionApiService.getExecution as jest.Mock).mockResolvedValue({
        executionId: 'exec-1',
        currentNode: 'node-1',
        status: 'awaiting_approval',
      });
      (executionApiService.approveExecution as jest.Mock).mockResolvedValue({ status: 'running' });
      const cb = await buildAndRun();
      emitStatus(cb, 'awaiting_approval');
      await flush();

      fireEvent.click(screen.getByTestId('approve-execution'));
      await flush();

      expect(executionApiService.getExecution).toHaveBeenCalledWith('exec-1');
      expect(executionApiService.approveExecution).toHaveBeenCalledWith('exec-1', 'node-1');
    });

    it('Deny calls executionApiService.denyExecution with currentNode and reason', async () => {
      (executionApiService.getExecution as jest.Mock).mockResolvedValue({
        executionId: 'exec-1',
        currentNode: 'node-1',
        status: 'awaiting_approval',
      });
      (executionApiService.denyExecution as jest.Mock).mockResolvedValue({ status: 'denied' });
      const cb = await buildAndRun();
      emitStatus(cb, 'awaiting_approval');
      await flush();

      fireEvent.click(screen.getByTestId('deny-execution'));
      await flush();

      expect(executionApiService.getExecution).toHaveBeenCalledWith('exec-1');
      expect(executionApiService.denyExecution).toHaveBeenCalledWith('exec-1', 'node-1', 'Denied by user');
    });
  });

  describe('developer context (canApproveExecutions = false)', () => {
    beforeEach(() => {
      mockUseOrganization.mockReturnValue({
        selectedOrganization: 'org-1',
        currentUser: { organization: 'org-1', role: 'developer' },
        canApproveExecutions: false,
      });
    });

    it('does not show Pause when execution is running', async () => {
      const cb = await buildAndRun();
      emitStatus(cb, 'running');
      await flush();

      expect(screen.queryByTestId('pause-execution')).not.toBeInTheDocument();
    });

    it('does not show Approve/Deny when execution is awaiting_approval', async () => {
      const cb = await buildAndRun();
      emitStatus(cb, 'awaiting_approval');
      await flush();

      expect(screen.queryByTestId('approve-execution')).not.toBeInTheDocument();
      expect(screen.queryByTestId('deny-execution')).not.toBeInTheDocument();
    });
  });
});
