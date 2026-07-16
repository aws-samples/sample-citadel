/**
 * AppDetailView workflow-run experience tests
 * Tests: PUBLISHED-gated Run action on workflow cards, live execution progress
 * via onWorkflowProgress subscription, Executions tab wired to listExecutions,
 * and the non-blocking draft-workflow warning in publish preconditions.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components to avoid versioned import issues
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

// Stateful Tabs mock that tracks active tab
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

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
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

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@/services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    listExecutions: jest.fn(),
    cancelExecution: jest.fn(),
    getExecution: jest.fn(),
  },
}));

// Capture subscription callbacks (both onAppStatusChange and onWorkflowProgress)
jest.mock('@/services/server', () => ({
  __esModule: true,
  default: {
    subscribe: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

// Import after mocks
import { AppDetailView } from '../AppDetailView';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';
import { executionApiService } from '../../services/executionApiService';
import serverService from '../../services/server';
import { toast } from 'sonner';

const mockApp = {
  appId: 'app-123',
  orgId: 'org-1',
  name: 'Test App',
  description: 'A test application',
  status: 'DRAFT' as const,
  workflowIds: ['wf-1'],
  agentBindings: [
    {
      agentId: 'agent-1',
      status: 'READY' as const,
      addedAt: '2024-01-01T00:00:00Z',
    },
  ],
  permissions: [],
  configSchema: JSON.stringify({ type: 'object', properties: { apiKey: { type: 'string' } } }),
  configValues: JSON.stringify({ apiKey: 'test-key' }),
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const publishedWorkflow = {
  workflowId: 'wf-1',
  name: 'Test Workflow',
  status: 'PUBLISHED',
  nodes: [{ id: 'n1' }, { id: 'n2' }],
};

const draftWorkflow = { ...publishedWorkflow, status: 'DRAFT' };

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

/** Captured onWorkflowProgress subscription callbacks keyed by executionId */
let progressSubscriptions: Array<{ executionId: string; cb: (data: any) => void }>;

