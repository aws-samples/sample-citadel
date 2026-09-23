/**
 * ImportBlueprintDialog Component Tests
 *
 * Verifies the template-warning notice rendered in the dialog body, and
 * (finding 51772063) that the create-app path sends the caller's own
 * organization instead of a placeholder, disabling the action with an
 * actionable message when the caller has no organization.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock services so the dialog can mount without network calls.
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    importBlueprint: jest.fn(),
  },
}));

jest.mock('../../services/appApiService', () => ({
  appApiService: {
    listApps: jest.fn().mockResolvedValue({ items: [], nextToken: null }),
    createApp: jest.fn(),
  },
}));

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

import { ImportBlueprintDialog } from '../ImportBlueprintDialog';
import type { BlueprintData } from '../BlueprintCard';
import { appApiService } from '../../services/appApiService';

const sampleBlueprint: BlueprintData = {
  workflowId: 'bp-template-1',
  name: 'Sequential Agent Pipeline',
  description: '[Template] Three agents in sequence. Clone and re-map agent IDs before publishing.',
  definition: JSON.stringify({
    nodes: [
      { id: 'n1', agentId: 'placeholder-agent-1', position: { x: 0, y: 0 }, configuration: {} },
    ],
    edges: [],
  }),
  metadata: JSON.stringify({ category: 'pipeline', isSystem: true, tags: ['sequential'] }),
  status: 'PUBLISHED',
  version: 1,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  isBlueprint: true,
};

// A blueprint with no agent slots referenced, so the create path is reachable
// without also having to map placeholder agent slots first.
const noSlotBlueprint: BlueprintData = {
  ...sampleBlueprint,
  workflowId: 'bp-no-slots',
  definition: JSON.stringify({ nodes: [], edges: [] }),
};

describe('ImportBlueprintDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseOrganization.mockReturnValue({ currentUser: { organization: 'caller-org' } });
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [], nextToken: null });
  });

  it('renders the template-warning notice when open', () => {
    render(
      <ImportBlueprintDialog
        blueprint={sampleBlueprint}
        open={true}
        onClose={() => {}}
      />,
    );

    expect(
      screen.getByText(/template blueprint.*re-map any placeholder agent IDs to real agents/i),
    ).toBeInTheDocument();
  });

  it('sends the caller organization when creating a new app', async () => {
    (appApiService.createApp as jest.Mock).mockResolvedValue({ appId: 'app-1' });

    render(
      <ImportBlueprintDialog
        blueprint={noSlotBlueprint}
        open={true}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(appApiService.listApps).toHaveBeenCalledWith('caller-org'));

    fireEvent.click(screen.getByRole('button', { name: 'New App' }));
    fireEvent.change(screen.getByLabelText('New app name'), { target: { value: 'My App' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(appApiService.createApp).toHaveBeenCalledWith({
        name: 'My App',
        orgId: 'caller-org',
      }),
    );
  });

  it('disables Import with an actionable message when the caller has no organization', async () => {
    mockUseOrganization.mockReturnValue({ currentUser: { organization: null } });

    render(
      <ImportBlueprintDialog
        blueprint={noSlotBlueprint}
        open={true}
        onClose={() => {}}
      />,
    );

    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    expect(
      screen.getByText('Your account has no organisation; ask an admin to assign one'),
    ).toBeInTheDocument();
    expect(appApiService.listApps).not.toHaveBeenCalled();
  });
});
