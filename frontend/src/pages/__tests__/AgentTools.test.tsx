/**
 * AgentTools (Tools page) unit tests — stub-button regression suite
 *
 * Validates the BLOCKED safe-default plan: per-tool Settings (Configure)
 * button is rendered but disabled with a "Coming soon" tooltip pending
 * the ToolDetails view spec.
 *
 * Tests:
 *  1. Configure (Settings) button on each ToolCard is disabled
 *  2. Clicking the disabled Configure button is a no-op (no alert)
 *  3. "Coming soon" tooltip text is present in the DOM
 *  4. Permission gate preserved: Configure button absent for non-admin/dev role
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

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

describe('AgentTools — Configure tool stub button (BLOCKED → disabled + tooltip)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    orgCtx.currentUser = { role: 'admin' };
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      makeTool({ toolId: 'tool-a', config: { name: 'Tool A', version: 'v1' } }),
    ]);
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('renders the Configure (Settings) button as disabled on each tool card', async () => {
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    const configureBtns = screen.getAllByRole('button', { name: /configure tool/i });
    expect(configureBtns.length).toBeGreaterThan(0);
    configureBtns.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('does not invoke window.alert when the disabled Configure button is clicked', async () => {
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    const configureBtns = screen.getAllByRole('button', { name: /configure tool/i });
    configureBtns.forEach((btn) => fireEvent.click(btn));

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('renders a "Coming soon" tooltip near the disabled Configure button', async () => {
    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Tool A')).toBeInTheDocument());

    const tooltipContents = screen.queryAllByTestId('tooltip-content');
    const matched = tooltipContents.some((el) =>
      /coming soon/i.test(el.textContent || ''),
    );
    expect(matched).toBe(true);
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
