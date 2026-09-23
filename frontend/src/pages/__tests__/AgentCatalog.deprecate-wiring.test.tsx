/**
 * AgentCatalog unit tests — Deactivate -> Deprecate wiring (decision 3d5843e9)
 *
 * AgentCard now calls onToggleState for a registry-backed active agent only
 * after the user confirms the Deprecate dialog. AgentCatalog's
 * handleToggleState must route that call to the deprecate-intent wire value
 * (state: "maintenance", per registry-service.ts's toRegistryStatus) rather
 * than the legacy Deactivate value ("inactive"), which the registry now
 * rejects (decision 3d5843e9 / finding 462c17ad). Legacy (non-registry)
 * agents must keep sending "inactive" unchanged. Registry-backing is
 * determined by the explicit `registryStatus` discriminator (finding
 * 414f8013), not by `name` presence.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

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

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/TaskRunner', () => ({
  TaskRunner: () => React.createElement('div', { 'data-testid': 'task-runner' }),
}));

// Expose a minimal onToggleState trigger per card without pulling in the
// real AgentCard's confirm-dialog UI — AgentCard's own dialog behavior is
// covered by AgentCard.test.tsx. This test only asserts what AgentCatalog
// sends onward once onToggleState fires.
jest.mock('@/components/AgentCard', () => ({
  AgentCard: ({ agent, onToggleState }: any) =>
    React.createElement(
      'button',
      { 'data-testid': `toggle-${agent.agentId}`, onClick: () => onToggleState(agent) },
      `toggle-${agent.agentId}`,
    ),
}));

import { AgentCatalog } from '../AgentCatalog';
import { agentConfigService } from '../../services/agentConfigService';

describe('AgentCatalog — handleToggleState wire value routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});
  });

  it('sends state "maintenance" (deprecate intent) for an active registry-backed agent', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-1',
        name: 'Registry Agent',
        state: 'active',
        categories: [],
        config: {},
        registryStatus: 'APPROVED',
      },
    ]);

    render(<AgentCatalog />);
    await waitFor(() => expect(agentConfigService.listAgentConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-agent-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-agent-1'));

    await waitFor(() =>
      expect(agentConfigService.updateAgentConfig).toHaveBeenCalledWith({
        agentId: 'agent-1',
        state: 'maintenance',
      }),
    );
  });

  it('sends state "inactive" (unchanged) for an active legacy agent', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'legacy-1',
        state: 'active',
        categories: [],
        config: { name: 'Legacy Agent' },
      },
    ]);

    render(<AgentCatalog />);
    await waitFor(() => expect(agentConfigService.listAgentConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-legacy-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-legacy-1'));

    await waitFor(() =>
      expect(agentConfigService.updateAgentConfig).toHaveBeenCalledWith({
        agentId: 'legacy-1',
        state: 'inactive',
      }),
    );
  });

  it('sends state "active" (Activate, unchanged) regardless of registry backing', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-2',
        name: 'Registry Agent',
        state: 'inactive',
        categories: [],
        config: {},
        registryStatus: 'DRAFT',
      },
    ]);

    render(<AgentCatalog />);
    await waitFor(() => expect(agentConfigService.listAgentConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-agent-2')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-agent-2'));

    await waitFor(() =>
      expect(agentConfigService.updateAgentConfig).toHaveBeenCalledWith({
        agentId: 'agent-2',
        state: 'active',
      }),
    );
  });
});
