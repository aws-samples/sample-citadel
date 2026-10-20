/**
 * AgentTools renders remaining tools when listToolConfigs response contains
 * null elements (#342).
 *
 * When AppSync nulls a ToolConfig array element (e.g. a decision row with
 * config: AWSJSON! absent), the service filters them out and the page
 * renders the remaining valid tools without crashing.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', { ...props, 'data-testid': 'search' }),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => React.createElement('div', { 'data-testid': 'card', ...props }, children),
  CardContent: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardDescription: ({ children, ...props }: any) => React.createElement('p', props, children),
  CardHeader: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardTitle: ({ children, ...props }: any) => React.createElement('h3', props, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) => React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) => React.createElement('div', { 'data-testid': 'tooltip-trigger' }, children),
}));

jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) => React.createElement('div', { className }, children),
}));

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/CreateToolWizard', () => ({
  CreateToolWizard: () => React.createElement('div', { 'data-testid': 'create-tool-wizard' }),
}));

jest.mock('@/components/DataStoreToolWizard', () => ({
  DataStoreToolWizard: () => React.createElement('div', { 'data-testid': 'datastore-wizard' }),
}));

jest.mock('@/components/IntegrationToolWizard', () => ({
  IntegrationToolWizard: () => React.createElement('div', { 'data-testid': 'integration-wizard' }),
}));

jest.mock('@/components/DataPipelineWizard', () => ({
  DataPipelineWizard: () => React.createElement('div', { 'data-testid': 'pipeline-wizard' }),
}));

jest.mock('@/components/FabricationButton', () => ({
  FabricationButton: (props: any) =>
    React.createElement('button', { onClick: props.onClick, 'data-testid': 'fabrication-button' }, 'Fab'),
}));

jest.mock('@/components/FabricationTray', () => ({
  FabricationTray: () => React.createElement('div', { 'data-testid': 'fabrication-tray' }),
}));

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/ToolTestingSandbox', () => ({
  ToolTestingSandbox: () => React.createElement('div', { 'data-testid': 'tool-sandbox' }),
}));

jest.mock('@/components/tool-card-badge-helpers', () => ({
  extractBindingBadges: () => [],
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    currentUser: { role: 'admin' },
    selectedOrganization: 'org-1',
  }),
}));

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: jest.fn(),
    updateToolConfig: jest.fn(),
  },
}));

import { Tools } from '../AgentTools';
import { toolConfigService } from '../../services/toolConfigService';

describe('AgentTools renders after null-element filtering (#342)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders valid tools when service filters null elements', async () => {
    // The service already filters nulls; it returns only valid ToolConfigs.
    // This test verifies the page renders those without crashing.
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'surviving-tool',
        state: 'active',
        config: { name: 'Surviving Tool', description: 'valid', version: 'v1' },
        categories: ['utility'],
      },
      {
        toolId: 'another-survivor',
        state: 'active',
        config: { name: 'Another Survivor', description: 'also valid', version: 'v2' },
        categories: ['dev'],
      },
    ]);

    render(<Tools />);

    await waitFor(() => {
      expect(screen.getByText('Surviving Tool')).toBeInTheDocument();
    });
    expect(screen.getByText('Another Survivor')).toBeInTheDocument();
  });

  it('renders empty state when all elements were null (service returns empty)', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([]);

    render(<Tools />);

    await waitFor(() => {
      expect(screen.getByText('No tools found')).toBeInTheDocument();
    });
  });
});
