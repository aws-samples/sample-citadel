/**
 * AppDetailView — execution approval/pause/deny actions (CIT-030)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---- UI mocks (same pattern as AppDetailView.test.tsx) ----

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

let tabsOnValueChange: ((v: string) => void) | null = null;
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }: any) => {
    tabsOnValueChange = onValueChange;
    return React.createElement('div', { 'data-testid': 'tabs', 'data-value': value }, children);
  },
  TabsList: ({ children }: any) => React.createElement('div', { role: 'tablist' }, children),
  TabsTrigger: ({ children, value, className }: any) =>
    React.createElement('button', {
      role: 'tab',
      'data-value': value,
      className,
      onClick: () => tabsOnValueChange?.(value),
    }, children),
  TabsContent: ({ children, value }: any) =>
    React.createElement('div', { role: 'tabpanel', 'data-tab': value }, children),
}));

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: any) => React.createElement('div', null, children),
  DialogHeader: ({ children }: any) => React.createElement('div', null, children),
  DialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: any) => React.createElement('p', null, children),
  DialogFooter: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => React.createElement('textarea', props),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: (props: any) =>
    React.createElement('input', {
      'data-testid': 'model-override',
      value: props.value || '',
      onChange: (e: any) => props.onChange(e.target.value),
    }),
}));

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) => open ? React.createElement('div', { 'data-testid': 'alert-dialog' }, children) : null,
  AlertDialogAction: ({ children, onClick, disabled, ...props }: any) =>
    React.createElement('button', { onClick, disabled, ...props }, children),
  AlertDialogCancel: ({ children, onClick, disabled }: any) =>
    React.createElement('button', { onClick, disabled }, children),
  AlertDialogContent: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogHeader: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  AlertDialogDescription: ({ children }: any) => React.createElement('p', null, children),
  AlertDialogFooter: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => React.createElement('label', props, children),
}));

// ---- Context & service mocks ----

const mockCanApproveExecutions = jest.fn().mockReturnValue(true);
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'org-1',
    canApproveExecutions: mockCanApproveExecutions(),
    loading: false,
  }),
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getApp: jest.fn(),
    updateApp: jest.fn(),
    removeAppComponent: jest.fn(),
    unbindWorkflowFromApp: jest.fn(),
    bindWorkflowToApp: jest.fn(),
    setAppConfigValues: jest.fn(),
    addAppComponent: jest.fn(),
    updateAgentBinding: jest.fn(),
  },
}));

jest.mock('@/services/workflowApiService', () => ({
  workflowApiService: {
    getWorkflow: jest.fn(),
    listWorkflows: jest.fn(),
  },
}));

jest.mock('@/services/executionApiService', () => ({
  executionApiService: {
    listExecutions: jest.fn(),
    startExecution: jest.fn(),
    cancelExecution: jest.fn(),
    pauseExecution: jest.fn(),
    approveExecution: jest.fn(),
    denyExecution: jest.fn(),
  },
}));

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: { listAgentConfigs: jest.fn().mockResolvedValue([]) },
}));

jest.mock('@/services/server', () => ({
  default: { subscribe: jest.fn().mockReturnValue(jest.fn()), query: jest.fn(), mutate: jest.fn() },
}));

jest.mock('@/hooks/useExecutionSubscription', () => ({
  useExecutionSubscription: () => ({ events: [] }),
}));

jest.mock('@/services/replayService', () => ({
  replayService: { getByExecution: jest.fn() },
}));

import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';
import { executionApiService } from '../../services/executionApiService';
import { AppDetailView } from '../AppDetailView';

// ---- Fixtures ----

const baseApp = {
  appId: 'app-1',
  orgId: 'org-1',
  name: 'Test App',
  description: '',
  status: 'DRAFT' as const,
  workflowIds: ['wf-1'],
  agentBindings: [{ agentId: 'a1', name: 'Agent', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' }],
  permissions: [],
  configSchema: null,
  configValues: null,
  createdBy: 'u1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  version: 1,
};

const runningExecution = {
  executionId: 'exec-run-1',
  workflowId: 'wf-1',
  status: 'RUNNING',
  startedAt: '2024-06-01T00:00:00Z',
  triggeredBy: 'user',
  currentNode: 'node-a',
  approvalRequests: [],
};

const awaitingExecution = {
  executionId: 'exec-await-1',
  workflowId: 'wf-1',
  status: 'awaiting_approval',
  startedAt: '2024-06-01T00:00:00Z',
  triggeredBy: 'user',
  currentNode: 'node-b',
  approvalRequests: [
    { requestType: 'human_approval', reason: 'Needs review', requestedBy: 'agent', requestedAt: '2024-06-01T00:01:00Z' },
  ],
};

const defaultProps = { appId: 'app-1', onBack: jest.fn(), onNavigate: jest.fn() };

function setup(executions: any[] = [], overrideApp?: Partial<typeof baseApp>) {
  (appApiService.getApp as jest.Mock).mockResolvedValue({ ...baseApp, ...overrideApp });
  (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
    workflowId: 'wf-1', name: 'Wf', status: 'PUBLISHED', nodes: [{ id: 'n1' }],
  });
  (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: executions, nextToken: null });
}

async function goToExecutions() {
  await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Executions'));
}

// ---- Tests ----

describe('AppDetailView execution actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    mockCanApproveExecutions.mockReturnValue(true);
  });

  it('shows Pause button for a RUNNING execution when user is architect', async () => {
    setup([runningExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByTestId('pause-execution-action')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pause-execution-action')).toHaveTextContent('Pause');
  });

  it('shows Approve and Deny buttons and reason for awaiting_approval', async () => {
    setup([awaitingExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByTestId('approve-execution-action')).toBeInTheDocument();
    });
    expect(screen.getByTestId('deny-execution-action')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reason')).toHaveTextContent('Needs review');
  });

  it('does not show actions column when canApproveExecutions is false (developer role)', async () => {
    mockCanApproveExecutions.mockReturnValue(false);
    setup([runningExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByText(runningExecution.executionId.slice(0, 12) + '...')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pause-execution-action')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('approve calls executionApiService.approveExecution and reloads', async () => {
    (executionApiService.approveExecution as jest.Mock).mockResolvedValue({});
    setup([awaitingExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByTestId('approve-execution-action')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('approve-execution-action'));

    await waitFor(() => {
      expect(executionApiService.approveExecution).toHaveBeenCalledWith('exec-await-1', 'node-b');
    });

    // loadExecutions called again after approve
    await waitFor(() => {
      expect(executionApiService.listExecutions).toHaveBeenCalledTimes(2);
    });
  });
});
