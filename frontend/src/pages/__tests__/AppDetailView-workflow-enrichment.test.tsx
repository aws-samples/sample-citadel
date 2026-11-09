/**
 * CIT-289: Workflow card enrichment, bind picker placeholder toggle,
 * sort order, and short-ID copy-to-clipboard tests.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// --- Mock prop types ---
type P = React.PropsWithChildren<Record<string, unknown>>;
type ChangeEvent = React.ChangeEvent<HTMLInputElement>;

// --- UI component mocks (matching project convention) ---
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: P) => React.createElement('span', { className: className as string }, children),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: P) =>
    React.createElement('button', { onClick: onClick as React.MouseEventHandler, disabled: disabled as boolean, className: className as string, ...props }, children),
}));
let tabsOnValueChange: ((v: string) => void) | null = null;
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }: P) => {
    tabsOnValueChange = onValueChange as (v: string) => void;
    return React.createElement('div', { 'data-testid': 'tabs', 'data-value': value as string }, children);
  },
  TabsList: ({ children }: P) => React.createElement('div', { role: 'tablist' }, children),
  TabsTrigger: ({ children, value, className }: P) =>
    React.createElement('button', { role: 'tab', 'data-value': value as string, className: className as string, onClick: () => tabsOnValueChange?.(value as string) }, children),
  TabsContent: ({ children, value }: P) =>
    React.createElement('div', { role: 'tabpanel', 'data-tab': value as string }, children),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: P) => (open as boolean) ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: P) => React.createElement('div', null, children),
  DialogHeader: ({ children }: P) => React.createElement('div', null, children),
  DialogTitle: ({ children }: P) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: P) => React.createElement('p', null, children),
  DialogFooter: ({ children }: P) => React.createElement('div', null, children),
}));
jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => React.createElement('textarea', props as React.TextareaHTMLAttributes<HTMLTextAreaElement>),
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => React.createElement('input', props as React.InputHTMLAttributes<HTMLInputElement>),
}));
jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: P) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: P) => React.createElement('div', null, children),
  SelectContent: ({ children }: P) => React.createElement('div', null, children),
  SelectItem: ({ children }: P) => React.createElement('div', null, children),
  SelectValue: () => null,
}));
jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: (props: { value?: string; onChange: (v: string) => void }) =>
    React.createElement('input', { 'data-testid': 'model-override', value: props.value || '', onChange: (e: ChangeEvent) => props.onChange(e.target.value) }),
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1', canApproveExecutions: false, loading: false }),
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className, ...props }: P) => React.createElement('div', { className: className as string, ...props }, children),
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: P) => React.createElement('div', null, children),
}));
jest.mock('@/components/ExecutionDetailSheet', () => ({
  ExecutionDetailSheet: () => null,
}));
jest.mock('@/components/ExecutionDecisionDialog', () => ({
  ExecutionDecisionDialog: () => null,
  ExecutionDecisionKind: {},
}));
jest.mock('@/hooks/useExecutionSubscription', () => ({
  useExecutionSubscription: () => ({ events: [], nodeResults: {}, executionStatus: null }),
}));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: P) => React.createElement('div', null, children),
  LineChart: ({ children }: P) => React.createElement('div', null, children),
  AreaChart: ({ children }: P) => React.createElement('div', null, children),
  Line: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

// Mock services
jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getApp: jest.fn(),
    updateApp: jest.fn(),
    removeAppComponent: jest.fn(),
    unbindWorkflowFromApp: jest.fn(),
    bindWorkflowToApp: jest.fn(),
    setAppConfigValues: jest.fn(),
    addAppComponent: jest.fn(),
    activateApp: jest.fn(),
    publishApp: jest.fn(),
    unpublishApp: jest.fn(),
    listAppApiKeys: jest.fn().mockResolvedValue([]),
    createAppApiKey: jest.fn(),
    deleteAppApiKey: jest.fn(),
    getAppMetrics: jest.fn().mockResolvedValue(null),
    grantAppAccess: jest.fn(),
    getAppAccess: jest.fn().mockResolvedValue([]),
    deleteApp: jest.fn(),
    deprecateApp: jest.fn(),
    restoreApp: jest.fn(),
  },
}));
jest.mock('@/services/workflowApiService', () => ({
  workflowApiService: {
    getWorkflow: jest.fn(),
    listWorkflows: jest.fn(),
    publishWorkflow: jest.fn(),
  },
}));
jest.mock('@/services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    listExecutions: jest.fn().mockResolvedValue({ items: [] }),
    pauseExecution: jest.fn(),
    resumeExecution: jest.fn(),
    getExecution: jest.fn(),
    cancelExecution: jest.fn(),
    approveExecutionStep: jest.fn(),
    rejectExecutionStep: jest.fn(),
  },
}));
jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('@/services/server', () => ({
  __esModule: true,
  default: { query: jest.fn(), mutate: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}));
jest.mock('@/services/replayService', () => ({
  replayService: { downloadExecutionReplay: jest.fn() },
}));

import { AppDetailView } from '../AppDetailView';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

const placeholderDef = JSON.stringify({
  nodes: [
    { id: 'n1', agentId: 'placeholder-analyst', position: { x: 0, y: 0 }, configuration: {} },
    { id: 'n2', agentId: 'real-agent', position: { x: 200, y: 0 }, configuration: {} },
  ],
  edges: [],
});

const cleanDef = JSON.stringify({
  nodes: [
    { id: 'n1', agentId: 'agent-a', position: { x: 0, y: 0 }, configuration: {} },
    { id: 'n2', agentId: 'agent-b', position: { x: 200, y: 0 }, configuration: {} },
  ],
  edges: [],
});

const mockApp = {
  appId: 'app-123',
  orgId: 'org-1',
  name: 'Test App',
  description: 'desc',
  status: 'DRAFT' as const,
  workflowIds: ['wf-aaa111', 'wf-bbb222'],
  agentBindings: [],
  permissions: [],
  configSchema: '{}',
  configValues: '{}',
  createdBy: 'user-1',
  createdByName: 'Jane',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const wf1 = {
  workflowId: 'wf-aaa111',
  name: 'Bravo Workflow',
  status: 'DRAFT',
  version: 2,
  definition: placeholderDef,
  createdAt: '2024-06-01T00:00:00Z',
  updatedAt: '2024-06-10T00:00:00Z',
};

const wf2 = {
  workflowId: 'wf-bbb222',
  name: 'Alpha Workflow',
  status: 'PUBLISHED',
  version: 3,
  definition: cleanDef,
  createdAt: '2024-05-01T00:00:00Z',
  updatedAt: '2024-05-20T00:00:00Z',
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
  initialTab: 'workflows',
};

describe('CIT-289: Workflow card enrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockImplementation((id: string) => {
      if (id === 'wf-aaa111') return Promise.resolve(wf1);
      if (id === 'wf-bbb222') return Promise.resolve(wf2);
      return Promise.resolve(null);
    });
  });

  it('renders version badge on workflow cards', async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
  });

  it('renders created and updated dates with relative text', async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      // Dates are relative so we just check they exist with "Created" and "Updated"
      const createdTexts = screen.getAllByText(/Created /);
      expect(createdTexts.length).toBeGreaterThanOrEqual(1);
      const updatedTexts = screen.getAllByText(/Updated /);
      expect(updatedTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders placeholder badge only for workflows with placeholder agentIds', async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      // wf-aaa111 has placeholder nodes
      expect(screen.getByTestId('placeholder-badge-wf-aaa111')).toBeInTheDocument();
      // wf-bbb222 does not
      expect(screen.queryByTestId('placeholder-badge-wf-bbb222')).not.toBeInTheDocument();
    });
  });

  it('sorts workflows by name ascending then createdAt descending', async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Alpha Workflow')).toBeInTheDocument();
      expect(screen.getByText('Bravo Workflow')).toBeInTheDocument();
    });
    // Alpha should appear before Bravo in the DOM
    const alphaEl = screen.getByText('Alpha Workflow');
    const bravoEl = screen.getByText('Bravo Workflow');
    // compareDocumentPosition: 4 = DOCUMENT_POSITION_FOLLOWING (bravo after alpha)
    expect(alphaEl.compareDocumentPosition(bravoEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders short ID with last 6 chars', async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/…aaa111/)).toBeInTheDocument();
      expect(screen.getByText(/…bbb222/)).toBeInTheDocument();
    });
  });

  it('copies full workflowId to clipboard on short ID click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('copy-id-wf-aaa111')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('copy-id-wf-aaa111'));
    expect(writeText).toHaveBeenCalledWith('wf-aaa111');
  });
});

describe('CIT-289: Bind picker placeholder toggle', () => {
  const unboundWfPlaceholder = {
    workflowId: 'wf-unbound-ph1111',
    name: 'Placeholder Draft',
    status: 'DRAFT',
    version: 1,
    definition: placeholderDef,
    createdAt: '2024-07-01T00:00:00Z',
    updatedAt: '2024-07-01T00:00:00Z',
  };
  const unboundWfClean = {
    workflowId: 'wf-unbound-clean2',
    name: 'Clean Workflow',
    status: 'PUBLISHED',
    version: 1,
    definition: cleanDef,
    createdAt: '2024-07-02T00:00:00Z',
    updatedAt: '2024-07-02T00:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, workflowIds: [] });
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [unboundWfPlaceholder, unboundWfClean],
    });
  });

  it('hides placeholder-node drafts by default in bind picker', async () => {
    const user = userEvent.setup();
    render(<AppDetailView {...defaultProps} initialTab="workflows" />);

    await waitFor(() => {
      const bindBtns = screen.getAllByText(/Bind Workflow/);
      expect(bindBtns.length).toBeGreaterThanOrEqual(1);
    });

    // Click first "Bind Workflow" button to open picker
    const bindButtons = screen.getAllByText(/Bind Workflow/);
    await user.click(bindButtons[0]);

    await waitFor(() => {
      // Clean workflow visible
      expect(screen.getByText('Clean Workflow')).toBeInTheDocument();
      // Placeholder workflow hidden by default
      expect(screen.queryByText('Placeholder Draft')).not.toBeInTheDocument();
    });
  });

  it('shows placeholder-node drafts when toggle is checked', async () => {
    const user = userEvent.setup();
    render(<AppDetailView {...defaultProps} initialTab="workflows" />);

    await waitFor(() => {
      const bindBtns = screen.getAllByText(/Bind Workflow/);
      expect(bindBtns.length).toBeGreaterThanOrEqual(1);
    });

    const bindButtons = screen.getAllByText(/Bind Workflow/);
    await user.click(bindButtons[0]);

    await waitFor(() => {
      expect(screen.getByTestId('show-placeholder-toggle')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('show-placeholder-toggle'));

    await waitFor(() => {
      expect(screen.getByText('Placeholder Draft')).toBeInTheDocument();
      expect(screen.getByText('Clean Workflow')).toBeInTheDocument();
    });
  });
});
