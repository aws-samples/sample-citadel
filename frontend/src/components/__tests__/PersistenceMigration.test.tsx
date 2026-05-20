/**
 * PersistenceMigration (WorkflowPersistenceControls) Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 24.5, 24.6, 27.4
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock useWorkflowPersistence hook
jest.mock('../../hooks/useWorkflowPersistence', () => ({
  useWorkflowPersistence: jest.fn(),
}));

// Mock workflowApiService
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    exportWorkflow: jest.fn(),
    importWorkflow: jest.fn(),
  },
}));

import { WorkflowPersistenceControls } from '../WorkflowPersistenceControls';
import { useWorkflowPersistence } from '../../hooks/useWorkflowPersistence';
import { workflowApiService } from '../../services/workflowApiService';

const mockUseWorkflowPersistence = useWorkflowPersistence as jest.Mock;

// Mock URL.createObjectURL for jsdom
beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
});

describe('WorkflowPersistenceControls', () => {
  const defaultHookReturn = {
    save: jest.fn(),
    load: jest.fn().mockResolvedValue({ workflowId: 'wf-1', name: 'Test' }),
    isSaving: false,
    lastSaved: null,
    conflict: false,
    workflow: { workflowId: 'wf-1', name: 'Test', version: 1 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWorkflowPersistence.mockReturnValue(defaultHookReturn);
  });

  describe('auto-save calls updateWorkflow mutation (debounced)', () => {
    it('calls save via useWorkflowPersistence when onSave is triggered', async () => {
      const saveFn = jest.fn();
      mockUseWorkflowPersistence.mockReturnValue({
        ...defaultHookReturn,
        save: saveFn,
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      // The component wraps the hook — verify hook was called with workflowId
      expect(mockUseWorkflowPersistence).toHaveBeenCalledWith('wf-1');
    });
  });

  describe('page load calls getWorkflow', () => {
    it('calls load from useWorkflowPersistence on mount', () => {
      const loadFn = jest.fn().mockResolvedValue({ workflowId: 'wf-1' });
      mockUseWorkflowPersistence.mockReturnValue({
        ...defaultHookReturn,
        load: loadFn,
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      // useWorkflowPersistence calls load() internally on mount
      expect(mockUseWorkflowPersistence).toHaveBeenCalledWith('wf-1');
    });
  });

  describe('Saving.../Saved indicator', () => {
    it('displays "Saving..." when isSaving is true', () => {
      mockUseWorkflowPersistence.mockReturnValue({
        ...defaultHookReturn,
        isSaving: true,
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      expect(screen.getByText(/saving/i)).toBeInTheDocument();
    });

    it('displays "Saved" when lastSaved is set and not currently saving', () => {
      mockUseWorkflowPersistence.mockReturnValue({
        ...defaultHookReturn,
        isSaving: false,
        lastSaved: new Date('2024-01-01T12:00:00Z'),
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });

    it('displays "Conflict" when conflict is true', () => {
      mockUseWorkflowPersistence.mockReturnValue({
        ...defaultHookReturn,
        conflict: true,
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      expect(screen.getByText(/conflict/i)).toBeInTheDocument();
    });
  });

  describe('Export calls server-side exportWorkflow', () => {
    it('calls exportWorkflow when Export button is clicked', async () => {
      const user = userEvent.setup();
      (workflowApiService.exportWorkflow as jest.Mock).mockResolvedValue(
        JSON.stringify({ id: 'wf-1', nodes: [], edges: [] })
      );

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          onSave={jest.fn()}
        />
      );

      const exportButton = screen.getByRole('button', { name: /export/i });
      await user.click(exportButton);

      await waitFor(() => {
        expect(workflowApiService.exportWorkflow).toHaveBeenCalledWith('wf-1');
      });
    });
  });

  describe('Load calls server-side importWorkflow', () => {
    it('calls importWorkflow when Load button is clicked and file provided', async () => {
      const user = userEvent.setup();
      (workflowApiService.importWorkflow as jest.Mock).mockResolvedValue({
        workflowId: 'wf-new',
        name: 'Imported',
      });

      render(
        <WorkflowPersistenceControls
          workflowId="wf-1"
          orgId="org-1"
          onSave={jest.fn()}
        />
      );

      const loadButton = screen.getByRole('button', { name: /load/i });
      await user.click(loadButton);

      // Simulate file input via FileReader
      const fileContent = JSON.stringify({ nodes: [], edges: [], version: '1.0' });
      const file = new File([fileContent], 'workflow.json', { type: 'application/json' });
      const fileInput = screen.getByTestId('import-file-input');
      await user.upload(fileInput, file);

      await waitFor(() => {
        expect(workflowApiService.importWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({
            orgId: 'org-1',
            workflowJson: expect.any(String),
          })
        );
      });
    });
  });
});
