/**
 * ExecutionOverlay — compact summary text
 * TDD Red Phase
 *
 * Tests that the overlay shows a compact text summary instead of anonymous
 * dot indicators, while keeping Run/History/Cancel controls intact.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../hooks/useExecutionSubscription', () => ({
  useExecutionSubscription: jest.fn(),
}));
jest.mock('../../services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    cancelExecution: jest.fn(),
  },
}));
jest.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement('div', { 'data-testid': 'tooltip-root' }, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) => React.createElement('div', { 'data-testid': 'tooltip-trigger' }, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
  TooltipProvider: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}));

import { ExecutionOverlay, type NodeResultEntry } from '../ExecutionOverlay';

describe('ExecutionOverlay summary text', () => {
  it('shows "Running step 2 of 4" when one node is running with one completed', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'running', output: null, error: null },
      'branch-false': { status: 'pending', output: null, error: null },
      merger: { status: 'pending', output: null, error: null },
    };
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

    expect(screen.getByText('Running step 2 of 4')).toBeInTheDocument();
  });

  it('shows "Completed 3/4, 1 skipped" for mixed completed+skipped', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'completed', output: '{}', error: null },
      'branch-false': { status: 'skipped', output: null, error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
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

    expect(screen.getByText('Completed 3/4, 1 skipped')).toBeInTheDocument();
  });

  it('shows "Completed" when all nodes completed', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
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

    // "Completed" text appears in the summary (not just the status label)
    const summaryEl = screen.getByTestId('execution-summary');
    expect(summaryEl).toHaveTextContent('Completed');
  });

  it('shows "Failed at <label>" when a node failed', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'failed', output: null, error: 'Agent timeout' },
    };
    render(
      <ExecutionOverlay
        nodeResults={nodeResults}
        executionStatus="failed"
        workflowStatus="PUBLISHED"
        onRun={jest.fn()}
        onCancel={jest.fn()}
        executionId="exec-1"
        nodeLabels={{ router: 'Router', 'branch-true': 'Branch True' }}
      />
    );

    expect(screen.getByText(/Failed at Branch True/)).toBeInTheDocument();
  });

  it('does not render the old per-node dot indicators', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
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

    // Old dots rendered via data-testid="node-status-*" — should be gone
    expect(screen.queryByTestId('node-status-router')).not.toBeInTheDocument();
    expect(screen.queryByTestId('node-status-merger')).not.toBeInTheDocument();
  });

  it('still shows Run Workflow and Cancel controls', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'running', output: null, error: null },
    };
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

    expect(screen.getByRole('button', { name: /run workflow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('uses unreachable as skipped in the summary', () => {
    const nodeResults: Record<string, NodeResultEntry> = {
      router: { status: 'completed', output: '{}', error: null },
      'branch-true': { status: 'completed', output: '{}', error: null },
      'branch-false': { status: 'unreachable', output: null, error: null },
      merger: { status: 'completed', output: '{}', error: null },
    };
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

    expect(screen.getByText('Completed 3/4, 1 skipped')).toBeInTheDocument();
  });
});
