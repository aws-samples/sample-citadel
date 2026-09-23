/**
 * AgentBlueprints — caller-organization sourcing for workflow creation
 * (finding d8fb2286).
 *
 * The server rejects any client-supplied orgId that does not match the
 * caller's own organization. createWorkflow must be sourced from the
 * caller's own useOrganization() context (currentUser.organization), not
 * selectedOrganization (an admin's filter-scope selection, which can be
 * "All Organizations" or another org's name) and never the 'default'
 * placeholder fallback.
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
  },
}));

jest.mock('../../services/server', () => ({
  __esModule: true,
  default: { subscribe: jest.fn() },
}));

import { AgentBlueprints } from '../AgentBlueprints';
import { workflowApiService } from '../../services/workflowApiService';
import serverService from '../../services/server';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('AgentBlueprints caller-org sourcing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    localStorage.clear();
    (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      status: 'DRAFT',
      version: 1,
    });
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends currentUser.organization even when selectedOrganization differs (admin filter scope)', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: 'All Organizations',
      currentUser: { organization: 'caller-org' },
    });

    render(<AgentBlueprints />);
    fireEvent.click(screen.getByTestId('add-node'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await flush();

    expect(workflowApiService.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'caller-org' }),
    );
  });

  it('blocks workflow creation and shows a message when the caller has no organization', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: null,
      currentUser: { organization: null },
    });

    render(<AgentBlueprints />);
    fireEvent.click(screen.getByTestId('add-node'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    await flush();

    expect(workflowApiService.createWorkflow).not.toHaveBeenCalled();
    expect(
      screen.getByText('Your account has no organisation; ask an admin to assign one'),
    ).toBeInTheDocument();
  });
});