describe('AppDetailView — workflow Run action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    progressSubscriptions = [];
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(publishedWorkflow);
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: [] });
    (serverService.subscribe as jest.Mock).mockImplementation(
      (query: string, vars: any, cb: (data: any) => void) => {
        if (query.includes('onWorkflowProgress')) {
          progressSubscriptions.push({ executionId: vars.executionId, cb });
        }
        return jest.fn();
      },
    );
  });

  const openWorkflowsTab = async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Workflows'));
    await waitFor(() => expect(screen.getByText('Test Workflow')).toBeInTheDocument());
  };

  it('disables Run and shows a draft hint when the workflow is not PUBLISHED', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(draftWorkflow);

    await openWorkflowsTab();

    const runButton = screen.getByRole('button', { name: /run test workflow/i });
    expect(runButton).toBeDisabled();
    expect(screen.getByText('Draft — publish in the studio first')).toBeInTheDocument();
  });

  it('enables Run for a PUBLISHED workflow and starts an execution on click', async () => {
    (executionApiService.startExecution as jest.Mock).mockResolvedValue({
      executionId: 'exec-9',
      workflowId: 'wf-1',
      status: 'PENDING',
    });

    await openWorkflowsTab();

    const runButton = screen.getByRole('button', { name: /run test workflow/i });
    expect(runButton).not.toBeDisabled();
    expect(screen.queryByText('Draft — publish in the studio first')).not.toBeInTheDocument();

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(executionApiService.startExecution).toHaveBeenCalledWith('wf-1');
    });

    // The execution id is fed into the progress subscription
    await waitFor(() => {
      expect(progressSubscriptions.some((s) => s.executionId === 'exec-9')).toBe(true);
    });
  });

  it('updates the inline run indicator from subscription events and toasts on completion', async () => {
    (executionApiService.startExecution as jest.Mock).mockResolvedValue({
      executionId: 'exec-9',
      workflowId: 'wf-1',
      status: 'PENDING',
    });

    await openWorkflowsTab();

    fireEvent.click(screen.getByRole('button', { name: /run test workflow/i }));

    await waitFor(() => {
      expect(progressSubscriptions.some((s) => s.executionId === 'exec-9')).toBe(true);
    });
    const sub = progressSubscriptions.find((s) => s.executionId === 'exec-9')!;

    // workflow.started → Running indicator
    act(() => {
      sub.cb({
        onWorkflowProgress: {
          executionId: 'exec-9',
          workflowId: 'wf-1',
          eventType: 'workflow.started',
          nodeId: null,
          status: 'running',
          output: null,
          error: null,
          timestamp: '2024-01-01T00:00:00Z',
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());

    // workflow.completed → Completed indicator + success toast
    act(() => {
      sub.cb({
        onWorkflowProgress: {
          executionId: 'exec-9',
          workflowId: 'wf-1',
          eventType: 'workflow.completed',
          nodeId: null,
          status: 'completed',
          output: '{"ok":true}',
          error: null,
          timestamp: '2024-01-01T00:01:00Z',
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    expect(toast.success).toHaveBeenCalled();
  });

  it('toasts an error when the run fails', async () => {
    (executionApiService.startExecution as jest.Mock).mockResolvedValue({
      executionId: 'exec-9',
      workflowId: 'wf-1',
      status: 'PENDING',
    });

    await openWorkflowsTab();

    fireEvent.click(screen.getByRole('button', { name: /run test workflow/i }));

    await waitFor(() => {
      expect(progressSubscriptions.some((s) => s.executionId === 'exec-9')).toBe(true);
    });
    const sub = progressSubscriptions.find((s) => s.executionId === 'exec-9')!;

    act(() => {
      sub.cb({
        onWorkflowProgress: {
          executionId: 'exec-9',
          workflowId: 'wf-1',
          eventType: 'workflow.failed',
          nodeId: 'n1',
          status: 'failed',
          output: null,
          error: 'Agent timeout',
          timestamp: '2024-01-01T00:01:00Z',
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument());
    expect(toast.error).toHaveBeenCalled();
  });

  it('refreshes the executions list after a run completes', async () => {
    (executionApiService.startExecution as jest.Mock).mockResolvedValue({
      executionId: 'exec-9',
      workflowId: 'wf-1',
      status: 'PENDING',
    });

    await openWorkflowsTab();

    const callsBeforeRun = (executionApiService.listExecutions as jest.Mock).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /run test workflow/i }));

    await waitFor(() => {
      expect(progressSubscriptions.some((s) => s.executionId === 'exec-9')).toBe(true);
    });
    const sub = progressSubscriptions.find((s) => s.executionId === 'exec-9')!;

    act(() => {
      sub.cb({
        onWorkflowProgress: {
          executionId: 'exec-9',
          workflowId: 'wf-1',
          eventType: 'workflow.completed',
          nodeId: null,
          status: 'completed',
          output: null,
          error: null,
          timestamp: '2024-01-01T00:01:00Z',
        },
      });
    });

    await waitFor(() => {
      expect(
        (executionApiService.listExecutions as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(callsBeforeRun);
    });
  });
});

describe('AppDetailView — Executions tab wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    progressSubscriptions = [];
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(publishedWorkflow);
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  it('lists executions fetched via listExecutions for bound workflows', async () => {
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
      items: [
        {
          executionId: 'exec-abcdef123456',
          workflowId: 'wf-1',
          status: 'SUCCEEDED',
          startedAt: '2024-01-01T00:00:00Z',
          completedAt: '2024-01-01T00:05:00Z',
        },
        {
          executionId: 'exec-fedcba654321',
          workflowId: 'wf-1',
          status: 'FAILED',
          startedAt: '2024-01-02T00:00:00Z',
          completedAt: '2024-01-02T00:01:00Z',
        },
      ],
    });

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Executions'));

    await waitFor(() => {
      expect(executionApiService.listExecutions).toHaveBeenCalledWith('wf-1');
    });

    await waitFor(() => {
      expect(screen.getByText(/exec-abcdef1/)).toBeInTheDocument();
    });
    expect(screen.getByText('SUCCEEDED')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.queryByText('No executions recorded yet.')).not.toBeInTheDocument();
  });

  it('keeps the empty state when no executions exist', async () => {
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: [] });

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Executions'));

    await waitFor(() => {
      expect(screen.getByText('No executions recorded yet.')).toBeInTheDocument();
    });
  });
});

describe('AppDetailView — draft-workflow publish precondition warning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    progressSubscriptions = [];
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, status: 'APPROVED' });
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: [] });
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  it('shows a non-blocking warning when a bound workflow is not PUBLISHED', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(draftWorkflow);

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Publish')).toBeInTheDocument());
    // Wait for workflows to load so preconditions can inspect their status
    await waitFor(() => expect(workflowApiService.getWorkflow).toHaveBeenCalledWith('wf-1'));

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => expect(screen.getByText('Publish App')).toBeInTheDocument());

    // Warning text names the count and points to the studio
    expect(screen.getByText(/1 workflow\(s\) not PUBLISHED/)).toBeInTheDocument();
    expect(screen.getByText(/publish (it|them) in the Agentic Studio/i)).toBeInTheDocument();

    // Warning must NOT block publishing
    expect(screen.getByText('Confirm Publish')).not.toBeDisabled();
  });

  it('does not show the warning when all bound workflows are PUBLISHED', async () => {
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(publishedWorkflow);

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Publish')).toBeInTheDocument());
    await waitFor(() => expect(workflowApiService.getWorkflow).toHaveBeenCalledWith('wf-1'));

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => expect(screen.getByText('Publish App')).toBeInTheDocument());

    expect(screen.queryByText(/workflow\(s\) not PUBLISHED/)).not.toBeInTheDocument();
    expect(screen.getByText('All bound workflows are PUBLISHED')).toBeInTheDocument();
  });
});
