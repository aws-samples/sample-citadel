/**
 * AppDetailView — execution detail sheet tests
 * TDD Red phase — clicking (or keyboard-activating) an execution row in the
 * Executions tab opens the ExecutionDetailSheet with that execution's output.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components to avoid versioned import issues (same idiom as sibling tests)
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, 'data-variant': variant, ...props }, children),
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

// Passthrough Sheet mock — renders children only when open
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null,
  SheetContent: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  SheetHeader: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  SheetTitle: ({ children, className, title }: any) =>
    React.createElement('h2', { className, title }, children),
  SheetDescription: ({ children, className }: any) =>
    React.createElement('p', { className }, children),
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
    publishWorkflow: jest.fn(),
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
  configSchema: null,
  configValues: null,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const publishedWorkflow = {
  workflowId: 'wf-1',
  name: 'Test Workflow',
  status: 'PUBLISHED',
  nodes: [{ id: 'n1' }],
};

const executionItem = {
  executionId: 'exec-abcdef123456',
  workflowId: 'wf-1',
  status: 'SUCCEEDED',
  workflowVersion: 2,
  triggeredBy: 'user-1',
  startedAt: '2024-01-01T00:00:00Z',
  completedAt: '2024-01-01T00:05:00Z',
  input: '{"q":"hi"}',
  output: '{"answer":42}',
  error: null,
  nodeResults: JSON.stringify({
    n1: {
      nodeId: 'n1',
      agentId: 'agent-1',
      status: 'completed',
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T00:05:00Z',
      output: '{"ok":true}',
      error: null,
      retryCount: 0,
    },
  }),
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

const prettyOutput = JSON.stringify({ answer: 42 }, null, 2);
const preWithText = (expected: string) => (_: string, el: Element | null) =>
  el?.tagName === 'PRE' && el.textContent === expected;

describe('AppDetailView — execution detail sheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(publishedWorkflow);
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
      items: [executionItem],
    });
    (serverService.subscribe as jest.Mock).mockReturnValue(jest.fn());
  });

  const openExecutionsTab = async () => {
    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Executions'));
    await waitFor(() => expect(screen.getByText(/exec-abcdef1/)).toBeInTheDocument());
  };

  it('opens the detail sheet with the execution output when a row is clicked', async () => {
    await openExecutionsTab();

    // Sheet is closed until a row is activated
    expect(screen.queryByText(preWithText(prettyOutput))).not.toBeInTheDocument();

    const row = screen.getByRole('button', { name: /view execution exec-abcdef123456/i });
    expect(row.className).toMatch(/cursor-pointer/);

    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(preWithText(prettyOutput))).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Copy result' })).toBeInTheDocument();
  });

  it('opens the detail sheet via keyboard Enter on a row', async () => {
    await openExecutionsTab();

    const row = screen.getByRole('button', { name: /view execution exec-abcdef123456/i });
    fireEvent.keyDown(row, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(preWithText(prettyOutput))).toBeInTheDocument();
    });
  });

  it('opens the detail sheet via keyboard Space on a row', async () => {
    await openExecutionsTab();

    const row = screen.getByRole('button', { name: /view execution exec-abcdef123456/i });
    fireEvent.keyDown(row, { key: ' ' });

    await waitFor(() => {
      expect(screen.getByText(preWithText(prettyOutput))).toBeInTheDocument();
    });
  });

  it('keeps the empty state with the Go to Workflows CTA when no executions exist', async () => {
    (executionApiService.listExecutions as jest.Mock).mockResolvedValue({ items: [] });

    render(<AppDetailView {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Executions'));

    await waitFor(() => {
      expect(screen.getByText('No executions recorded yet.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Go to Workflows' })).toBeInTheDocument();
  });
});
