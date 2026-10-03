import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// --- Mocks ---

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/ui/table', () => {
  const React = require('react');
  return {
    Table: ({ children }: any) => React.createElement('table', null, children),
    TableHeader: ({ children }: any) => React.createElement('thead', null, children),
    TableBody: ({ children }: any) => React.createElement('tbody', null, children),
    TableRow: ({ children, ...rest }: any) => React.createElement('tr', rest, children),
    TableHead: ({ children }: any) => React.createElement('th', null, children),
    TableCell: ({ children, ...rest }: any) => React.createElement('td', rest, children),
  };
});

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant }: any) =>
    React.createElement('span', { 'data-testid': 'badge', 'data-variant': variant }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('@/components/ui/tooltip', () => {
  const React = require('react');
  return {
    Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
    TooltipTrigger: ({ children, asChild }: any) => (asChild ? children : React.createElement('span', null, children)),
    TooltipContent: ({ children }: any) => React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
  };
});

jest.mock('@/components/ApprovalDecisionDialog', () => ({
  ApprovalDecisionDialog: ({ record, decision, onConfirm, onCancel }: any) =>
    React.createElement('div', { 'data-testid': 'decision-dialog', 'data-decision': decision },
      React.createElement('span', null, record.name),
      React.createElement('button', { 'data-testid': 'dialog-confirm', onClick: () => onConfirm(decision === 'REJECTED' ? 'Bad agent' : undefined) }, 'Confirm'),
      React.createElement('button', { 'data-testid': 'dialog-cancel', onClick: onCancel }, 'Cancel'),
    ),
}));

jest.mock('@/services/approvalsService', () => ({
  approvalsService: {
    listPendingApprovals: jest.fn(),
    decideApproval: jest.fn(),
  },
  supportsToolDecisions: false,
}));

import { toast } from 'sonner';
import { approvalsService } from '../../services/approvalsService';
import { ApprovalsPage } from '../ApprovalsPage';

const mockList = approvalsService.listPendingApprovals as jest.Mock;
const mockDecide = approvalsService.decideApproval as jest.Mock;

function makeRecord(overrides: Partial<any> = {}) {
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

describe('ApprovalsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue({ items: [], nextToken: null });
  });

  afterEach(cleanup);

  it('renders heading', async () => {
    await act(async () => { render(React.createElement(ApprovalsPage)); });
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
  });

  it('shows empty state when no records', async () => {
    await act(async () => { render(React.createElement(ApprovalsPage)); });
    expect(screen.getByText('No records awaiting approval')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    mockList.mockRejectedValue(new Error('Network error'));
    await act(async () => { render(React.createElement(ApprovalsPage)); });
    expect(screen.getByRole('alert')).toHaveTextContent('Network error');
  });

  it('renders rows from mocked service', async () => {
    mockList.mockResolvedValue({
      items: [
        makeRecord({ recordId: 'r1', displayName: 'Agent One' }),
        makeRecord({ recordId: 'r2', displayName: '', name: 'fallback-name' }),
      ],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    expect(screen.getByText('Agent One')).toBeInTheDocument();
    expect(screen.getByText('fallback-name')).toBeInTheDocument();
  });

  it('approve calls decideApproval with APPROVED', async () => {
    const record = makeRecord({ recordId: 'r1' });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockResolvedValue(undefined);

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Click approve button
    fireEvent.click(screen.getByTestId('approve-r1'));

    // Dialog opens - click confirm
    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'r1',
        decision: 'APPROVED',
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('reject opens dialog and passes statusReason', async () => {
    const record = makeRecord({ recordId: 'r1' });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockResolvedValue(undefined);

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('reject-r1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'r1',
        decision: 'REJECTED',
        statusReason: 'Bad agent',
      }),
    );
  });

  it('tool row actions are disabled', async () => {
    mockList.mockResolvedValue({
      items: [makeRecord({ recordId: 't1', recordType: 'tool' })],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    const disabledWrapper = screen.getByTestId('tool-actions-disabled');
    const buttons = disabledWrapper.querySelectorAll('button');
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('shows Load more when nextToken exists', async () => {
    mockList.mockResolvedValueOnce({
      items: [makeRecord()],
      nextToken: 'tok1',
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    expect(screen.getByTestId('load-more')).toBeInTheDocument();
  });

  it('shows toast error when decision fails', async () => {
    const record = makeRecord({ recordId: 'r1' });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockRejectedValue(new Error('Forbidden'));

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('approve-r1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Forbidden');
    });
  });
});
