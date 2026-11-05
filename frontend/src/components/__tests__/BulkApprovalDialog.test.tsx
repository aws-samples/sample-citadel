import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BulkApprovalDialog } from '../BulkApprovalDialog';
import type { BulkApprovalDialogProps } from '../BulkApprovalDialog';
import type { PendingApprovalItem } from '../../services/approvalsService';

/* ------------------------------------------------------------------ */
/*  Minimal UI-component mocks (keep tests focused on dialog logic)   */
/* ------------------------------------------------------------------ */

jest.mock('@/components/ui/dialog', () => {
  const R = require('react');
  return {
    Dialog: ({ children, open, onOpenChange }: any) =>
      open ? R.createElement('div', { 'data-testid': 'dialog-root', onClick: () => onOpenChange?.(false) }, children) : null,
    DialogContent: ({ children, ...rest }: any) => R.createElement('div', rest, children),
    DialogHeader: ({ children }: any) => R.createElement('div', null, children),
    DialogTitle: ({ children, ...rest }: any) => R.createElement('h2', rest, children),
    DialogDescription: ({ children }: any) => R.createElement('p', null, children),
    DialogFooter: ({ children }: any) => R.createElement('div', null, children),
  };
});

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant }: any) =>
    React.createElement('span', { 'data-testid': 'badge', 'data-variant': variant }, children),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => React.createElement('textarea', props),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...rest }: any) => React.createElement('label', rest, children),
}));

jest.mock('@/components/ui/progress', () => ({
  Progress: ({ value, ...rest }: any) =>
    React.createElement('div', { 'role': 'progressbar', 'aria-valuenow': value, ...rest }),
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...rest }: any) => React.createElement('div', rest, children),
  ScrollBar: () => null,
}));

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
    version: 2,
    ...overrides,
  };
}

