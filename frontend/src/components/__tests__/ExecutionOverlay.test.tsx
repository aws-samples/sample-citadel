/**
 * ExecutionOverlay Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 27.4
 */

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock useExecutionSubscription hook
jest.mock('../../hooks/useExecutionSubscription', () => ({
  useExecutionSubscription: jest.fn(),
}));

// Mock executionApiService
jest.mock('../../services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    cancelExecution: jest.fn(),
  },
}));

import { ExecutionOverlay } from '../ExecutionOverlay';
import { useExecutionSubscription } from '../../hooks/useExecutionSubscription';
import { executionApiService } from '../../services/executionApiService';

const mockUseExecutionSubscription = useExecutionSubscription as jest.Mock;

describe('ExecutionOverlay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockUseExecutionSubscription.mockReturnValue({
      nodeResults: {},
      executionStatus: 'pending',
      events: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('node status rendering', () => {
    it('renders pending node with gray indicator', () => {
      const nodeResults = {
        'node-1': { status: 'pending', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const indicator = screen.getByTestId('node-status-node-1');
      expect(indicator).toHaveClass('bg-muted-foreground');
    });

    it('renders running node with blue spinner indicator', () => {
      const nodeResults = {
        'node-1': { status: 'running', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const indicator = screen.getByTestId('node-status-node-1');
      expect(indicator).toHaveClass('bg-primary');
      expect(indicator.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('renders completed node with green check indicator', () => {
      const nodeResults = {
        'node-1': { status: 'completed', output: '{"ok":true}', error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'completed',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="completed"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const indicator = screen.getByTestId('node-status-node-1');
      expect(indicator).toHaveClass('bg-chart-2');
      expect(indicator).toHaveTextContent('✓');
    });

    it('renders failed node with red X indicator', () => {
      const nodeResults = {
        'node-1': { status: 'failed', output: null, error: 'Agent timeout' },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'failed',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="failed"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const indicator = screen.getByTestId('node-status-node-1');
      expect(indicator).toHaveClass('bg-destructive');
      expect(indicator).toHaveTextContent('✗');
    });

    it('renders skipped node with gray dashed indicator', () => {
      const nodeResults = {
        'node-1': { status: 'skipped', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'completed',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="completed"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const indicator = screen.getByTestId('node-status-node-1');
      expect(indicator).toHaveClass('border-dashed');
      expect(indicator).toHaveClass('border-border');
    });
  });

  describe('real-time updates from subscription', () => {
    it('updates node status when subscription data changes', () => {
      const initialResults = {
        'node-1': { status: 'pending', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: initialResults,
        executionStatus: 'running',
        events: [],
      });

      const { rerender } = render(
        <ExecutionOverlay
          nodeResults={initialResults}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      // Verify initial pending state
      expect(screen.getByTestId('node-status-node-1')).toHaveClass('bg-muted-foreground');

      // Simulate subscription update — node transitions to running
      const updatedResults = {
        'node-1': { status: 'running', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: updatedResults,
        executionStatus: 'running',
        events: [],
      });

      rerender(
        <ExecutionOverlay
          nodeResults={updatedResults}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      expect(screen.getByTestId('node-status-node-1')).toHaveClass('bg-primary');
    });
  });

  describe('error tooltip on failed nodes', () => {
    it('shows error message tooltip on failed node', async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const nodeResults = {
        'node-1': { status: 'failed', output: null, error: 'Agent timeout' },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'failed',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="failed"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const failedNode = screen.getByTestId('node-status-node-1');
      expect(failedNode).toHaveAttribute('title', 'Agent timeout');
    });
  });

  describe('Run Workflow button', () => {
    it('is enabled when workflow status is PUBLISHED and no execution running', () => {
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'pending',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="pending"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId={null}
        />
      );

      const runButton = screen.getByRole('button', { name: /run workflow/i });
      expect(runButton).toBeEnabled();
    });

    it('is disabled when workflow status is DRAFT', () => {
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'pending',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="pending"
          workflowStatus="DRAFT"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId={null}
        />
      );

      const runButton = screen.getByRole('button', { name: /run workflow/i });
      expect(runButton).toBeDisabled();
    });

    it('is disabled when an execution is running', () => {
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const runButton = screen.getByRole('button', { name: /run workflow/i });
      expect(runButton).toBeDisabled();
    });

    it('calls onRun when clicked', async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const onRun = jest.fn();
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'pending',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="pending"
          workflowStatus="PUBLISHED"
          onRun={onRun}
          onCancel={jest.fn()}
          executionId={null}
        />
      );

      await user.click(screen.getByRole('button', { name: /run workflow/i }));
      expect(onRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cancel button', () => {
    it('is visible only during execution', () => {
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('is not visible when no execution is running', () => {
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'pending',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="pending"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId={null}
        />
      );

      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('calls onCancel when clicked', async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const onCancel = jest.fn();
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults: {},
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={{}}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={onCancel}
          executionId="exec-1"
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('fade-out after completion', () => {
    it('fades out 10 seconds after execution completes', () => {
      const nodeResults = {
        'node-1': { status: 'completed', output: '{}', error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'completed',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="completed"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      // Overlay should be visible initially
      const overlay = screen.getByTestId('execution-overlay');
      expect(overlay).not.toHaveClass('opacity-0');

      // Advance 10 seconds
      act(() => {
        jest.advanceTimersByTime(10000);
      });

      // Overlay should have faded out
      expect(overlay).toHaveClass('opacity-0');
    });

    it('does not fade out while execution is running', () => {
      const nodeResults = {
        'node-1': { status: 'running', output: null, error: null },
      };
      mockUseExecutionSubscription.mockReturnValue({
        nodeResults,
        executionStatus: 'running',
        events: [],
      });

      render(
        <ExecutionOverlay
          nodeResults={nodeResults}
          executionStatus="running"
          workflowStatus="PUBLISHED"
          onRun={jest.fn()}
          onCancel={jest.fn()}
          executionId="exec-1"
        />
      );

      const overlay = screen.getByTestId('execution-overlay');

      act(() => {
        jest.advanceTimersByTime(15000);
      });

      expect(overlay).not.toHaveClass('opacity-0');
    });
  });
});
