/**
 * RunWorkflowDialog tests.
 *
 * Covers:
 *   - Dialog opens and shows workflow name
 *   - Invalid JSON disables Run with inline error
 *   - Valid JSON passed to onRun as a string
 *   - Empty textarea calls onRun with no input argument
 *   - Remembered input restored from localStorage
 *   - Loading state disables buttons
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// shadcn Dialog wraps Radix Portal — render inline so jest can query widgets.
jest.mock('../ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren<Record<string, unknown>>) =>
    <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    <div>{children}</div>,
  DialogTitle: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
    <h2 {...rest}>{children}</h2>,
  DialogDescription: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
    <p {...rest}>{children}</p>,
}));

jest.mock('../ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../ui/textarea', () => ({
  Textarea: ({ onChange, value, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}));

jest.mock('../ui/label', () => ({
  Label: ({ children, htmlFor, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) =>
    React.createElement('label', { htmlFor, ...rest }, children),
}));

import { RunWorkflowDialog } from '../RunWorkflowDialog';

describe('RunWorkflowDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    workflowId: 'wf-test-1',
    workflowName: 'My Workflow',
    loading: false,
    onRun: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('renders the dialog with workflow name', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    expect(screen.getByText('Run Workflow')).toBeInTheDocument();
    expect(screen.getByText(/My Workflow/)).toBeInTheDocument();
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();
  });

  it('does not render when open is false', () => {
    render(<RunWorkflowDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Run Workflow')).not.toBeInTheDocument();
  });

  it('shows inline error and disables Run when JSON is invalid', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');
    fireEvent.change(textarea, { target: { value: '{invalid' } });

    expect(screen.getByTestId('run-input-error')).toBeInTheDocument();
    expect(screen.getByTestId('run-dialog-confirm')).toBeDisabled();
  });

  it('passes valid JSON string to onRun', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');
    fireEvent.change(textarea, { target: { value: '{"route":"branch-b"}' } });

    expect(screen.queryByTestId('run-input-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();

    fireEvent.click(screen.getByTestId('run-dialog-confirm'));
    expect(defaultProps.onRun).toHaveBeenCalledWith('wf-test-1', '{"route":"branch-b"}');
  });

  it('calls onRun with no input argument when textarea is empty', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    // Run button should be enabled by default (empty = no input)
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();

    fireEvent.click(screen.getByTestId('run-dialog-confirm'));
    expect(defaultProps.onRun).toHaveBeenCalledWith('wf-test-1');
  });

  it('restores remembered input from localStorage', () => {
    localStorage.setItem('citadel:run-input:wf-test-1', '{"remembered":true}');
    render(<RunWorkflowDialog {...defaultProps} />);

    const textarea = screen.getByTestId('run-input-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('{"remembered":true}');
  });

  it('persists input to localStorage on Run', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');
    fireEvent.change(textarea, { target: { value: '{"saved":1}' } });
    fireEvent.click(screen.getByTestId('run-dialog-confirm'));

    expect(localStorage.getItem('citadel:run-input:wf-test-1')).toBe('{"saved":1}');
  });

  it('removes localStorage entry when running with empty input', () => {
    localStorage.setItem('citadel:run-input:wf-test-1', '{"old":true}');
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');
    // Clear the textarea
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('run-dialog-confirm'));

    expect(localStorage.getItem('citadel:run-input:wf-test-1')).toBeNull();
  });

  it('disables Run button when loading', () => {
    render(<RunWorkflowDialog {...defaultProps} loading={true} />);
    expect(screen.getByTestId('run-dialog-confirm')).toBeDisabled();
    expect(screen.getByTestId('run-dialog-confirm')).toHaveTextContent('Starting…');
  });

  it('enables Run for valid JSON arrays and primitives', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');

    // Array
    fireEvent.change(textarea, { target: { value: '[1,2,3]' } });
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();
    expect(screen.queryByTestId('run-input-error')).not.toBeInTheDocument();

    // String
    fireEvent.change(textarea, { target: { value: '"hello"' } });
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();
  });

  it('re-enables Run after fixing invalid JSON', () => {
    render(<RunWorkflowDialog {...defaultProps} />);
    const textarea = screen.getByTestId('run-input-textarea');

    fireEvent.change(textarea, { target: { value: '{bad' } });
    expect(screen.getByTestId('run-dialog-confirm')).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '{"good":true}' } });
    expect(screen.getByTestId('run-dialog-confirm')).toBeEnabled();
    expect(screen.queryByTestId('run-input-error')).not.toBeInTheDocument();
  });
});
