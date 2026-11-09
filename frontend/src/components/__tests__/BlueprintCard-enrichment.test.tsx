/**
 * CIT-289: BlueprintCard & BlueprintCatalog enrichment tests.
 * Verifies version, date, short ID, placeholder badge, and sort order.
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock workflowApiService
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    listBlueprints: jest.fn(),
    importBlueprint: jest.fn(),
  },
}));
jest.mock('../../services/appApiService', () => ({
  appApiService: {
    listApps: jest.fn(),
    createApp: jest.fn(),
  },
}));
jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({ currentUser: { organization: 'caller-org' } }),
}));

import { BlueprintCatalog } from '../BlueprintCatalog';
import { BlueprintCard, type BlueprintData } from '../BlueprintCard';
import { workflowApiService } from '../../services/workflowApiService';

const placeholderDef = JSON.stringify({
  nodes: [
    { id: 'n1', agentId: 'placeholder-analyst', position: { x: 0, y: 0 } },
    { id: 'n2', agentId: 'real-agent', position: { x: 200, y: 0 } },
  ],
  edges: [],
});

const cleanDef = JSON.stringify({
  nodes: [
    { id: 'n1', agentId: 'agent-a', position: { x: 0, y: 0 } },
    { id: 'n2', agentId: 'agent-b', position: { x: 200, y: 0 } },
  ],
  edges: [],
});

const bpPlaceholder: BlueprintData = {
  workflowId: 'bp-abcdef123456',
  name: 'Bravo Blueprint',
  description: 'Has placeholders',
  isBlueprint: true,
  status: 'PUBLISHED',
  definition: placeholderDef,
  metadata: JSON.stringify({ category: 'automation' }),
  version: 2,
  createdAt: '2024-06-01T00:00:00Z',
  updatedAt: '2024-06-10T00:00:00Z',
};

const bpClean: BlueprintData = {
  workflowId: 'bp-xyz789012345',
  name: 'Alpha Blueprint',
  description: 'No placeholders',
  isBlueprint: true,
  status: 'PUBLISHED',
  definition: cleanDef,
  metadata: JSON.stringify({ category: 'data-processing' }),
  version: 3,
  createdAt: '2024-05-01T00:00:00Z',
  updatedAt: '2024-05-20T00:00:00Z',
};

describe('BlueprintCard CIT-289 enrichment', () => {
  const onUseInApp = jest.fn();
  const onPreview = jest.fn();

  it('renders version badge', () => {
    render(<BlueprintCard blueprint={bpPlaceholder} onUseInApp={onUseInApp} onPreview={onPreview} />);
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('renders created date as relative text', () => {
    render(<BlueprintCard blueprint={bpPlaceholder} onUseInApp={onUseInApp} onPreview={onPreview} />);
    // Should contain some relative date text (varies by time)
    const card = screen.getByTestId('blueprint-card-bp-abcdef123456');
    // Look for text containing ago or 'just now'
    expect(card.textContent).toMatch(/ago|just now/);
  });

  it('renders short ID with last 6 chars', () => {
    render(<BlueprintCard blueprint={bpPlaceholder} onUseInApp={onUseInApp} onPreview={onPreview} />);
    expect(screen.getByText(/…123456/)).toBeInTheDocument();
  });

  it('copies full workflowId to clipboard on short ID click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { getByTestId } = render(<BlueprintCard blueprint={bpPlaceholder} onUseInApp={onUseInApp} onPreview={onPreview} />);
    const copyBtn = getByTestId('blueprint-copy-id-bp-abcdef123456');
    copyBtn.click();
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('bp-abcdef123456');
    });
  });

  it('shows placeholder badge for blueprints with placeholder agentIds', () => {
    render(<BlueprintCard blueprint={bpPlaceholder} onUseInApp={onUseInApp} onPreview={onPreview} />);
    expect(screen.getByTestId('blueprint-placeholder-badge-bp-abcdef123456')).toBeInTheDocument();
    expect(screen.getByText(/Placeholder nodes/)).toBeInTheDocument();
  });

  it('does NOT show placeholder badge for clean blueprints', () => {
    render(<BlueprintCard blueprint={bpClean} onUseInApp={onUseInApp} onPreview={onPreview} />);
    expect(screen.queryByTestId('blueprint-placeholder-badge-bp-xyz789012345')).not.toBeInTheDocument();
  });
});

describe('BlueprintCatalog CIT-289 sort order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sorts blueprints by name ascending so same-name copies are adjacent', async () => {
    (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
      items: [bpPlaceholder, bpClean], // Bravo first in data
    });

    render(<BlueprintCatalog />);

    await waitFor(() => {
      expect(screen.getByText('Alpha Blueprint')).toBeInTheDocument();
      expect(screen.getByText('Bravo Blueprint')).toBeInTheDocument();
    });

    // Alpha should appear before Bravo
    const alpha = screen.getByText('Alpha Blueprint');
    const bravo = screen.getByText('Bravo Blueprint');
    expect(alpha.compareDocumentPosition(bravo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
