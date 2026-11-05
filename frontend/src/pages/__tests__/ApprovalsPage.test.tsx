import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

// --- Mock prop types ---
interface MockProps extends Record<string, unknown> { children?: React.ReactNode }

// --- Mocks ---

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/ui/table', () => ({
  Table: ({ children }: MockProps) => React.createElement('table', null, children),
  TableHeader: ({ children }: MockProps) => React.createElement('thead', null, children),
  TableBody: ({ children }: MockProps) => React.createElement('tbody', null, children),
  TableRow: ({ children, ...rest }: MockProps) => React.createElement('tr', rest, children),
  TableHead: ({ children, ...rest }: MockProps) => React.createElement('th', rest, children),
  TableCell: ({ children, ...rest }: MockProps) => React.createElement('td', rest, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, variant }: MockProps & { variant?: string }) =>
    React.createElement('span', { 'data-testid': 'badge', 'data-variant': variant }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: MockProps & { onClick?: () => void; disabled?: boolean }) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, disabled, ...rest }: MockProps & { checked?: boolean | 'indeterminate'; onCheckedChange?: (v: boolean) => void; disabled?: boolean }) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: checked === true,
      onChange: () => onCheckedChange?.(!checked),
      disabled,
      'data-indeterminate': checked === 'indeterminate' ? 'true' : undefined,
      ...rest,
    }),
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: MockProps & { value?: string; onValueChange?: (v: string) => void }) =>
    React.createElement('div', { 'data-testid': 'select-wrapper', 'data-value': value },
      React.createElement('select', {
        'data-testid': 'kind-filter-select',
        value,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(e.target.value),
      },
        React.createElement('option', { value: 'all' }, 'All'),
        React.createElement('option', { value: 'agent' }, 'Agents'),
        React.createElement('option', { value: 'tool' }, 'Tools'),
        React.createElement('option', { value: 'app' }, 'Apps'),
      ),
      children,
    ),
  SelectTrigger: ({ children, ...rest }: MockProps) => React.createElement('div', rest, children),
  SelectContent: ({ children }: MockProps) => React.createElement('div', null, children),
  SelectItem: ({ children, value }: MockProps & { value?: string }) => React.createElement('option', { value }, children),
  SelectValue: () => null,
}));

jest.mock('@/components/ApprovalDecisionDialog', () => ({
  ApprovalDecisionDialog: ({ record, decision, onConfirm, onCancel }: MockProps & { record: { name: string }; decision?: string; onConfirm?: (reason?: string) => void; onCancel?: () => void }) =>
    React.createElement('div', { 'data-testid': 'decision-dialog', 'data-decision': decision },
      React.createElement('span', null, record.name),
      React.createElement('button', { 'data-testid': 'dialog-confirm', onClick: () => onConfirm?.(decision === 'REJECTED' ? 'Bad agent' : undefined) }, 'Confirm'),
      React.createElement('button', { 'data-testid': 'dialog-cancel', onClick: onCancel }, 'Cancel'),
    ),
}));

jest.mock('@/components/BulkApprovalDialog', () => ({
  BulkApprovalDialog: ({ records, decision, results, onConfirm, onRetry, onClose }: MockProps & { records: unknown[]; decision?: string; results: unknown[]; onConfirm?: (reason?: string) => void; onRetry?: () => void; onClose?: () => void }) =>
    React.createElement('div', { 'data-testid': 'bulk-dialog', 'data-decision': decision },
      React.createElement('span', { 'data-testid': 'bulk-record-count' }, records.length),
      React.createElement('button', { 'data-testid': 'bulk-dialog-confirm', onClick: () => onConfirm?.(decision === 'REJECTED' ? 'Not ready' : undefined) }, 'Confirm'),
      React.createElement('button', { 'data-testid': 'bulk-dialog-close', onClick: onClose }, 'Close'),
      results.length > 0 && React.createElement('button', { 'data-testid': 'bulk-dialog-retry', onClick: onRetry }, 'Retry'),
    ),
}));

jest.mock('@/services/approvalsService', () => ({
  approvalsService: {
    listPendingApprovals: jest.fn(),
    decideApproval: jest.fn(),
  },
}));

jest.mock('@/hooks/useBulkApproval', () => ({
  useBulkApproval: () => ({
    execute: jest.fn(),
    results: [],
    progress: { completed: 0, total: 0 },
    isExecuting: false,
    retryFailed: jest.fn(),
    reset: jest.fn(),
  }),
}));

import { toast } from 'sonner';
import { approvalsService, type PendingApprovalItem } from '../../services/approvalsService';
import { ApprovalsPage } from '../ApprovalsPage';

const mockList = approvalsService.listPendingApprovals as jest.Mock;
const mockDecide = approvalsService.decideApproval as jest.Mock;

