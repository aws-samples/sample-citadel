/**
 * AppApiDashboard per-app cost panel tests
 *
 * Covers: the cost panel is hidden entirely when the cost API is
 * unconfigured (no costService fetch calls), and rendered with the
 * app-scoped series data when configured.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: any) => React.createElement('div', null, children),
  DialogHeader: ({ children }: any) => React.createElement('div', null, children),
  DialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: any) => React.createElement('p', null, children),
  DialogFooter: ({ children }: any) => React.createElement('div', null, children),
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));
jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'skeleton', className }),
}));
jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'responsive-container' }, children),
  LineChart: ({ children }: any) => React.createElement('div', null, children),
  AreaChart: ({ children }: any) => React.createElement('div', null, children),
  Area: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getApp: jest.fn().mockResolvedValue({ name: 'Test App', status: 'PUBLISHED', appId: 'app-123' }),
    listAppApiKeys: jest.fn().mockResolvedValue([]),
    getAppMetrics: jest.fn().mockResolvedValue({
      totalRequests: 0, successCount: 0, clientErrorCount: 0, serverErrorCount: 0,
      p50Latency: 0, p95Latency: 0, p99Latency: 0, timeSeries: [],
    }),
  },
}));

jest.mock('../../services/costService', () => ({
  costService: {
    isAvailable: jest.fn(),
    getSeries: jest.fn(),
    getSummary: jest.fn(),
    listBudgets: jest.fn(),
    putBudget: jest.fn(),
  },
}));

import { costService } from '../../services/costService';
import { AppApiDashboard } from '../../pages/AppApiDashboard';

describe('AppApiDashboard: per-app cost panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not render the cost panel or call costService when the cost API is unconfigured', async () => {
    (costService.isAvailable as jest.Mock).mockReturnValue(false);

    render(<AppApiDashboard appId="app-123" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Test App')).toBeInTheDocument());
    expect(screen.queryByText('App Cost Over Time')).not.toBeInTheDocument();
    expect(costService.getSeries).not.toHaveBeenCalled();
  });

  it('renders the per-app cost panel scoped to dimension=app when the cost API is configured', async () => {
    (costService.isAvailable as jest.Mock).mockReturnValue(true);
    (costService.getSeries as jest.Mock).mockResolvedValue({
      available: true,
      data: {
        dimension: 'app', id: 'app-123', bucket: 'day', from: '', to: '', currency: 'USD',
        estimate: true, truncated: false, unpricedCount: 0,
        points: [{ t: '2026-07-20', costMicros: 2_000_000, totalTokens: 20, rows: 1, unpricedRows: 0 }],
      },
    });

    render(<AppApiDashboard appId="app-123" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('App Cost Over Time')).toBeInTheDocument());
    expect(costService.getSeries).toHaveBeenCalledWith('app', 'app-123', 'day', expect.any(String), expect.any(String));
  });
});
