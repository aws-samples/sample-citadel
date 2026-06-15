/**
 * AgentCatalog unit tests — stub-button regression suite
 *
 * Validates the BLOCKED safe-default plan: the Import Agent button is
 * rendered but disabled with a "Coming soon" tooltip pending product
 * spec for import format and conflict handling.
 *
 * Tests:
 *  1. Import Agent button is disabled (header location)
 *  2. Clicking the disabled Import Agent button is a no-op (no alert)
 *  3. "Coming soon" tooltip text is present in the DOM
 *  4. Create Worker button stays enabled (permission/wiring preserved)
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
  PageContainer: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/SearchInput', () => ({
  SearchInput: (props: any) =>
    React.createElement('input', { ...props, 'data-testid': 'search' }),
}));

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/AgentDetails', () => ({
  AgentDetails: () => React.createElement('div', { 'data-testid': 'agent-details' }),
}));

jest.mock('@/components/CreateAgentWizard', () => ({
  CreateAgentWizard: () =>
    React.createElement('div', { 'data-testid': 'create-agent-wizard' }),
}));

jest.mock('@/components/AgentCard', () => ({
  AgentCard: ({ agent }: any) =>
    React.createElement(
      'div',
      { 'data-testid': `agent-card-${agent.agentId}` },
      agent.agentId,
    ),
}));

jest.mock('@/components/TaskRunner', () => ({
  TaskRunner: () => React.createElement('div', { 'data-testid': 'task-runner' }),
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

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    currentUser: { role: 'admin' },
    selectedOrganization: 'org-1',
  }),
}));

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn(),
    updateAgentConfig: jest.fn(),
  },
}));

import { AgentCatalog } from '../AgentCatalog';
import { agentConfigService } from '../../services/agentConfigService';

describe('AgentCatalog — Import Agent stub button (BLOCKED → disabled + tooltip)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([]);
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('renders the Import Agent button as disabled', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const importButtons = screen.getAllByRole('button', { name: /Import Agent/i });
    expect(importButtons.length).toBeGreaterThan(0);
    importButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('does not invoke window.alert when the disabled Import Agent button is clicked', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const importButtons = screen.getAllByRole('button', { name: /Import Agent/i });
    importButtons.forEach((btn) => fireEvent.click(btn));

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('renders a "Coming soon" tooltip near the Import Agent button', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const tooltipContents = screen.getAllByTestId('tooltip-content');
    const matched = tooltipContents.some((el) =>
      /coming soon/i.test(el.textContent || ''),
    );
    expect(matched).toBe(true);
  });

  it('keeps the Create Worker button enabled (permission + wiring preserved)', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const createButtons = screen.getAllByRole('button', { name: /Create Worker/i });
    expect(createButtons.length).toBeGreaterThan(0);
    createButtons.forEach((btn) => {
      expect(btn).not.toBeDisabled();
    });
  });
});
