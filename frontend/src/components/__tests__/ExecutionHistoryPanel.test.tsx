/**
 * ExecutionHistoryPanel Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 22.6, 27.4
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock executionApiService
jest.mock('../../services/executionApiService', () => ({
  executionApiService: {
    listExecutions: jest.fn(),
  },
}));

import { ExecutionHistoryPanel } from '../ExecutionHistoryPanel';
import { executionApiService } from '../../services/executionApiService';

const mockExecutions = [
  {
    executionId: 'exec-3',
    workflowId: 'wf-1',
    status: 'completed',
    workflowVersion: 3,
    startedAt: '2024-03-01T12:00:00Z',
    completedAt: '2024-03-01T12:05:00Z',
    nodeResults: JSON.stringify({
      'node-1': { nodeId: 'node-1', agentId: 'a1', status: 'completed', startedAt: '2024-03-01T12:00:00Z', completedAt: '2024-03-01T12:02:00Z', output: '{"result":"ok"}', error: null, retryCount: 0 },
      'node-2': { nodeId: 'node-2', agentId: 'a2', status: 'completed', startedAt: '2024-03-01T12:02:00Z', completedAt: '2024-03-01T12:05:00Z', output: '{"result":"done"}', error: null, retryCount: 0 },
    }),
  },
  {
    executionId: 'exec-2',
    workflowId: 'wf-1',
    status: 'failed',
    workflowVersion: 2,
    startedAt: '2024-02-15T10:00:00Z',
    completedAt: '2024-02-15T10:03:00Z',
    nodeResults: JSON.stringify({
      'node-1': { nodeId: 'node-1', agentId: 'a1', status: 'completed', startedAt: '2024-02-15T10:00:00Z', completedAt: '2024-02-15T10:01:00Z', output: '{"ok":true}', error: null, retryCount: 0 },
      'node-2': { nodeId: 'node-2', agentId: 'a2', status: 'failed', startedAt: '2024-02-15T10:01:00Z', completedAt: '2024-02-15T10:03:00Z', output: null, error: 'Agent timeout: exceeded 60s limit', retryCount: 2 },
    }),
  },
  {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    status: 'running',
    workflowVersion: 1,
    startedAt: '2024-01-10T08:00:00Z',
    completedAt: null,
    nodeResults: JSON.stringify({
      'node-1': { nodeId: 'node-1', agentId: 'a1', status: 'running', startedAt: '2024-01-10T08:00:00Z', completedAt: null, output: null, error: null, retryCount: 0 },
    }),
  },
];

const defaultProps = {
  workflowId: 'wf-1',
  isOpen: true,
  onClose: jest.fn(),
};

describe('ExecutionHistoryPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('execution list ordering', () => {
    it('lists past executions ordered by startedAt descending', async () => {
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: mockExecutions,
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('exec-3')).toBeInTheDocument();
      });

      const entries = screen.getAllByTestId(/^execution-entry-/);
      expect(entries).toHaveLength(3);
      // First entry should be exec-3 (most recent startedAt)
      expect(within(entries[0]).getByText('exec-3')).toBeInTheDocument();
      expect(within(entries[1]).getByText('exec-2')).toBeInTheDocument();
      expect(within(entries[2]).getByText('exec-1')).toBeInTheDocument();
    });
  });

  describe('status badge colors', () => {
    it('shows green badge for completed status', async () => {
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [mockExecutions[0]],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        const badge = screen.getByTestId('status-badge-exec-3');
        expect(badge).toHaveClass('bg-chart-2');
      });
    });

    it('shows red badge for failed status', async () => {
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [mockExecutions[1]],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        const badge = screen.getByTestId('status-badge-exec-2');
        expect(badge).toHaveClass('bg-destructive');
      });
    });

    it('shows yellow badge for running status', async () => {
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [mockExecutions[2]],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        const badge = screen.getByTestId('status-badge-exec-1');
        expect(badge).toHaveClass('bg-chart-4');
      });
    });

    it('shows gray badge for pending status', async () => {
      const pendingExec = { ...mockExecutions[2], executionId: 'exec-p', status: 'pending' };
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [pendingExec],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        const badge = screen.getByTestId('status-badge-exec-p');
        expect(badge).toHaveClass('bg-muted-foreground');
      });
    });

    it('shows blue badge for cancelled status', async () => {
      const cancelledExec = { ...mockExecutions[0], executionId: 'exec-c', status: 'cancelled' };
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [cancelledExec],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        const badge = screen.getByTestId('status-badge-exec-c');
        expect(badge).toHaveClass('bg-primary');
      });
    });
  });

  describe('expand per-node results', () => {
    it('shows per-node results when execution entry is clicked', async () => {
      const user = userEvent.setup();
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [mockExecutions[0]],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('exec-3')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('execution-entry-exec-3'));

      await waitFor(() => {
        expect(screen.getByText('node-1')).toBeInTheDocument();
        expect(screen.getByText('node-2')).toBeInTheDocument();
      });
    });
  });

  describe('failed node error details', () => {
    it('shows expandable error details for failed nodes', async () => {
      const user = userEvent.setup();
      (executionApiService.listExecutions as jest.Mock).mockResolvedValue({
        items: [mockExecutions[1]],
        nextToken: null,
      });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('exec-2')).toBeInTheDocument();
      });

      // Expand the execution entry
      await user.click(screen.getByTestId('execution-entry-exec-2'));

      await waitFor(() => {
        expect(screen.getByText('node-2')).toBeInTheDocument();
      });

      // Click on the failed node to expand error details
      await user.click(screen.getByTestId('node-result-node-2'));

      await waitFor(() => {
        expect(screen.getByText(/Agent timeout: exceeded 60s limit/)).toBeInTheDocument();
      });
    });
  });

  describe('pagination', () => {
    it('shows Load More button when nextToken is present and loads more on click', async () => {
      const user = userEvent.setup();
      (executionApiService.listExecutions as jest.Mock)
        .mockResolvedValueOnce({
          items: [mockExecutions[0]],
          nextToken: 'token-1',
        })
        .mockResolvedValueOnce({
          items: [mockExecutions[1]],
          nextToken: null,
        });

      render(<ExecutionHistoryPanel {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('exec-3')).toBeInTheDocument();
      });

      const loadMoreButton = screen.getByRole('button', { name: /load more/i });
      expect(loadMoreButton).toBeInTheDocument();

      await user.click(loadMoreButton);

      await waitFor(() => {
        expect(screen.getByText('exec-2')).toBeInTheDocument();
      });

      // Load More should be gone since nextToken is null
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });
});
