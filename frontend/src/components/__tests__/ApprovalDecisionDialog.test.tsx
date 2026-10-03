import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// --- Mock shadcn AlertDialog (Radix portals) inline ---

jest.mock('../ui/alert-dialog', () => {
  const React = require('react');
  return {
    AlertDialog: ({ children, open }: any) =>
      open ? React.createElement('div', { role: 'dialog' }, children) : null,
    AlertDialogContent: ({ children }: any) => React.createElement('div', null, children),
    AlertDialogHeader: ({ children }: any) => React.createElement('div', null, children),
    AlertDialogFooter: ({ children }: any) => React.createElement('div', null, children),
    AlertDialogTitle: ({ children }: any) => React.createElement('h2', null, children),
    AlertDialogDescription: ({ children }: any) => React.createElement('p', null, children),
    AlertDialogAction: ({ children, onClick, disabled, ...rest }: any) =>
      React.createElement('button', { onClick, disabled, ...rest }, children),
    AlertDialogCancel: ({ children, onClick, disabled }: any) =>
      React.createElement('button', { onClick, disabled, 'data-testid': 'cancel-btn' }, children),
  };
});

jest.mock('../ui/textarea', () => ({
  Textarea: ({ onChange, value, ...rest }: any) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}));

jest.mock('../ui/label', () => ({
  Label: ({ children, htmlFor }: any) =>
    React.createElement('label', { htmlFor }, children),
}));

import { ApprovalDecisionDialog } from '../ApprovalDecisionDialog';
import type { PendingApprovalItem } from '../../services/approvalsService';

function makeRecord(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    recordId: 'r1',
    recordType: 'agent',
    name: 'my-agent',
    displayName: 'My Agent',
    orgId: 'org-1',
    submittedAt: '2026-10-01T10:00:00Z',
    createdBy: 'alice',
    status: 'PENDING_APPROVAL',
    ...overrides,
  };
}

describe('ApprovalDecisionDialog', () => {
  afterEach(cleanup);

  it('shows approve title and confirm text', () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'APPROVED' as const,
        onConfirm,
        onCancel: jest.fn(),
      }),
    );

    expect(screen.getByText('Approve My Agent?')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-decision')).toHaveTextContent('Approve');
    // No reason textarea for approve
    expect(screen.queryByTestId('rejection-reason')).not.toBeInTheDocument();
  });

  it('shows reject title and requires reason textarea', () => {
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'REJECTED' as const,
        onConfirm: jest.fn().mockResolvedValue(undefined),
        onCancel: jest.fn(),
      }),
    );

    expect(screen.getByText('Reject My Agent?')).toBeInTheDocument();
    expect(screen.getByTestId('rejection-reason')).toBeInTheDocument();
    // Confirm disabled without reason
    expect(screen.getByTestId('confirm-decision')).toBeDisabled();
  });

  it('approve calls onConfirm without statusReason', async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'APPROVED' as const,
        onConfirm,
        onCancel: jest.fn(),
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-decision'));
    });

    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('reject requires at least 3 chars and passes reason', async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'REJECTED' as const,
        onConfirm,
        onCancel: jest.fn(),
      }),
    );

    const textarea = screen.getByTestId('rejection-reason');
    const confirm = screen.getByTestId('confirm-decision');

    // Short reason — confirm still disabled
    fireEvent.change(textarea, { target: { value: 'ab' } });
    expect(confirm).toBeDisabled();

    // Valid reason — confirm enabled
    fireEvent.change(textarea, { target: { value: 'Not ready for production' } });
    expect(confirm).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(onConfirm).toHaveBeenCalledWith('Not ready for production');
  });

  it('disables confirm while submitting', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = jest.fn().mockReturnValue(
      new Promise<void>((r) => { resolveConfirm = r; }),
    );

    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'APPROVED' as const,
        onConfirm,
        onCancel: jest.fn(),
      }),
    );

    const confirm = screen.getByTestId('confirm-decision');

    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveTextContent('Submitting…');
    });

    await act(async () => { resolveConfirm(); });
  });

  it('falls back to name when displayName is empty', () => {
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord({ displayName: '', name: 'fallback-agent' }),
        decision: 'APPROVED' as const,
        onConfirm: jest.fn().mockResolvedValue(undefined),
        onCancel: jest.fn(),
      }),
    );

    expect(screen.getByText('Approve fallback-agent?')).toBeInTheDocument();
  });

  it('calls onCancel when cancel clicked', () => {
    const onCancel = jest.fn();
    render(
      React.createElement(ApprovalDecisionDialog, {
        record: makeRecord(),
        decision: 'APPROVED' as const,
        onConfirm: jest.fn().mockResolvedValue(undefined),
        onCancel,
      }),
    );

    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onCancel).toHaveBeenCalled();
  });
});
