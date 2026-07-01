/**
 * AgentCatalog unit tests — Import Agent wizard entry point
 *
 * The Import Agent feature is now ENABLED: the button is active (no longer a
 * disabled "Coming soon" stub) and opens the ImportAgentWizard as a sub-view.
 *
 * Tests:
 *  1. Import Agent button is enabled (header + empty-state locations)
 *  2. Import Agent button carries cursor-pointer (accessibility)
 *  3. Clicking Import Agent opens the ImportAgentWizard sub-view
 *  4. The obsolete "Coming soon" affordance is gone
 *  5. Create Worker button stays enabled (permission/wiring preserved)
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

jest.mock('@/components/ImportAgentWizard', () => ({
  ImportAgentWizard: ({ onBack, onComplete }: any) =>
    React.createElement('div', { 'data-testid': 'import-agent-wizard' }, [
      React.createElement(
        'button',
        { key: 'back', 'data-testid': 'iw-back', onClick: onBack },
        'iw-back',
      ),
      React.createElement(
        'button',
        { key: 'done', 'data-testid': 'iw-done', onClick: onComplete },
        'iw-done',
      ),
    ]),
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

describe('AgentCatalog — Import Agent (enabled → opens wizard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([]);
  });

  it('renders the Import Agent button as enabled', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const importButtons = screen.getAllByRole('button', { name: /Import Agent/i });
    expect(importButtons.length).toBeGreaterThan(0);
    importButtons.forEach((btn) => {
      expect(btn).not.toBeDisabled();
    });
  });

  it('gives the Import Agent button a cursor-pointer affordance', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const importButtons = screen.getAllByRole('button', { name: /Import Agent/i });
    importButtons.forEach((btn) => {
      expect(btn.className).toMatch(/cursor-pointer/);
    });
  });

  it('opens the ImportAgentWizard when the Import Agent button is clicked', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    const importButtons = screen.getAllByRole('button', { name: /Import Agent/i });
    fireEvent.click(importButtons[0]);

    expect(screen.getByTestId('import-agent-wizard')).toBeInTheDocument();
  });

  it('no longer surfaces a "Coming soon" affordance', async () => {
    render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );

    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
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
