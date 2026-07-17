/**
 * ExecutionDetailSheet component tests
 * TDD Red phase — written before the component implementation.
 *
 * Covers: header status/duration, pretty-printed result + copy,
 * failed-execution error block, sorted expandable node steps,
 * defensive JSON parsing, and empty states.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

// Passthrough Sheet mock — renders children only when open
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null,
  SheetContent: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  SheetHeader: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  SheetTitle: ({ children, className, title }: any) =>
    React.createElement('h2', { className, title }, children),
  SheetDescription: ({ children, className }: any) =>
    React.createElement('p', { className }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { ExecutionDetailSheet } from '../ExecutionDetailSheet';
import { toast } from 'sonner';

const baseExecution = {
  executionId: 'exec-abc123def456',
  workflowId: 'wf-1',
  status: 'SUCCEEDED',
  workflowVersion: 3,
  triggeredBy: 'user-1',
  startedAt: '2024-03-01T12:00:00Z',
  completedAt: '2024-03-01T12:05:00Z',
  input: '{"question":"hello"}',
  output: '{"answer":42}',
  error: null,
  nodeResults: JSON.stringify({
    // Insertion order is deliberately node-b first — the component must sort by startedAt asc
    'node-b': {
      nodeId: 'node-b',
      agentId: 'agent-2',
      status: 'completed',
      startedAt: '2024-03-01T12:02:00Z',
      completedAt: '2024-03-01T12:05:00Z',
      output: '{"step":"two"}',
      error: null,
      retryCount: 2,
    },
    'node-a': {
      nodeId: 'node-a',
      agentId: 'agent-1',
      status: 'completed',
      startedAt: '2024-03-01T12:00:00Z',
      completedAt: '2024-03-01T12:02:00Z',
      output: '{"step":"one"}',
      error: null,
      retryCount: 0,
    },
  }),
};

const prettyOf = (raw: string) => JSON.stringify(JSON.parse(raw), null, 2);
const preWithText = (expected: string) => (_: string, el: Element | null) =>
  el?.tagName === 'PRE' && el.textContent === expected;

const mockWriteText = jest.fn();

describe('ExecutionDetailSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  it('renders status, duration and the pretty-printed output, and Copy copies it', async () => {
    render(<ExecutionDetailSheet execution={baseExecution} open onClose={jest.fn()} />);

    expect(screen.getByText('SUCCEEDED')).toBeInTheDocument();
    expect(screen.getByText(/Duration 5m/)).toBeInTheDocument();

    const pretty = prettyOf(baseExecution.output);
    expect(screen.getByText(preWithText(pretty))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));

    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(pretty));
    expect(toast.success).toHaveBeenCalledWith('Copied');
  });

  it('shows header metadata: execution id, triggeredBy and workflow version', () => {
    render(<ExecutionDetailSheet execution={baseExecution} open onClose={jest.fn()} />);

    expect(screen.getByTitle('exec-abc123def456')).toBeInTheDocument();
    expect(screen.getByText(/user-1/)).toBeInTheDocument();
    expect(screen.getByText(/v3/)).toBeInTheDocument();
  });

  it('shows the execution error in a destructive block above the result for failed executions', () => {
    const failed = {
      ...baseExecution,
      status: 'FAILED',
      output: null,
      error: 'Agent timeout: exceeded 60s limit',
      nodeResults: null,
    };
    render(<ExecutionDetailSheet execution={failed} open onClose={jest.fn()} />);

    const errorBlock = screen.getByText('Agent timeout: exceeded 60s limit');
    expect(errorBlock).toBeInTheDocument();
    expect(errorBlock.className).toMatch(/destructive/);

    // The error block must precede the output area
    const emptyOutput = screen.getByText('No output recorded.');
    expect(
      errorBlock.compareDocumentPosition(emptyOutput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders node steps sorted by startedAt ascending with agentId and a retry badge', () => {
    render(<ExecutionDetailSheet execution={baseExecution} open onClose={jest.fn()} />);

    const stepA = screen.getByRole('button', { name: /node-a/ });
    const stepB = screen.getByRole('button', { name: /node-b/ });

    // node-a started first so it must appear before node-b despite map insertion order
    expect(
      stepA.compareDocumentPosition(stepB) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(stepA).toHaveAttribute('aria-expanded', 'false');
    expect(stepB).toHaveAttribute('aria-expanded', 'false');
    expect(within(stepA).getByText('agent-1')).toBeInTheDocument();
    expect(within(stepB).getByText('agent-2')).toBeInTheDocument();

    // Retry badge only appears when retryCount > 0
    expect(within(stepB).getByText('2 retries')).toBeInTheDocument();
    expect(within(stepA).queryByText(/retr/)).not.toBeInTheDocument();
  });

  it('expands a step to reveal its pretty-printed output', () => {
    render(<ExecutionDetailSheet execution={baseExecution} open onClose={jest.fn()} />);

    const stepB = screen.getByRole('button', { name: /node-b/ });
    const pretty = prettyOf('{"step":"two"}');
    expect(screen.queryByText(preWithText(pretty))).not.toBeInTheDocument();

    fireEvent.click(stepB);

    expect(stepB).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(preWithText(pretty))).toBeInTheDocument();
  });

  it('expands a failed step to reveal its error in a destructive block', () => {
    const exec = {
      ...baseExecution,
      nodeResults: JSON.stringify({
        'node-x': {
          nodeId: 'node-x',
          agentId: 'agent-9',
          status: 'failed',
          startedAt: '2024-03-01T12:00:00Z',
          completedAt: '2024-03-01T12:01:00Z',
          output: null,
          error: 'Node exploded',
          retryCount: 1,
        },
      }),
    };
    render(<ExecutionDetailSheet execution={exec} open onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /node-x/ }));

    const err = screen.getByText('Node exploded');
    expect(err).toBeInTheDocument();
    expect(err.className).toMatch(/destructive/);
  });

  it('renders raw output when it is not valid JSON without crashing', () => {
    const exec = {
      ...baseExecution,
      output: 'plain text {not-json',
      nodeResults: 'also {not json',
    };
    render(<ExecutionDetailSheet execution={exec} open onClose={jest.fn()} />);

    expect(screen.getByText(preWithText('plain text {not-json'))).toBeInTheDocument();
    // Unparseable nodeResults degrade to the steps empty state
    expect(screen.getByText('No step details recorded.')).toBeInTheDocument();
  });

  it("shows 'No output recorded.' when the execution has no output", () => {
    const exec = { ...baseExecution, output: null };
    render(<ExecutionDetailSheet execution={exec} open onClose={jest.fn()} />);

    expect(screen.getByText('No output recorded.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy result' })).not.toBeInTheDocument();
  });

  it('shows the steps empty state when there are no node results', () => {
    const exec = { ...baseExecution, nodeResults: null };
    render(<ExecutionDetailSheet execution={exec} open onClose={jest.fn()} />);

    expect(screen.getByText('No step details recorded.')).toBeInTheDocument();
  });

  it('collapses the input by default and reveals pretty-printed input on toggle', () => {
    render(<ExecutionDetailSheet execution={baseExecution} open onClose={jest.fn()} />);

    const toggle = screen.getByRole('button', { name: /input/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    const pretty = prettyOf(baseExecution.input);
    expect(screen.queryByText(preWithText(pretty))).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(preWithText(pretty))).toBeInTheDocument();
  });

  it('omits the input section when there is no input', () => {
    render(
      <ExecutionDetailSheet execution={{ ...baseExecution, input: null }} open onClose={jest.fn()} />,
    );

    expect(screen.queryByRole('button', { name: /input/i })).not.toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(<ExecutionDetailSheet execution={baseExecution} open={false} onClose={jest.fn()} />);

    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('renders nothing when no execution is selected', () => {
    render(<ExecutionDetailSheet execution={null} open onClose={jest.fn()} />);

    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });
});
