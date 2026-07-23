/**
 * Fabrication queue state-breakdown tests.
 *
 * The queue endpoint returns ALL-TIME rows (live: 37 rows, all COMPLETED).
 * A single cumulative badge count made a finished history read as a stalled
 * backlog. The UI must distinguish states: the ACTIVE (pending/processing)
 * count is shown prominently and completed is shown separately
 * ('0 in progress · 37 completed').
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null),
  SheetContent: ({ children }: any) => React.createElement('div', null, children),
  SheetHeader: ({ children }: any) => React.createElement('div', null, children),
  SheetTitle: ({ children }: any) => React.createElement('h2', null, children),
  SheetDescription: ({ children }: any) => React.createElement('p', null, children),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => React.createElement('div', { 'data-testid': 'card', ...props }, children),
}));

jest.mock('@/components/ui/alert', () => ({
  Alert: ({ children, ...props }: any) => React.createElement('div', props, children),
  AlertDescription: ({ children }: any) => React.createElement('p', null, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) => React.createElement('div', null, children),
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children, asChild: _asChild }: any) => React.createElement('div', null, children),
}));

import { FabricationTray } from '../FabricationTray';
import { FabricationButton } from '../FabricationButton';
import { summarizeFabricationQueue } from '../fabricationGrouping';
import { FabricationQueueItem } from '../../services/fabricatorQueueService';

const makeItem = (overrides: Partial<FabricationQueueItem> = {}): FabricationQueueItem => ({
  requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
  agentName: 'Test Agent',
  taskDescription: 'Test task',
  status: 'COMPLETED',
  submittedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('summarizeFabricationQueue', () => {
  it('counts pending and processing as active, completed and failed separately', () => {
    const items = [
      makeItem({ status: 'PENDING' }),
      makeItem({ status: 'PROCESSING' }),
      makeItem({ status: 'PROCESSING' }),
      makeItem({ status: 'COMPLETED' }),
      makeItem({ status: 'COMPLETED' }),
      makeItem({ status: 'FAILED' }),
    ];

    expect(summarizeFabricationQueue(items)).toEqual({
      active: 3,
      completed: 2,
      failed: 1,
    });
  });

  it('returns zeros for an empty queue', () => {
    expect(summarizeFabricationQueue([])).toEqual({ active: 0, completed: 0, failed: 0 });
  });
});

describe('summarizeFabricationQueue — terminal statuses are never in-progress (badge-stuck-at-37 incident)', () => {
  it('reports zero active for the live incident shape: 37 all-COMPLETED rows', () => {
    const items = Array.from({ length: 37 }, (_, i) =>
      makeItem({ requestId: `job-${i}`, status: 'COMPLETED' }),
    );

    expect(summarizeFabricationQueue(items)).toEqual({ active: 0, completed: 37, failed: 0 });
  });

  it('does not count COMPLETED as active', () => {
    expect(summarizeFabricationQueue([makeItem({ status: 'COMPLETED' })]).active).toBe(0);
  });

  it('does not count FAILED as active', () => {
    expect(summarizeFabricationQueue([makeItem({ status: 'FAILED' })]).active).toBe(0);
  });

  it('counts only PENDING and PROCESSING as active', () => {
    const items = [
      makeItem({ status: 'PENDING' }),
      makeItem({ status: 'PROCESSING' }),
      makeItem({ status: 'COMPLETED' }),
      makeItem({ status: 'FAILED' }),
    ];

    expect(summarizeFabricationQueue(items).active).toBe(2);
  });
});

describe('FabricationButton — active count shown prominently', () => {
  it('shows the ACTIVE count in the badge, not the cumulative total', () => {
    render(<FabricationButton activeCount={0} completedCount={37} onClick={jest.fn()} />);

    // The all-time total must NOT be the headline number.
    const badge = screen.getByTestId('fabrication-active-badge');
    expect(badge).toHaveTextContent('0');
    expect(badge).not.toHaveTextContent('37');
  });

  it('exposes the full breakdown for assistive tech', () => {
    render(<FabricationButton activeCount={2} completedCount={37} onClick={jest.fn()} />);

    expect(
      screen.getByRole('button', { name: /2 in progress.*37 completed/i }),
    ).toBeInTheDocument();
  });
});

describe('FabricationTray — state breakdown in the header', () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onRefresh: jest.fn(),
    onNavigate: jest.fn(),
  };

  it("renders '0 in progress · 37 completed' for an all-completed history", () => {
    const items = Array.from({ length: 37 }, (_, i) =>
      makeItem({ requestId: `r${i}`, status: 'COMPLETED' }),
    );

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    expect(screen.getByText(/0 in progress · 37 completed/)).toBeInTheDocument();
  });

  it('renders the active count and appends failed only when present', () => {
    const items = [
      makeItem({ status: 'PENDING' }),
      makeItem({ status: 'PROCESSING' }),
      makeItem({ status: 'COMPLETED' }),
      makeItem({ status: 'FAILED' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    expect(screen.getByText(/2 in progress · 1 completed · 1 failed/)).toBeInTheDocument();
  });

  it('omits the failed segment when nothing failed', () => {
    const items = [makeItem({ status: 'PENDING' }), makeItem({ status: 'COMPLETED' })];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    expect(screen.getByText(/1 in progress · 1 completed/)).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});
