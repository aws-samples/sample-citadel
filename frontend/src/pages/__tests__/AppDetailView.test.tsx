/**
 * AppDetailView unit tests
 * Tests: tab rendering (11.3-11.8), status actions (11.9-11.11), subscription placeholder (11.12)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

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

// Mock OrganizationContext
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
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

// Import after mocks
import { AppDetailView } from '../AppDetailView';

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
      name: 'Agent One',
      status: 'READY' as const,
      systemPromptAddition: 'Extra prompt',
      toolRestrictions: ['tool-x'],
      modelOverride: 'us.anthropic.claude-sonnet-4-6',
      addedAt: '2024-01-01T00:00:00Z',
    },
    {
      agentId: 'agent-2',
      status: 'DESIGN' as const,
      addedAt: '2024-01-02T00:00:00Z',
    },
  ],
  permissions: [
    {
      permissionId: 'perm-1',
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::my-bucket/*'],
      description: 'S3 read access',
    },
  ],
  configSchema: JSON.stringify({ type: 'object', properties: { apiKey: { type: 'string' } } }),
  configValues: JSON.stringify({ apiKey: 'test-key' }),
  createdBy: 'user-1',
  createdByName: 'Jane Doe',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const mockWorkflow = {
  workflowId: 'wf-1',
  name: 'Test Workflow',
  status: 'PUBLISHED',
  nodes: [{ id: 'n1' }, { id: 'n2' }],
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

describe('AppDetailView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(mockWorkflow);
  });

  // Req 11.2: Header displays name, status badge, description, createdBy, createdAt, updatedAt
  it('renders app header with name, status badge, description, and server-provided createdByName', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('A test application')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Created by Jane Doe/)).toBeInTheDocument();
    });
  });

  // Falls back to the raw createdBy id when the server did not resolve a name
  it('falls back to createdBy when createdByName is absent', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, createdByName: undefined });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Created by user-1/)).toBeInTheDocument();
    });
  });

  // Req 11.3: Tabbed navigation with all five tabs
  it('renders all five tab triggers', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Workflows')).toBeInTheDocument();
    expect(screen.getByText('Permissions')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByText('Executions')).toBeInTheDocument();
  });

  // Req 11.4: Agents tab shows binding cards with status badges and override indicators
  it('renders agent binding cards with server-provided name (falling back to agentId) on Agents tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      // agent-1 has a server-provided name and should display it, not the raw id
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    // agent-2 has no name from the server — falls back to the raw agentId
    expect(screen.getByText('agent-2')).toBeInTheDocument();
    expect(screen.queryByText('agent-1')).not.toBeInTheDocument();
    // Status badges — DRAFT is the app status, READY and DESIGN are binding statuses
    expect(screen.getByText('READY')).toBeInTheDocument();
    // DESIGN appears both as agent status and in precondition text potentially
    const designElements = screen.getAllByText('DESIGN');
    expect(designElements.length).toBeGreaterThanOrEqual(1);
  });

  // Req 11.5: Workflows tab shows workflow cards
  it('renders workflow cards on Workflows tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    // Click Workflows tab
    fireEvent.click(screen.getByText('Workflows'));

    await waitFor(() => {
      expect(screen.getByText('Test Workflow')).toBeInTheDocument();
    });

    expect(screen.getByText('2 nodes')).toBeInTheDocument();
  });

  // Req 11.6: Permissions tab shows table
  it('renders permissions table on Permissions tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Permissions'));

    await waitFor(() => {
      expect(screen.getByText('S3 read access')).toBeInTheDocument();
    });

    expect(screen.getByText('s3:GetObject')).toBeInTheDocument();
  });

  // Req 11.7: Configuration tab shows schema and values
  it('renders configuration schema and values on Configuration tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Configuration'));

    await waitFor(() => {
      expect(screen.getByText('Configuration Schema')).toBeInTheDocument();
    });

    expect(screen.getByText('Configuration Values')).toBeInTheDocument();
  });

  // Req 11.8: Executions tab shows empty state when no executions
  it('renders executions empty state on Executions tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Executions'));

    await waitFor(() => {
      expect(screen.getByText('No executions recorded yet.')).toBeInTheDocument();
    });
  });

  // Req 11.9: Status transition actions — DRAFT shows the "Activate" transition button
  // (DRAFT → APPROVED). The "Publish" button only renders for APPROVED status.
  it('shows Activate button when app is in DRAFT status', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Activate')).toBeInTheDocument();
    });
  });

  // Req 11.9: Status transition actions — Archive button for APPROVED
  it('shows Archive button when app is in APPROVED status', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, status: 'APPROVED' });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Archive')).toBeInTheDocument();
    });
  });

  // Req 11.9: Status transition actions — Reactivate button for DEPRECATED
  it('shows Reactivate button when app is in DEPRECATED status', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, status: 'DEPRECATED' });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Reactivate')).toBeInTheDocument();
    });
  });

  // Req 11.10: Confirmation dialog with preconditions
  it('opens confirmation dialog with preconditions when Publish is clicked', async () => {
    // Publish button only renders for APPROVED status
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, status: 'APPROVED' });
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Publish App')).toBeInTheDocument();
    });

    expect(screen.getByText('All agents are READY')).toBeInTheDocument();
    expect(screen.getByText('Configuration values provided')).toBeInTheDocument();
  });

  // Req 11.11: Error display with failing preconditions
  it('shows failing preconditions when DESIGN agents exist', async () => {
    // Publish button only renders for APPROVED status; mockApp already includes a DESIGN agent
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, status: 'APPROVED' });
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('1 agent(s) still in DESIGN status')).toBeInTheDocument();
    });
  });

  // Error state
  it('renders error state when getApp fails', async () => {
    (appApiService.getApp as jest.Mock).mockRejectedValue(new Error('Network error'));

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  // Back navigation
  it('calls onBack when back button is clicked', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Back to Apps'));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  // Remove agent action
  it('calls removeAppComponent when remove agent is clicked', async () => {
    (appApiService.removeAppComponent as jest.Mock).mockResolvedValue({});

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByText('Remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(appApiService.removeAppComponent).toHaveBeenCalledWith('app-123', 'agent', 'agent-1');
    });
  });

  // Issue 1: Edit binding dialog opens with pre-filled form
  it('opens edit binding dialog when Edit is clicked on an agent card', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/Edit Binding/)).toBeInTheDocument();
    });

    expect(screen.getByText('System Prompt Addition')).toBeInTheDocument();
    expect(screen.getByText('Model Override')).toBeInTheDocument();
  });

  // Issue 1: Edit binding dialog calls updateAgentBinding on save
  it('calls updateAgentBinding when Save is clicked in edit binding dialog', async () => {
    (appApiService.updateAgentBinding as jest.Mock).mockResolvedValue({});

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    const editButtons = screen.getAllByText('Edit');
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/Edit Binding/)).toBeInTheDocument();
    });

    // Multiple Save buttons exist (admin email, config values, edit binding).
    // Scope to the edit binding dialog by matching its dialog content.
    // The Dialog mock at the top of this file uses data-testid="dialog".
    const dialogs = screen.getAllByTestId('dialog');
    const editBindingDialog =
      dialogs.find((d) => d.textContent?.includes('Edit Binding')) ?? dialogs[dialogs.length - 1];
    const saveButton = within(editBindingDialog).getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(appApiService.updateAgentBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-123',
          agentId: 'agent-1',
        }),
      );
    });
  });

  // Issue 2: Workflows tab shows Bind Workflow button
  it('shows Bind Workflow button on Workflows tab', async () => {
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Workflows'));

    await waitFor(() => {
      const bindButtons = screen.getAllByText('Bind Workflow');
      expect(bindButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  // Issue 2: Workflows empty state shows Bind Workflow CTA
  it('shows Bind Workflow CTA in workflows empty state', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue({ ...mockApp, workflowIds: [] });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Workflows'));

    await waitFor(() => {
      expect(screen.getByText('No workflows bound to this app.')).toBeInTheDocument();
    });

    const bindButtons = screen.getAllByText('Bind Workflow');
    expect(bindButtons.length).toBeGreaterThanOrEqual(2); // header + empty state CTA
  });

  // Issue 2: Bind Workflow dialog opens and calls bindWorkflowToApp
  it('opens bind workflow dialog and binds a workflow', async () => {
    (workflowApiService.listWorkflows as jest.Mock).mockResolvedValue({
      items: [
        { workflowId: 'wf-new', name: 'New Workflow', status: 'DRAFT' },
        { workflowId: 'wf-1', name: 'Already Bound', status: 'PUBLISHED' },
      ],
    });
    (appApiService.bindWorkflowToApp as jest.Mock).mockResolvedValue({});

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Test App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Workflows'));

    await waitFor(() => {
      const bindButtons = screen.getAllByText('Bind Workflow');
      fireEvent.click(bindButtons[0]);
    });

    await waitFor(() => {
      expect(screen.getByText('Bind Workflow to App')).toBeInTheDocument();
    });

    // wf-1 is already bound, so only wf-new should appear
    await waitFor(() => {
      expect(screen.getByText('New Workflow')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Bind'));

    await waitFor(() => {
      expect(appApiService.bindWorkflowToApp).toHaveBeenCalledWith('app-123', 'wf-new');
    });
  });
});
