/**
 * AppDetailView — Bind Workflow Picker filtering (CIT-292)
 *
 * Tests:
 * - Workflows bound to another app are hidden by default
 * - Toggle reveals them as disabled with owner label
 * - Unbound and bound-to-this-app workflows remain selectable
 * - Same-name groups show a count badge
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

// --- Mock prop types ---
type P = React.PropsWithChildren<Record<string, unknown>>;

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
    React.createElement('button', {
      role: 'tab',
      'data-value': value as string,
      className: className as string,
      onClick: () => tabsOnValueChange?.(value as string),
    }, children),
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

jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: (props: { value?: string; onChange: (v: string) => void }) =>
    React.createElement('input', {
      'data-testid': 'model-override',
      value: props.value || '',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value),
    }),
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1', canApproveExecutions: false, loading: false }),
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
    listApps: jest.fn(),
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

import { AppDetailView } from '../AppDetailView';

const mockApp = {
  appId: 'app-123',
  orgId: 'org-1',
  name: 'Test App',
  description: 'A test application',
  status: 'DRAFT' as const,
  workflowIds: ['wf-bound-here'],
  agentBindings: [{ agentId: 'agent-1', name: 'Agent One', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' }],
  permissions: [],
  configSchema: null,
  configValues: null,
  createdBy: 'user-1',
  createdByName: 'Jane Doe',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const mockBoundWorkflow = {
  workflowId: 'wf-bound-here',
  name: 'Bound Here',
  status: 'PUBLISHED',
  nodes: [{ id: 'n1' }],
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

/** Helper: open Workflows tab, click "Bind Workflow" */
async function openBindDialog() {
  render(<AppDetailView {...defaultProps} />);
  await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Workflows'));
  await waitFor(() => {
    const bindButtons = screen.getAllByText('Bind Workflow');
    fireEvent.click(bindButtons[0]);
  });
  await waitFor(() => expect(screen.getByText('Bind Workflow to App')).toBeInTheDocument());
}

describe('AppDetailView — bind picker filter (CIT-292)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockBoundWorkflow);
  });

  it('hides workflows bound to another app by default', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-free', name: 'Free Workflow', status: 'DRAFT', appId: null },
        { workflowId: 'wf-other', name: 'Other App WF', status: 'PUBLISHED', appId: 'app-other' },
        { workflowId: 'wf-bound-here', name: 'Bound Here', status: 'PUBLISHED', appId: 'app-123' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [
        { appId: 'app-123', name: 'Test App' },
        { appId: 'app-other', name: 'Other Application' },
      ],
    });

    await openBindDialog();

    // Free workflow visible in the picker
    expect(screen.getByText('Free Workflow')).toBeInTheDocument();
    // Bound-to-other hidden by default
    expect(screen.queryByText('Other App WF')).not.toBeInTheDocument();
    // Bound-to-this-app is excluded by the boundIds filter (already bound),
    // so it does NOT appear in the picker list. However the name appears on
    // the Workflows tab card, so assert it is absent from the dialog picker.
    expect(screen.queryByTestId('picker-workflow-wf-bound-here')).not.toBeInTheDocument();
  });

  it('shows bound-elsewhere workflows disabled with owner label when toggle is checked', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-free', name: 'Free Workflow', status: 'DRAFT', appId: null },
        { workflowId: 'wf-other', name: 'Other App WF', status: 'PUBLISHED', appId: 'app-other' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [
        { appId: 'app-other', name: 'Other Application' },
      ],
    });

    await openBindDialog();

    // Toggle on
    const toggle = screen.getByTestId('show-bound-elsewhere-toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText('Other App WF')).toBeInTheDocument();
    });

    // Owner label visible
    expect(screen.getByTestId('bound-elsewhere-label-wf-other')).toHaveTextContent('Bound to Other Application');

    // Bind button disabled for bound-elsewhere workflow
    const card = screen.getByTestId('picker-workflow-wf-other');
    const bindBtn = card.querySelector('button');
    expect(bindBtn).toBeDisabled();

    // Free workflow still bindable
    const freeCard = screen.getByTestId('picker-workflow-wf-free');
    const freeBindBtn = freeCard.querySelector('button');
    expect(freeBindBtn).not.toBeDisabled();
  });

  it('falls back to short id when app name is unavailable', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-other', name: 'Other WF', status: 'DRAFT', appId: 'app-abc123-def456' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [] });

    await openBindDialog();
    fireEvent.click(screen.getByTestId('show-bound-elsewhere-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('bound-elsewhere-label-wf-other')).toHaveTextContent('Bound to def456');
    });
  });

  it('unbound workflows remain bindable', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-free-1', name: 'Free One', status: 'DRAFT', appId: null },
        { workflowId: 'wf-free-2', name: 'Free Two', status: 'PUBLISHED' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [] });
    (appApiService.bindWorkflowToApp as jest.Mock).mockResolvedValue({});

    await openBindDialog();

    expect(screen.getByText('Free One')).toBeInTheDocument();
    expect(screen.getByText('Free Two')).toBeInTheDocument();

    // Both have enabled Bind buttons
    const card1 = screen.getByTestId('picker-workflow-wf-free-1');
    expect(card1.querySelector('button')).not.toBeDisabled();
    const card2 = screen.getByTestId('picker-workflow-wf-free-2');
    expect(card2.querySelector('button')).not.toBeDisabled();
  });

  it('groups same-name workflows and shows count badge', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-a1', name: 'My Workflow', status: 'DRAFT', createdAt: '2024-01-01T00:00:00Z' },
        { workflowId: 'wf-a2', name: 'My Workflow', status: 'PUBLISHED', createdAt: '2024-01-02T00:00:00Z' },
        { workflowId: 'wf-a3', name: 'My Workflow', status: 'DRAFT', createdAt: '2024-01-03T00:00:00Z' },
        { workflowId: 'wf-b1', name: 'Other Workflow', status: 'DRAFT' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [] });

    await openBindDialog();

    // Group header for "My Workflow" with 3 copies
    const groupHeader = screen.getByTestId('group-header-My Workflow');
    expect(groupHeader).toBeInTheDocument();
    expect(groupHeader).toHaveTextContent('3 copies');

    // Single "Other Workflow" should NOT have a group header
    expect(screen.queryByTestId('group-header-Other Workflow')).not.toBeInTheDocument();
    expect(screen.getByText('Other Workflow')).toBeInTheDocument();
  });

  it('keeps placeholder-draft hiding toggle working alongside bound-elsewhere filter', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-placeholder', name: 'Placeholder WF', status: 'DRAFT', definition: JSON.stringify({ nodes: [{ id: 'n1', agentId: 'placeholder-fabricated-agent' }] }) },
        { workflowId: 'wf-normal', name: 'Normal WF', status: 'DRAFT' },
      ],
    });
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [] });

    await openBindDialog();

    // Placeholder hidden by default
    expect(screen.queryByText('Placeholder WF')).not.toBeInTheDocument();
    expect(screen.getByText('Normal WF')).toBeInTheDocument();

    // Show placeholders
    fireEvent.click(screen.getByTestId('show-placeholder-toggle'));
    await waitFor(() => {
      expect(screen.getByText('Placeholder WF')).toBeInTheDocument();
    });
  });
});
