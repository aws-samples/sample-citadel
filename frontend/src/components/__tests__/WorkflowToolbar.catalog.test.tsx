/**
 * WorkflowToolbar catalog behavior tests
 * TDD Red phase — written before the implementation change.
 *
 * Covers: Save → save-to-catalog dialog (createWorkflow isBlueprint + publish),
 * create/publish failure toasts, Load → catalog picker (list/select/empty/retry),
 * replace-confirmation for a non-empty canvas, and the new Import button that
 * carries the old load-from-file behavior, positioned before Export.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  DialogHeader: ({ children }: any) => React.createElement('div', null, children),
  DialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: any) => React.createElement('p', null, children),
  DialogFooter: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/alert', () => ({
  Alert: ({ children }: any) => React.createElement('div', null, children),
  AlertTitle: ({ children }: any) => React.createElement('div', null, children),
  AlertDescription: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, htmlFor }: any) => React.createElement('label', { htmlFor }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() },
}));

// uuid v13 is ESM-only and not in jest's transform whitelist; stub it so the
// workflow serializer (which pulls in uuid) can be parsed under ts-jest.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    createWorkflow: jest.fn(),
    publishWorkflow: jest.fn(),
    listBlueprints: jest.fn(),
  },
}));

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn(),
  },
}));

import { WorkflowToolbar } from '../WorkflowToolbar';
import { workflowApiService } from '../../services/workflowApiService';
import { agentConfigService } from '../../services/agentConfigService';
import { toast } from 'sonner';
import type { WorkflowNode, WorkflowEdge } from '../../types/workflow';

const agentConfig = {
  agentId: 'agent-1',
  name: 'Agent One',
  config: { name: 'Agent One' },
  state: 'active' as const,
};

const makeNode = (id: string): WorkflowNode =>
  ({
    id,
    type: 'agentNode',
    position: { x: 0, y: 0 },
    data: {
      agentId: 'agent-1',
      agentConfig: agentConfig as any,
      label: 'Agent One',
      configuration: {},
      inputCount: 1,
      outputCount: 1,
    },
  }) as WorkflowNode;

// A valid serialized WorkflowDefinition referencing agent-1 twice.
const blueprintDefinition = {
  version: '1.0.0',
  id: 'bp-def-1',
  name: 'Two Step',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  nodes: [
    { id: 'n1', agentId: 'agent-1', position: { x: 0, y: 0 }, configuration: {} },
    { id: 'n2', agentId: 'agent-1', position: { x: 200, y: 0 }, configuration: {} },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'input' },
  ],
};

const mockBlueprints = [
  {
    workflowId: 'bp-1',
    name: 'Two Step',
    description: 'Two agents in series',
    status: 'PUBLISHED',
    isBlueprint: true,
    definition: JSON.stringify(blueprintDefinition),
    metadata: JSON.stringify({ category: 'automation' }),
  },
  {
    workflowId: 'bp-2',
    name: 'Other Flow',
    description: 'Something else entirely',
    status: 'PUBLISHED',
    isBlueprint: true,
    definition: JSON.stringify(blueprintDefinition),
    metadata: null,
  },
];

function renderToolbar(overrides: Partial<React.ComponentProps<typeof WorkflowToolbar>> = {}) {
  const props: React.ComponentProps<typeof WorkflowToolbar> = {
    nodes: [makeNode('n1')],
    edges: [] as WorkflowEdge[],
    onLoad: jest.fn(),
    onClear: jest.fn(),
    orgId: 'org-1',
    workflowName: 'My Flow',
    ...overrides,
  };
  return { ...render(<WorkflowToolbar {...props} />), props };
}

describe('WorkflowToolbar catalog behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-new',
      status: 'DRAFT',
      version: 1,
    });
    (workflowApiService.publishWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-new',
      status: 'PUBLISHED',
    });
    (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
      items: mockBlueprints,
      nextToken: null,
    });
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([agentConfig]);
  });

  describe('Save → catalog', () => {
    it('opens the save dialog on Save and creates then publishes the blueprint on confirm', async () => {
      const user = userEvent.setup();
      renderToolbar();

      await user.click(screen.getByRole('button', { name: /save blueprint to catalog/i }));

      const nameInput = screen.getByLabelText(/blueprint name/i);
      expect(nameInput).toHaveValue('My Flow');

      await user.click(screen.getByRole('button', { name: /^save to catalog$/i }));

      await waitFor(() => expect(workflowApiService.createWorkflow).toHaveBeenCalledTimes(1));
      const input = (workflowApiService.createWorkflow as jest.Mock).mock.calls[0][0];
      expect(input).toEqual(
        expect.objectContaining({ name: 'My Flow', orgId: 'org-1', isBlueprint: true })
      );
      // Category empty → metadata omitted entirely
      expect(input.metadata).toBeUndefined();
      const def = JSON.parse(input.definition);
      expect(def.name).toBe('My Flow');
      expect(def.nodes).toHaveLength(1);
      expect(def.nodes[0]).toEqual(expect.objectContaining({ agentId: 'agent-1' }));

      await waitFor(() =>
        expect(workflowApiService.publishWorkflow).toHaveBeenCalledWith('wf-new')
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          'Blueprint saved to catalog',
          expect.objectContaining({ description: 'My Flow' })
        )
      );
    });

    it('includes the category in metadata JSON when provided', async () => {
      const user = userEvent.setup();
      renderToolbar();

      await user.click(screen.getByRole('button', { name: /save blueprint to catalog/i }));
      await user.type(screen.getByLabelText(/category/i), 'automation');
      await user.click(screen.getByRole('button', { name: /^save to catalog$/i }));

      await waitFor(() => expect(workflowApiService.createWorkflow).toHaveBeenCalledTimes(1));
      const input = (workflowApiService.createWorkflow as jest.Mock).mock.calls[0][0];
      expect(JSON.parse(input.metadata)).toEqual({ category: 'automation' });
    });

    it('shows an error toast and does not publish when createWorkflow fails', async () => {
      const user = userEvent.setup();
      (workflowApiService.createWorkflow as jest.Mock).mockRejectedValue(new Error('boom'));
      renderToolbar();

      await user.click(screen.getByRole('button', { name: /save blueprint to catalog/i }));
      await user.click(screen.getByRole('button', { name: /^save to catalog$/i }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ description: 'boom' })
        )
      );
      expect(workflowApiService.publishWorkflow).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('shows a warning toast when publish fails after a successful create', async () => {
      const user = userEvent.setup();
      (workflowApiService.publishWorkflow as jest.Mock).mockRejectedValue(
        new Error('cannot publish')
      );
      renderToolbar();

      await user.click(screen.getByRole('button', { name: /save blueprint to catalog/i }));
      await user.click(screen.getByRole('button', { name: /^save to catalog$/i }));

      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      expect(workflowApiService.createWorkflow).toHaveBeenCalledTimes(1);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('Load → catalog picker', () => {
    it('opens the picker on Load, lists blueprints, and loads the selected one', async () => {
      const user = userEvent.setup();
      const onLoad = jest.fn();
      renderToolbar({ nodes: [], onLoad });

      await user.click(screen.getByRole('button', { name: /load blueprint from catalog/i }));

      await waitFor(() => expect(workflowApiService.listBlueprints).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Two Step')).toBeInTheDocument();
      expect(screen.getByText('Other Flow')).toBeInTheDocument();
      // Category badge from metadata JSON
      expect(screen.getByText('automation')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /load blueprint two step/i }));

      await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
      const [loadedNodes, loadedEdges] = onLoad.mock.calls[0];
      expect(loadedNodes).toHaveLength(2);
      expect(loadedEdges).toHaveLength(1);
      expect(loadedNodes[0]).toEqual(
        expect.objectContaining({
          id: 'n1',
          data: expect.objectContaining({ agentId: 'agent-1' }),
        })
      );
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });

    it('asks for replace confirmation before opening the picker when the canvas has content', async () => {
      const user = userEvent.setup();
      renderToolbar(); // one node on canvas

      await user.click(screen.getByRole('button', { name: /load blueprint from catalog/i }));

      expect(workflowApiService.listBlueprints).not.toHaveBeenCalled();
      expect(screen.getByText(/replace canvas contents\?/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^replace$/i }));

      await waitFor(() => expect(workflowApiService.listBlueprints).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Two Step')).toBeInTheDocument();
    });

    it('shows the empty state when the catalog has no blueprints', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock).mockResolvedValue({
        items: [],
        nextToken: null,
      });
      renderToolbar({ nodes: [] });

      await user.click(screen.getByRole('button', { name: /load blueprint from catalog/i }));

      expect(
        await screen.findByText(/no blueprints in the catalog yet\./i)
      ).toBeInTheDocument();
    });

    it('shows an error state with Retry when listing fails, and retries', async () => {
      const user = userEvent.setup();
      (workflowApiService.listBlueprints as jest.Mock)
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ items: mockBlueprints, nextToken: null });
      renderToolbar({ nodes: [] });

      await user.click(screen.getByRole('button', { name: /load blueprint from catalog/i }));

      const retry = await screen.findByRole('button', { name: /retry/i });
      await user.click(retry);

      expect(await screen.findByText('Two Step')).toBeInTheDocument();
      expect(workflowApiService.listBlueprints).toHaveBeenCalledTimes(2);
    });
  });

  describe('Import button', () => {
    it('renders Import before Export in DOM order and imports a JSON file', async () => {
      const onLoad = jest.fn();
      renderToolbar({ onLoad });

      const importBtn = screen.getByRole('button', { name: /import workflow from json file/i });
      const exportBtn = screen.getByRole('button', { name: /export workflow as json file/i });
      expect(importBtn).toBeInTheDocument();
      expect(
        importBtn.compareDocumentPosition(exportBtn) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      const fileInput = screen.getByLabelText(/select workflow file to import/i);
      const fakeFile = { text: () => Promise.resolve(JSON.stringify(blueprintDefinition)) };
      fireEvent.change(fileInput, { target: { files: [fakeFile] } });

      await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
      const [loadedNodes, loadedEdges] = onLoad.mock.calls[0];
      expect(loadedNodes).toHaveLength(2);
      expect(loadedEdges).toHaveLength(1);
    });
  });
});
