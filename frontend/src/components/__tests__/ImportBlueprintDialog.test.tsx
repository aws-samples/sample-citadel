/**
 * ImportBlueprintDialog Component Tests
 *
 * Verifies the template-warning notice rendered in the dialog body.
 * Related task: ee7966a6 (publish-time placeholder-* guard + UI labeling).
 */

import { render, screen } from '@testing-library/react';
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

import { ImportBlueprintDialog } from '../ImportBlueprintDialog';
import type { BlueprintData } from '../BlueprintCard';

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

describe('ImportBlueprintDialog', () => {
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
});
