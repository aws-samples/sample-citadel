/**
 * AgentTools (Tools page) unit tests — Configure button removal regression
 *
 * Validates that the Configure (Settings) button is no longer rendered
 * (removed pending ToolDetails view implementation; TODO comment in
 * ToolCard.tsx). The button was previously rendered but disabled with a
 * "Coming soon" tooltip.
 *
 * Tests:
 *  1. Configure (Settings) button is absent from tool cards
 *  2. "Coming soon" tooltip is absent
 *  3. Permission gate preserved: viewer role does not see Configure button
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// Mock UI primitives
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement(
      'button',
      { onClick, disabled, className, ...props },
      children,
    ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) =>
    React.createElement('input', { ...props, 'data-testid': 'search' }),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) =>
    React.createElement('div', { 'data-testid': 'card', ...props }, children),
  CardContent: ({ children, ...props }: any) =>
    React.createElement('div', props, children),
  CardDescription: ({ children, ...props }: any) =>
    React.createElement('p', props, children),
  CardHeader: ({ children, ...props }: any) =>
    React.createElement('div', props, children),
  CardTitle: ({ children, ...props }: any) =>
    React.createElement('h3', props, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'tooltip-trigger' }, children),
}));

jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
}));

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/CreateToolWizard', () => ({
  CreateToolWizard: () =>
    React.createElement('div', { 'data-testid': 'create-tool-wizard' }),
}));

jest.mock('@/components/DataStoreToolWizard', () => ({
  DataStoreToolWizard: () =>
    React.createElement('div', { 'data-testid': 'datastore-wizard' }),
}));

jest.mock('@/components/IntegrationToolWizard', () => ({
  IntegrationToolWizard: () =>
    React.createElement('div', { 'data-testid': 'integration-wizard' }),
}));

jest.mock('@/components/DataPipelineWizard', () => ({
  DataPipelineWizard: () =>
    React.createElement('div', { 'data-testid': 'pipeline-wizard' }),
}));

jest.mock('@/components/FabricationButton', () => ({
  FabricationButton: (props: any) =>
    React.createElement(
      'button',
      { onClick: props.onClick, 'data-testid': 'fabrication-button' },
      'Fab',
    ),
}));

jest.mock('@/components/FabricationTray', () => ({
  FabricationTray: () =>
    React.createElement('div', { 'data-testid': 'fabrication-tray' }),
}));

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/ToolTestingSandbox', () => ({
  ToolTestingSandbox: () =>
    React.createElement('div', { 'data-testid': 'tool-sandbox' }),
}));

jest.mock('@/components/tool-card-badge-helpers', () => ({
  extractBindingBadges: () => [],
}));

const orgCtx: { currentUser: { role: string }; selectedOrganization: string } = {
  currentUser: { role: 'admin' },
  selectedOrganization: 'org-1',
};

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => orgCtx,
}));

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: jest.fn(),
    updateToolConfig: jest.fn(),
  },
}));

import { Tools } from '../AgentTools';
import { toolConfigService } from '../../services/toolConfigService';

const makeTool = (overrides: Record<string, any> = {}) => ({
  toolId: 'tool-1',
  state: 'active',
  config: { name: 'Tool One', description: 'desc', version: 'v1.0.0' },
  categories: ['utility'],
  ...overrides,
});

describe('AgentTools — Configure tool button removed (TODO: implement ToolDetails view)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    orgCtx.currentUser = { role: 'admin' };
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      makeTool({ toolId: 'tool-a', config: { name: 'Tool A', version: 'v1' } }),
    ]);
  });

  it('does not render a Configure (Settings) button on tool cards', async () => {
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    expect(
      screen.queryByRole('button', { name: /configure tool/i }),
    ).not.toBeInTheDocument();
  });

  it('does not render a "Coming soon" tooltip (Configure button removed)', async () => {
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    const tooltipContents = screen.queryAllByTestId('tooltip-content');
    const matched = tooltipContents.some((el) =>
      /coming soon/i.test(el.textContent || ''),
    );
    expect(matched).toBe(false);
  });

  it('preserves the permission gate: viewer role does not see Configure button', async () => {
    orgCtx.currentUser = { role: 'viewer' };
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    expect(
      screen.queryByRole('button', { name: /configure tool/i }),
    ).not.toBeInTheDocument();
  });
});
