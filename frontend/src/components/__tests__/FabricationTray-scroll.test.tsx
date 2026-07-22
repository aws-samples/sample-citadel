/**
 * Defect regression: fabrication drawer job list cannot scroll.
 *
 * The tray renders inside a fixed, h-full flex-column SheetContent while
 * Radix locks body scroll. The jobs list container therefore needs to be a
 * bounded scrollable flex child (`flex-1 min-h-0 overflow-y-auto`); without
 * those classes the flex child's default min-height:auto prevents a scroll
 * context and everything below the first screenful is unreachable
 * (live: 37 rows).
 *
 * jsdom performs no layout, so the behavior contract is asserted via the
 * scroll-enabling utility classes on the list container.
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
import { FabricationQueueItem } from '../../services/fabricatorQueueService';

const makeItem = (overrides: Partial<FabricationQueueItem> = {}): FabricationQueueItem => ({
  requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
  agentName: 'Test Agent',
  taskDescription: 'Test task',
  status: 'COMPLETED',
  submittedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('FabricationTray — job list scroll container', () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onRefresh: jest.fn(),
    onNavigate: jest.fn(),
  };

  it('renders the jobs list as a bounded scrollable flex child (flex-1 min-h-0 overflow-y-auto)', () => {
    const items = Array.from({ length: 37 }, (_, i) =>
      makeItem({ requestId: `r${i}`, status: 'COMPLETED' }),
    );

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    // The list container is the parent of the group sections ("Unassigned"
    // heading → group wrapper → list container).
    const groupHeading = screen.getByText('Unassigned');
    const listContainer = groupHeading.closest('div')?.parentElement;

    expect(listContainer).not.toBeNull();
    expect(listContainer).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto');
  });

  it('keeps the scroll container in place for the empty state', () => {
    render(<FabricationTray {...defaultProps} queueItems={[]} />);

    const emptyCopy = screen.getByText('No pending fabrication requests');
    // EmptyState root div → list container is its parent.
    const listContainer = emptyCopy.closest('div')?.parentElement;

    expect(listContainer).not.toBeNull();
    expect(listContainer).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto');
  });
});
