/**
 * ExecutionDecisionDialog tests (CIT-030).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock the radix alert dialog primitives so we can test without a portal
jest.mock('../ui/alert-dialog', () => {
  const React = require('react');
  return {
    AlertDialog: ({ children, open }: any) =>
      open ? React.createElement('div', { 'data-testid': 'alert-dialog' }, children) : null,
    AlertDialogContent: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'alert-dialog-content' }, children),
    AlertDialogHeader: ({ children }: any) =>
      React.createElement('div', null, children),
    AlertDialogTitle: ({ children }: any) =>
      React.createElement('h2', null, children),
    AlertDialogDescription: ({ children }: any) =>
      React.createElement('p', null, children),
    AlertDialogFooter: ({ children }: any) =>
      React.createElement('div', null, children),
    AlertDialogAction: ({ children, onClick, disabled, ...rest }: any) =>
      React.createElement('button', { onClick, disabled, ...rest }, children),
    AlertDialogCancel: ({ children, onClick, disabled }: any) =>
      React.createElement('button', { onClick, disabled }, children),
  };
});

import { ExecutionDecisionDialog } from '../ExecutionDecisionDialog';

describe('ExecutionDecisionDialog', () => {
  const user = userEvent.setup();

  it('renders the dialog with Pause title', () => {
    render(
      <ExecutionDecisionDialog
        kind="pause"
        executionId="exec-12345678-abcd"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    expect(screen.getByText('Pause execution')).toBeInTheDocument();
    expect(screen.getByText(/exec-123/)).toBeInTheDocument();
  });

  it('renders the dialog with Deny title', () => {
    render(
      <ExecutionDecisionDialog
        kind="deny"
        executionId="exec-abcdefgh-ijkl"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    expect(screen.getByText('Deny execution')).toBeInTheDocument();
  });

  it('disables confirm until reason has ≥3 chars', async () => {
    render(
      <ExecutionDecisionDialog
        kind="deny"
        executionId="exec-abc"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    const confirm = screen.getByTestId('confirm-execution-decision');
    expect(confirm).toBeDisabled();

    const textarea = screen.getByTestId('execution-decision-reason');
    await user.type(textarea, 'ab');
    expect(confirm).toBeDisabled();

    await user.type(textarea, 'c');
    expect(confirm).not.toBeDisabled();
  });

  it('calls onConfirm with trimmed reason', async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);

    render(
      <ExecutionDecisionDialog
        kind="deny"
        executionId="exec-abc"
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />
    );

    const textarea = screen.getByTestId('execution-decision-reason');
    await user.type(textarea, '  security concern  ');

    await user.click(screen.getByTestId('confirm-execution-decision'));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('security concern');
    });
  });

  it('calls onCancel when cancel is clicked', async () => {
    const onCancel = jest.fn();

    render(
      <ExecutionDecisionDialog
        kind="pause"
        executionId="exec-abc"
        onConfirm={jest.fn()}
        onCancel={onCancel}
      />
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows validation message when reason is 1-2 chars', async () => {
    render(
      <ExecutionDecisionDialog
        kind="deny"
        executionId="exec-abc"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );

    const textarea = screen.getByTestId('execution-decision-reason');
    await user.type(textarea, 'ab');

    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument();
  });
});
