/**
 * WorkflowConfigPanel Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 9.5, 9.1, 27.4
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock workflowApiService
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    updateWorkflowConfiguration: jest.fn(),
  },
}));

import { WorkflowConfigPanel } from '../WorkflowConfigPanel';
import { workflowApiService } from '../../services/workflowApiService';

const defaultConfig = {
  integrations: { 'int-1': { endpoint: 'https://api.example.com' } },
  credentials: { 'db-main': 'secret-ref-123' },
  agentProperties: { 'agent-1': { temperature: 0.7 } },
  parameters: { region: 'us-east-1' },
};

const defaultProps = {
  workflowId: 'wf-1',
  configuration: defaultConfig,
  version: 3,
  onSaved: jest.fn(),
};

describe('WorkflowConfigPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('section rendering', () => {
    it('renders Integrations section', () => {
      render(<WorkflowConfigPanel {...defaultProps} />);
      expect(screen.getByText(/integrations/i)).toBeInTheDocument();
    });

    it('renders Credentials section', () => {
      render(<WorkflowConfigPanel {...defaultProps} />);
      expect(screen.getByText(/credentials/i)).toBeInTheDocument();
    });

    it('renders Agent Properties section', () => {
      render(<WorkflowConfigPanel {...defaultProps} />);
      expect(screen.getByText(/agent properties/i)).toBeInTheDocument();
    });

    it('renders Parameters section', () => {
      render(<WorkflowConfigPanel {...defaultProps} />);
      expect(screen.getByText(/parameters/i)).toBeInTheDocument();
    });
  });

  describe('save configuration', () => {
    it('calls updateWorkflowConfiguration on save button click', async () => {
      const user = userEvent.setup();
      const onSaved = jest.fn();
      (workflowApiService.updateWorkflowConfiguration as jest.Mock).mockResolvedValue({
        workflowId: 'wf-1',
        version: 4,
      });

      render(<WorkflowConfigPanel {...defaultProps} onSaved={onSaved} />);

      const saveButton = screen.getByRole('button', { name: /save/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(workflowApiService.updateWorkflowConfiguration).toHaveBeenCalledWith(
          'wf-1',
          expect.any(String),
          3
        );
      });

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled();
      });
    });
  });
});