function renderDialog(overrides: Partial<BulkApprovalDialogProps> = {}) {
  const defaultProps: BulkApprovalDialogProps = {
    records: [
      makeRecord({ recordId: 'r1', displayName: 'Agent Alpha', recordType: 'agent', version: 2 }),
      makeRecord({ recordId: 'r2', displayName: 'Tool Beta', recordType: 'tool', version: undefined }),
      makeRecord({ recordId: 'r3', displayName: 'App Gamma', recordType: 'app', version: 3 }),
    ],
    decision: 'APPROVED',
    results: [],
    progress: { completed: 0, total: 0 },
    isExecuting: false,
    onConfirm: jest.fn(),
    onRetry: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  return { ...render(React.createElement(BulkApprovalDialog, defaultProps)), props: defaultProps };
}

describe('BulkApprovalDialog', () => {
  afterEach(cleanup);

  describe('confirm phase', () => {
    it('renders record list with name, kind badge, and version', () => {
      renderDialog();

      expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
      expect(screen.getByText('Tool Beta')).toBeInTheDocument();
      expect(screen.getByText('App Gamma')).toBeInTheDocument();

      // Kind badges
      const badges = screen.getAllByTestId('badge');
      const badgeTexts = badges.map((b) => b.textContent);
      expect(badgeTexts).toContain('agent');
      expect(badgeTexts).toContain('tool');
      expect(badgeTexts).toContain('app');

      // Version shown for records that have one
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v3')).toBeInTheDocument();
    });

    it('shows approval title for APPROVED decision', () => {
      renderDialog({ decision: 'APPROVED' });
      expect(screen.getByTestId('bulk-dialog-title')).toHaveTextContent('Approve 3 records?');
    });

    it('shows rejection title for REJECTED decision', () => {
      renderDialog({ decision: 'REJECTED' });
      expect(screen.getByTestId('bulk-dialog-title')).toHaveTextContent('Reject 3 records?');
    });

    it('reason textarea shown only for rejection', () => {
      const { unmount } = renderDialog({ decision: 'APPROVED' }).props ? render(React.createElement(BulkApprovalDialog, {
        records: [makeRecord()],
        decision: 'APPROVED',
        results: [],
        progress: { completed: 0, total: 0 },
        isExecuting: false,
        onConfirm: jest.fn(),
        onRetry: jest.fn(),
        onClose: jest.fn(),
      })) : { unmount: () => {} };
      expect(screen.queryByTestId('bulk-rejection-reason')).toBeNull();
      unmount();

      renderDialog({ decision: 'REJECTED' });
      expect(screen.getByTestId('bulk-rejection-reason')).toBeInTheDocument();
    });

    it('reason validation — confirm disabled when < 3 chars for reject', () => {
      renderDialog({ decision: 'REJECTED' });

      const confirmBtn = screen.getByTestId('bulk-confirm');
      expect(confirmBtn).toBeDisabled();

      // Type 2 chars
      fireEvent.change(screen.getByTestId('bulk-rejection-reason'), { target: { value: 'ab' } });
      expect(confirmBtn).toBeDisabled();

      // Type 3 chars
      fireEvent.change(screen.getByTestId('bulk-rejection-reason'), { target: { value: 'abc' } });
      expect(confirmBtn).not.toBeDisabled();
    });

    it('confirm button calls onConfirm with reason for reject', () => {
      const onConfirm = jest.fn();
      renderDialog({ decision: 'REJECTED', onConfirm });

      fireEvent.change(screen.getByTestId('bulk-rejection-reason'), { target: { value: 'Not ready' } });
      fireEvent.click(screen.getByTestId('bulk-confirm'));

      expect(onConfirm).toHaveBeenCalledWith('Not ready');
    });

    it('confirm button calls onConfirm without reason for approve', () => {
      const onConfirm = jest.fn();
      renderDialog({ decision: 'APPROVED', onConfirm });

      fireEvent.click(screen.getByTestId('bulk-confirm'));

      expect(onConfirm).toHaveBeenCalledWith(undefined);
    });

    it('cancel calls onClose', () => {
      const onClose = jest.fn();
      renderDialog({ onClose });

      fireEvent.click(screen.getByTestId('bulk-cancel'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('executing phase', () => {
    it('shows progress bar and processing state', () => {
      renderDialog({
        isExecuting: true,
        results: [
          { recordId: 'r1', name: 'Agent Alpha', status: 'succeeded' },
          { recordId: 'r2', name: 'Tool Beta', status: 'pending' },
          { recordId: 'r3', name: 'App Gamma', status: 'pending' },
        ],
        progress: { completed: 1, total: 3 },
      });

      expect(screen.getByTestId('bulk-progress')).toBeInTheDocument();
      expect(screen.getByTestId('bulk-dialog-title')).toHaveTextContent('Processing 1/3');
    });
  });

  describe('done phase', () => {
    it('shows summary and results with status icons', () => {
      renderDialog({
        results: [
          { recordId: 'r1', name: 'Agent Alpha', status: 'succeeded' },
          { recordId: 'r2', name: 'Tool Beta', status: 'conflict', error: 'Conflict: version moved' },
          { recordId: 'r3', name: 'App Gamma', status: 'failed', error: 'Server error' },
        ],
        progress: { completed: 3, total: 3 },
      });

      expect(screen.getByTestId('bulk-dialog-title')).toHaveTextContent('1 approved, 2 failed');

      const r1 = screen.getByTestId('result-r1');
      expect(r1).toHaveTextContent('✓');
      expect(r1).toHaveTextContent('Agent Alpha');

      const r2 = screen.getByTestId('result-r2');
      expect(r2).toHaveTextContent('⚠');

      const r3 = screen.getByTestId('result-r3');
      expect(r3).toHaveTextContent('✗');
    });

    it('shows retry button when there are failures', () => {
      const onRetry = jest.fn();
      renderDialog({
        results: [
          { recordId: 'r1', name: 'Agent Alpha', status: 'succeeded' },
          { recordId: 'r2', name: 'Tool Beta', status: 'failed', error: 'err' },
        ],
        progress: { completed: 2, total: 2 },
        onRetry,
      });

      const retryBtn = screen.getByTestId('retry-failed');
      expect(retryBtn).toHaveTextContent('Retry failed (1)');
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalled();
    });

    it('does not show retry button when all succeeded', () => {
      renderDialog({
        results: [
          { recordId: 'r1', name: 'Agent Alpha', status: 'succeeded' },
        ],
        progress: { completed: 1, total: 1 },
      });

      expect(screen.queryByTestId('retry-failed')).toBeNull();
    });

    it('close button calls onClose', () => {
      const onClose = jest.fn();
      renderDialog({
        results: [{ recordId: 'r1', name: 'Agent Alpha', status: 'succeeded' }],
        progress: { completed: 1, total: 1 },
        onClose,
      });

      fireEvent.click(screen.getByTestId('bulk-close'));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