function makeRecord(overrides: Partial<PendingApprovalItem> = {}) {
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

    fireEvent.click(screen.getByTestId('approve-r1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'r1',
        decision: 'APPROVED',
        version: 2,
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

  it('tool approve calls decideApproval with tool recordType', async () => {
    const record = makeRecord({ recordId: 't1', recordType: 'tool' });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockResolvedValue(undefined);

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('approve-t1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 't1',
        recordType: 'tool',
        decision: 'APPROVED',
      }),
    );
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

  it('omits version from decideApproval when record has no version', async () => {
    const record = makeRecord({ recordId: 'r1', version: undefined });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockResolvedValue(undefined);

    await act(async () => { render(React.createElement(ApprovalsPage)); });
    fireEvent.click(screen.getByTestId('approve-r1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    const call = mockDecide.mock.calls[0][0];
    expect(call).not.toHaveProperty('version');
  });

  it('refetches and shows conflict toast on version conflict error', async () => {
    const record = makeRecord({ recordId: 'r1' });
    mockList.mockResolvedValue({ items: [record], nextToken: null });
    mockDecide.mockRejectedValue(new Error('Conflict: app was modified concurrently. Please retry.'));

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('approve-r1'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('dialog-confirm'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('This record changed; please review again');
    });
    expect(screen.queryByTestId('decision-dialog')).toBeNull();
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  // --- Bulk selection tests ---

  it('select-all checkbox selects all visible items', async () => {
    mockList.mockResolvedValue({
      items: [
        makeRecord({ recordId: 'r1' }),
        makeRecord({ recordId: 'r2' }),
        makeRecord({ recordId: 'r3' }),
      ],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Click select-all
    fireEvent.click(screen.getByTestId('select-all'));

    // All row checkboxes should be checked
    expect((screen.getByTestId('select-r1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('select-r2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('select-r3') as HTMLInputElement).checked).toBe(true);
  });

  it('kind filter narrows visible rows', async () => {
    mockList.mockResolvedValue({
      items: [
        makeRecord({ recordId: 'r1', recordType: 'agent', displayName: 'Agent One' }),
        makeRecord({ recordId: 'r2', recordType: 'tool', displayName: 'Tool One' }),
      ],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Both visible initially
    expect(screen.getByText('Agent One')).toBeInTheDocument();
    expect(screen.getByText('Tool One')).toBeInTheDocument();

    // Filter to tools only
    fireEvent.change(screen.getByTestId('kind-filter-select'), { target: { value: 'tool' } });

    expect(screen.queryByText('Agent One')).toBeNull();
    expect(screen.getByText('Tool One')).toBeInTheDocument();
  });

  it('select-all respects kind filter', async () => {
    mockList.mockResolvedValue({
      items: [
        makeRecord({ recordId: 'r1', recordType: 'agent' }),
        makeRecord({ recordId: 'r2', recordType: 'tool' }),
        makeRecord({ recordId: 'r3', recordType: 'agent' }),
      ],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Filter to agents
    fireEvent.change(screen.getByTestId('kind-filter-select'), { target: { value: 'agent' } });

    // Select all (should only select agents)
    fireEvent.click(screen.getByTestId('select-all'));

    expect((screen.getByTestId('select-r1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('select-r3') as HTMLInputElement).checked).toBe(true);
    // r2 (tool) should not be in the DOM since it's filtered out
    expect(screen.queryByTestId('select-r2')).toBeNull();
  });

  it('bulk approve button appears when items selected', async () => {
    mockList.mockResolvedValue({
      items: [makeRecord({ recordId: 'r1' }), makeRecord({ recordId: 'r2' })],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // No bulk actions initially
    expect(screen.queryByTestId('bulk-approve')).toBeNull();

    // Select one item
    fireEvent.click(screen.getByTestId('select-r1'));

    // Bulk actions should appear
    expect(screen.getByTestId('bulk-approve')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-reject')).toBeInTheDocument();
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 selected');
  });

  it('cap 25: select-all selects at most 25 items', async () => {
    // Create 30 items
    const items = Array.from({ length: 30 }, (_, i) =>
      makeRecord({ recordId: `r${i}`, displayName: `Record ${i}` }),
    );
    mockList.mockResolvedValue({ items, nextToken: null });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Click select-all
    fireEvent.click(screen.getByTestId('select-all'));

    // Should show 25 selected (not 30)
    expect(screen.getByTestId('selection-count')).toHaveTextContent('25 selected');

    // Items beyond 25 should have disabled checkboxes
    const checkbox25 = screen.getByTestId('select-r25') as HTMLInputElement;
    expect(checkbox25.disabled).toBe(true);
  });

  it('clear selection button deselects all', async () => {
    mockList.mockResolvedValue({
      items: [makeRecord({ recordId: 'r1' })],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('select-r1'));
    expect(screen.getByTestId('bulk-approve')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('clear-selection'));
    expect(screen.queryByTestId('bulk-approve')).toBeNull();
  });

  it('bulk approve opens bulk dialog with APPROVED', async () => {
    mockList.mockResolvedValue({
      items: [makeRecord({ recordId: 'r1' }), makeRecord({ recordId: 'r2' })],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('select-r1'));
    fireEvent.click(screen.getByTestId('select-r2'));
    fireEvent.click(screen.getByTestId('bulk-approve'));

    const dialog = screen.getByTestId('bulk-dialog');
    expect(dialog).toHaveAttribute('data-decision', 'APPROVED');
    expect(screen.getByTestId('bulk-record-count')).toHaveTextContent('2');
  });

  it('bulk reject opens bulk dialog with REJECTED', async () => {
    mockList.mockResolvedValue({
      items: [makeRecord({ recordId: 'r1' })],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    fireEvent.click(screen.getByTestId('select-r1'));
    fireEvent.click(screen.getByTestId('bulk-reject'));

    const dialog = screen.getByTestId('bulk-dialog');
    expect(dialog).toHaveAttribute('data-decision', 'REJECTED');
  });

  it('kind filter change clears selection', async () => {
    mockList.mockResolvedValue({
      items: [
        makeRecord({ recordId: 'r1', recordType: 'agent' }),
        makeRecord({ recordId: 'r2', recordType: 'tool' }),
      ],
      nextToken: null,
    });

    await act(async () => { render(React.createElement(ApprovalsPage)); });

    // Select r1
    fireEvent.click(screen.getByTestId('select-r1'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 selected');

    // Change filter — selection should clear
    fireEvent.change(screen.getByTestId('kind-filter-select'), { target: { value: 'tool' } });
    expect(screen.queryByTestId('selection-count')).toBeNull();
  });
});
