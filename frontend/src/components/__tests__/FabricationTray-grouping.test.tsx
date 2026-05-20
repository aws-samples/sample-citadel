/**
 * FabricationTray grouping unit tests
 * Tests: grouping by appId, "Unassigned" section, app name badge navigation, total count
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null,
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
  TooltipTrigger: ({ children, asChild }: any) => React.createElement('div', null, children),
}));

import { FabricationTray } from '../FabricationTray';
import { FabricationQueueItem } from '../../services/fabricatorQueueService';

const makeItem = (overrides: Partial<FabricationQueueItem> = {}): FabricationQueueItem => ({
  requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
  agentName: 'Test Agent',
  taskDescription: 'Test task',
  status: 'PENDING',
  submittedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('FabricationTray — Grouping by appId', () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onRefresh: jest.fn(),
    onNavigate: jest.fn(),
  };

  it('groups items with appId under app name section header', () => {
    const items: FabricationQueueItem[] = [
      makeItem({ requestId: 'r1', agentName: 'Agent A', appId: 'app-1', appName: 'My App' }),
      makeItem({ requestId: 'r2', agentName: 'Agent B', appId: 'app-1', appName: 'My App' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    // Section header should exist
    const headers = screen.getAllByText('My App');
    expect(headers.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Agent A')).toBeInTheDocument();
    expect(screen.getByText('Agent B')).toBeInTheDocument();
  });

  it('groups items without appId under "Unassigned" section', () => {
    const items: FabricationQueueItem[] = [
      makeItem({ requestId: 'r1', agentName: 'Orphan Agent' }),
      makeItem({ requestId: 'r2', agentName: 'Another Orphan' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Orphan Agent')).toBeInTheDocument();
    expect(screen.getByText('Another Orphan')).toBeInTheDocument();
  });

  it('app name badge on QueueItemCard is clickable and navigates to app detail', () => {
    const onNavigate = jest.fn();
    const items: FabricationQueueItem[] = [
      makeItem({ requestId: 'r1', agentName: 'Agent A', appId: 'app-42', appName: 'Cool App' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} onNavigate={onNavigate} />);

    const badge = screen.getByTestId('app-badge-app-42');
    fireEvent.click(badge);

    expect(onNavigate).toHaveBeenCalledWith('app-detail:app-42');
  });

  it('total items across groups equals input count', () => {
    const items: FabricationQueueItem[] = [
      makeItem({ requestId: 'r1', agentName: 'A1', appId: 'app-1', appName: 'App One' }),
      makeItem({ requestId: 'r2', agentName: 'A2', appId: 'app-2', appName: 'App Two' }),
      makeItem({ requestId: 'r3', agentName: 'A3' }),
      makeItem({ requestId: 'r4', agentName: 'A4', appId: 'app-1', appName: 'App One' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    // All 4 agent names should be rendered
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.getByText('A2')).toBeInTheDocument();
    expect(screen.getByText('A3')).toBeInTheDocument();
    expect(screen.getByText('A4')).toBeInTheDocument();

    // Should have section headers for App One, App Two, Unassigned
    const appOneHeaders = screen.getAllByText('App One');
    expect(appOneHeaders.length).toBeGreaterThanOrEqual(1);
    const appTwoHeaders = screen.getAllByText('App Two');
    expect(appTwoHeaders.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('renders multiple distinct app groups', () => {
    const items: FabricationQueueItem[] = [
      makeItem({ requestId: 'r1', appId: 'app-a', appName: 'Alpha App', agentName: 'Agent Alpha' }),
      makeItem({ requestId: 'r2', appId: 'app-b', appName: 'Beta App', agentName: 'Agent Beta' }),
    ];

    render(<FabricationTray {...defaultProps} queueItems={items} />);

    const alphaMatches = screen.getAllByText('Alpha App');
    expect(alphaMatches.length).toBeGreaterThanOrEqual(1);
    const betaMatches = screen.getAllByText('Beta App');
    expect(betaMatches.length).toBeGreaterThanOrEqual(1);
  });
});
