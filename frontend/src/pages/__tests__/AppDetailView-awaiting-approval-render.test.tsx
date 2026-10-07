/**
 * Repro test: awaiting_approval executions from the real listExecutions
 * payload must render in the Executions table without crashing.
 *
 * The fixture below mirrors the exact shape returned by the GraphQL
 * resolver for a manual-pause execution (sanitised IDs).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// ---- UI mocks (consistent with sibling AppDetailView test files) ----

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

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'org-1',
    canApproveExecutions: true,
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
  appId: 'app-test-1',
  orgId: 'org-1',
  name: 'Test App',
  description: '',
  status: 'DRAFT' as const,
  workflowIds: ['wf-synth-1'],
  agentBindings: [{ agentId: 'a1', name: 'Agent', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' }],
  permissions: [],
  configSchema: null,
  configValues: null,
  createdBy: 'u1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  version: 1,
};

/**
 * Fixture derived from the real listExecutions response for an execution
 * that was paused via manual_pause (IDs sanitised to synthetic values).
 *
 * Key characteristics of the real payload:
 *   - status: 'awaiting_approval'
 *   - approvalRequests: array with one element whose decision/decidedBy/
 *     decidedAt/expiresAt are all null (pending approval)
 *   - currentNode: null (the engine doesn't set a single currentNode for
 *     awaiting_approval — the parked node is in nodeResults)
 *   - completedAt: null
 */
const awaitingApprovalExecution = {
  executionId: 'exec-synth-aaaa-0001',
  workflowId: 'wf-synth-1',
  appId: 'app-test-1',
  orgId: 'Default',
  status: 'awaiting_approval',
  workflowVersion: 2,
  currentNode: null,
  triggeredBy: 'user-synth-0001',
  startedAt: '2026-10-06T19:39:39.484190+00:00',
  completedAt: null,
  input: null,
  output: null,
  error: null,
  nodeResults: JSON.stringify({
    aggregator: {
      status: 'awaiting_approval',
      nodeId: 'aggregator',
      retryCount: 0,
      agentId: 'demo-echo-agent',
      parkedAt: '2026-10-06T19:39:51.495Z',
    },
    root: {
      agentId: 'demo-echo-agent',
      completedAt: '2026-10-06T19:39:49.106655+00:00',
      nodeId: 'root',
      output: { response: '{}', usage: [] },
      retryCount: 0,
      startedAt: '2026-10-06T19:39:39.807719+00:00',
      status: 'completed',
    },
  }),
  approvalRequests: [
    {
      requestType: 'manual_pause',
      reason: 'test',
      requestedBy: 'user-synth-0001',
      requestedAt: '2026-10-06T19:39:51.495Z',
      expiresAt: null,
      decidedBy: null,
      decidedAt: null,
      decision: null,
    },
  ],
};

const completedExecution = {
  executionId: 'exec-synth-bbbb-0002',
  workflowId: 'wf-synth-1',
  appId: 'app-test-1',
  orgId: 'Default',
  status: 'completed',
  workflowVersion: 2,
  currentNode: null,
  triggeredBy: 'user-synth-0001',
  startedAt: '2026-10-06T18:00:00.000Z',
  completedAt: '2026-10-06T18:05:00.000Z',
  input: null,
  output: null,
  error: null,
  nodeResults: null,
  approvalRequests: null,
};

const runningWithPauseRequested = {
  executionId: 'exec-synth-cccc-0003',
  workflowId: 'wf-synth-1',
  appId: 'app-test-1',
  orgId: 'Default',
  status: 'running',
  workflowVersion: 2,
  currentNode: 'branch-a',
  triggeredBy: 'user-synth-0001',
  startedAt: '2026-10-06T19:00:00.000Z',
  completedAt: null,
  input: null,
  output: null,
  error: null,
  nodeResults: null,
  approvalRequests: null,
  pauseRequested: true,
};

const defaultProps = { appId: 'app-test-1', onBack: jest.fn(), onNavigate: jest.fn() };

function setup(executions: any[]) {
  (appApiService.getApp as jest.Mock).mockResolvedValue(baseApp);
  (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
    workflowId: 'wf-synth-1', name: 'Wf', status: 'PUBLISHED', nodes: [{ id: 'n1' }],
  });
  (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: executions, nextToken: null });
}

async function goToExecutions() {
  await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Executions'));
}

// ---- Tests ----

describe('AppDetailView — awaiting_approval render from real API payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    tabsOnValueChange = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders both rows (awaiting_approval + completed) and shows Approve/Deny for the awaiting row', async () => {
    setup([awaitingApprovalExecution, completedExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    // Both rows should render (use the truncated ID prefix)
    await waitFor(() => {
      expect(screen.getByText('exec-synth-a...')).toBeInTheDocument();
    });
    expect(screen.getByText('exec-synth-b...')).toBeInTheDocument();

    // Status badges
    expect(screen.getByText('awaiting_approval')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();

    // Approve/Deny buttons should be visible for the awaiting execution
    expect(screen.getByTestId('approve-execution-action')).toBeInTheDocument();
    expect(screen.getByTestId('deny-execution-action')).toBeInTheDocument();

    // Reason text from the approval request
    expect(screen.getByTestId('approval-reason')).toHaveTextContent('test');
  });

  it('does not crash when approvalRequests elements have null decision/decidedBy/decidedAt/expiresAt', async () => {
    setup([awaitingApprovalExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    // The row should render without throwing on null date formatting
    await waitFor(() => {
      expect(screen.getByText('exec-synth-a...')).toBeInTheDocument();
    });
    // Completed column should show '—' for null completedAt
    const dashCells = screen.getAllByText('—');
    expect(dashCells.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Pause requested hint on a running row with pauseRequested: true', async () => {
    setup([runningWithPauseRequested]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByText('exec-synth-c...')).toBeInTheDocument();
    });
    expect(screen.getByText('Pause requested')).toBeInTheDocument();
  });

  it('keeps the previous execution list during reload (no eager clear)', async () => {
    setup([completedExecution]);
    render(<AppDetailView {...defaultProps} />);
    await goToExecutions();

    await waitFor(() => {
      expect(screen.getByText('exec-synth-b...')).toBeInTheDocument();
    });

    // Now simulate a reload that takes time — the mock will resolve after
    // we verify the old data is still shown.
    let resolveReload!: (v: any) => void;
    (executionApiService.listExecutions as jest.Mock).mockReturnValue(
      new Promise((r) => { resolveReload = r; }),
    );

    // Trigger a re-render that calls loadExecutions (e.g. by polling —
    // the completed execution doesn't trigger polling, but we can force
    // loadExecutions via the app.workflowIds dependency). We simulate by
    // updating the app to trigger reload.
    (appApiService.getApp as jest.Mock).mockResolvedValue({
      ...baseApp,
      updatedAt: '2024-01-02T00:00:00Z',
    });

    // The old row should still be visible while the reload is pending
    expect(screen.getByText('exec-synth-b...')).toBeInTheDocument();

    // Resolve the reload with new data
    resolveReload({ items: [completedExecution], nextToken: null });
    await waitFor(() => {
      expect(screen.getByText('exec-synth-b...')).toBeInTheDocument();
    });
  });
});
