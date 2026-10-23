/**
 * AppDetailView — agent-picker description tests
 *
 * Verifies that the Add Agent dialog shows the correct description for each
 * config shape: JSON string, pre-parsed object, non-JSON string, and the
 * top-level record-field description.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';
import { agentConfigService } from '../../services/agentConfigService';

// ---- UI mocks (minimal, same shape as the main test file) ----

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
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
  Dialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
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
    publishApp: jest.fn(),
    unpublishApp: jest.fn(),
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

import { AppDetailView } from '../AppDetailView';

const baseApp = {
  appId: 'app-1',
  orgId: 'org-1',
  name: 'Test App',
  description: 'desc',
  status: 'DRAFT' as const,
  workflowIds: [],
  agentBindings: [],
  permissions: [],
  configSchema: '{}',
  configValues: '{}',
  createdBy: 'u-1',
  createdByName: 'Test User',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  version: 1,
};

async function openAddAgentDialog() {
  render(<AppDetailView appId="app-1" onBack={jest.fn()} onNavigate={jest.fn()} />);

  // Wait for the app to load
  await waitFor(() => {
    expect(screen.getByText('Test App')).toBeInTheDocument();
  });

  // Switch to the Agents tab
  const agentsTab = screen.getByRole('tab', { name: /agents/i });
  fireEvent.click(agentsTab);

  // Click "Add Agent" (there may be two — one in the header and one in the empty state)
  const addBtns = await waitFor(() => screen.getAllByText(/Add Agent/i));
  fireEvent.click(addBtns[0]);

  // Wait for the dialog
  await waitFor(() => {
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
  });
}

describe('AppDetailView — agent picker descriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (appApiService.getApp as jest.Mock).mockResolvedValue(baseApp);
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue(null);
  });

  it('shows description from config when config is a JSON string', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-json-str',
        name: 'JSONStringAgent',
        config: { name: 'JSONStringAgent', description: 'Description from JSON string config' },
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('Description from JSON string config')).toBeInTheDocument();
    });
  });

  it('shows description from pre-parsed object config', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-obj',
        name: 'ObjectAgent',
        config: { name: 'ObjectAgent', description: 'Description from object config' },
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('Description from object config')).toBeInTheDocument();
    });
  });

  it('shows "No description" when config is a non-JSON string (fallback {})', async () => {
    // After parseAgentConfig, a non-JSON string becomes {}, so config.description is undefined
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-freetext',
        name: 'FreetextAgent',
        config: {},
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('No description')).toBeInTheDocument();
    });
  });

  it('prefers top-level description over config.description', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-top-level',
        name: 'TopLevelAgent',
        description: 'Top-level record description',
        config: { name: 'TopLevelAgent', description: 'Config-level description' },
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('Top-level record description')).toBeInTheDocument();
    });
    expect(screen.queryByText('Config-level description')).not.toBeInTheDocument();
  });

  it('falls back to config.description when top-level description is absent', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-legacy',
        name: 'LegacyAgent',
        config: { name: 'LegacyAgent', description: 'Legacy config description' },
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('Legacy config description')).toBeInTheDocument();
    });
  });

  it('falls back to config.description when top-level description is empty string', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-empty-top',
        name: 'EmptyTopAgent',
        description: '',
        config: { name: 'EmptyTopAgent', description: 'Fallback config description' },
        state: 'active',
        categories: [],
      },
    ]);

    await openAddAgentDialog();

    await waitFor(() => {
      expect(screen.getByText('Fallback config description')).toBeInTheDocument();
    });
  });
});
