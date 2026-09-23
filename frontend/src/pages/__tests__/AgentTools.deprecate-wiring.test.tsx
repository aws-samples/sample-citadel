/**
 * AgentTools (Tools page) unit tests — Deactivate -> Deprecate wiring
 * (finding 414f8013 / decision 3d5843e9 twin for tools).
 *
 * ToolCard now calls onToggleState for a registry-backed active tool only
 * after the user confirms the Deprecate dialog. Tools' handleToggleState
 * must route that call to the deprecate-intent wire value (state:
 * "maintenance", per registry-service.ts's toRegistryStatus) rather than the
 * legacy Deactivate value ("inactive"), which the registry now rejects.
 * Legacy (non-registry) tools must keep sending "inactive" unchanged.
 * Registry-backing is determined by the explicit `registryStatus`
 * discriminator (finding 414f8013), not by name/config presence.
 *
 * This is the Tools-page analogue of AgentCatalog.deprecate-wiring.test.tsx,
 * closing the coverage gap flagged in verify iteration 1: AgentTools.test.tsx
 * only exercises the disabled Configure button, not handleToggleState.
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

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: jest.fn(),
    updateToolConfig: jest.fn(),
  },
}));

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/FabricationButton', () => ({
  FabricationButton: () => React.createElement('div', { 'data-testid': 'fabrication-button' }),
}));

jest.mock('@/components/FabricationTray', () => ({
  FabricationTray: () => React.createElement('div', { 'data-testid': 'fabrication-tray' }),
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

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
}));

// Expose a minimal onToggleState trigger per card without pulling in the
// real ToolCard's confirm-dialog UI — ToolCard's own dialog behavior is
// covered by ToolCard.test.tsx. This test only asserts what Tools/AgentTools
// sends onward once onToggleState fires.
jest.mock('@/components/ToolCard', () => ({
  ToolCard: ({ tool, onToggleState }: any) =>
    React.createElement(
      'button',
      { 'data-testid': `toggle-${tool.toolId}`, onClick: () => onToggleState(tool) },
      `toggle-${tool.toolId}`,
    ),
}));

import { Tools } from '../AgentTools';
import { toolConfigService } from '../../services/toolConfigService';

describe('Tools (AgentTools) — handleToggleState wire value routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (toolConfigService.updateToolConfig as jest.Mock).mockResolvedValue({});
  });

  it('sends state "maintenance" (deprecate intent) for an active registry-backed tool', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'tool-1',
        state: 'active',
        categories: [],
        config: { name: 'Registry Tool' },
        registryStatus: 'APPROVED',
      },
    ]);

    render(<Tools />);
    await waitFor(() => expect(toolConfigService.listToolConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-tool-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-tool-1'));

    await waitFor(() =>
      expect(toolConfigService.updateToolConfig).toHaveBeenCalledWith({
        toolId: 'tool-1',
        state: 'maintenance',
      }),
    );
  });

  it('sends state "inactive" (unchanged) for an active legacy tool', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'legacy-tool-1',
        state: 'active',
        categories: [],
        config: { name: 'Legacy Tool' },
      },
    ]);

    render(<Tools />);
    await waitFor(() => expect(toolConfigService.listToolConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-legacy-tool-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-legacy-tool-1'));

    await waitFor(() =>
      expect(toolConfigService.updateToolConfig).toHaveBeenCalledWith({
        toolId: 'legacy-tool-1',
        state: 'inactive',
      }),
    );
  });

  it('sends state "active" (Activate, unchanged) regardless of registry backing', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'tool-2',
        state: 'inactive',
        categories: [],
        config: { name: 'Registry Tool' },
        registryStatus: 'DRAFT',
      },
    ]);

    render(<Tools />);
    await waitFor(() => expect(toolConfigService.listToolConfigs).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('toggle-tool-2')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('toggle-tool-2'));

    await waitFor(() =>
      expect(toolConfigService.updateToolConfig).toHaveBeenCalledWith({
        toolId: 'tool-2',
        state: 'active',
      }),
    );
  });
});
