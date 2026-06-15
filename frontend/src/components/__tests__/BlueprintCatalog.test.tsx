/**
 * BlueprintCatalog Component Tests
 * Tests for BlueprintCatalog, BlueprintCard, BlueprintPreviewDialog, and ImportBlueprintDialog
 *
 * Requirements: 7.2, 7.3, 7.4, 7.6, 7.7, 7.8, 7.9, 27.4
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock workflowApiService
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    listBlueprints: jest.fn(),
    importBlueprint: jest.fn(),
  },
}));

// Mock appApiService
jest.mock('../../services/appApiService', () => ({
  appApiService: {
    listApps: jest.fn(),
    createApp: jest.fn(),
  },
}));

import { BlueprintCatalog } from '../BlueprintCatalog';
import { workflowApiService } from '../../services/workflowApiService';
import { appApiService } from '../../services/appApiService';

const mockBlueprints = [
  {
    workflowId: 'bp-1',
    name: 'Sequential Agent Pipeline',
    description: 'Three agents in series for step-by-step processing',
    isBlueprint: true,
    status: 'PUBLISHED',
    definition: JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'a1', position: { x: 0, y: 0 }, configuration: {} },
        { id: 'n2', agentId: 'a2', position: { x: 200, y: 0 }, configuration: {} },
        { id: 'n3', agentId: 'a3', position: { x: 400, y: 0 }, configuration: {} },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in' },
        { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'out', targetHandle: 'in' },
      ],
    }),
    metadata: JSON.stringify({ category: 'automation', tags: ['sequential'], isSystem: true }),
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    workflowId: 'bp-2',
    name: 'Parallel Fan-Out',
    description: 'Fan out to multiple agents for parallel data processing',
    isBlueprint: true,
    status: 'PUBLISHED',
    definition: JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'a1', position: { x: 0, y: 0 }, configuration: {} },
        { id: 'n2', agentId: 'a2', position: { x: 200, y: -100 }, configuration: {} },
        { id: 'n3', agentId: 'a3', position: { x: 200, y: 100 }, configuration: {} },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in' },
        { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'out', targetHandle: 'in' },
      ],
    }),
    metadata: JSON.stringify({ category: 'data-processing', tags: ['parallel'], isSystem: false }),
    version: 1,
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
];

const mockApps = [
  { appId: 'app-1', name: 'My App', orgId: 'org-1', status: 'DRAFT', workflowIds: [], version: 1 },
];

describe('BlueprintCatalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loading state', () => {
    it('displays loading skeleton during fetch', () => {
      // Never resolve — keep in loading state
      (workflowApiService.listBlueprints as jest.Mock).mockReturnValue(new Promise(() => {}));

      render(<BlueprintCatalog />);

      expect(screen.getByTestId('blueprint-loading-skeleton')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('displays empty state when no blueprints are returned', async () => {
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: [],
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText(/no blueprints/i)).toBeInTheDocument();
      });
    });
  });

  describe('error state', () => {
    it('displays error state with retry button when fetch fails', async () => {
      (workflowApiService.listBlueprints as jest.Mock).mockRejectedValue(new Error('Network error'));

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('retries fetch when retry button is clicked', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ items: mockBlueprints, nextToken: null });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      });
      expect(workflowApiService.listBlueprints).toHaveBeenCalledTimes(2);
    });
  });

  describe('search filtering', () => {
    it('filters blueprints by name using search input', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: mockBlueprints,
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'Parallel');

      expect(screen.queryByText('Sequential Agent Pipeline')).not.toBeInTheDocument();
      expect(screen.getByText('Parallel Fan-Out')).toBeInTheDocument();
    });

    it('filters blueprints by description using search input', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: mockBlueprints,
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'step-by-step');

      expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      expect(screen.queryByText('Parallel Fan-Out')).not.toBeInTheDocument();
    });
  });

  describe('category filter tabs', () => {
    it('filters blueprints by metadata.category when tab is clicked', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: mockBlueprints,
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
        expect(screen.getByText('Parallel Fan-Out')).toBeInTheDocument();
      });

      // Click the "data-processing" category tab
      const dataProcessingTab = screen.getByRole('button', { name: /data-processing/i });
      await user.click(dataProcessingTab);

      expect(screen.queryByText('Sequential Agent Pipeline')).not.toBeInTheDocument();
      expect(screen.getByText('Parallel Fan-Out')).toBeInTheDocument();
    });
  });

  describe('blueprint card interactions', () => {
    it('opens ImportBlueprintDialog when "Use in App" is clicked', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: mockBlueprints,
        nextToken: null,
      });
      (appApiService.listApps as jest.Mock).mockResolvedValue({
        items: mockApps,
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      });

      const useButtons = screen.getAllByRole('button', { name: /use in app/i });
      await user.click(useButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/import blueprint/i)).toBeInTheDocument();
      });
    });

    it('opens BlueprintPreviewDialog when "Preview" is clicked', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: mockBlueprints,
        nextToken: null,
      });

      render(<BlueprintCatalog />);

      await waitFor(() => {
        expect(screen.getByText('Sequential Agent Pipeline')).toBeInTheDocument();
      });

      const previewButtons = screen.getAllByRole('button', { name: /preview/i });
      await user.click(previewButtons[0]);

      await waitFor(() => {
        expect(screen.getByTestId('blueprint-preview-dialog')).toBeInTheDocument();
      });
    });
  });
});
