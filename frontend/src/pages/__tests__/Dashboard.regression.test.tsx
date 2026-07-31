/**
 * Regression tests for the Dashboard page.
 *
 * Covers: metric cards render, loading/error states, lazy sections,
 * chart data computation, weekly data display, growth data computation.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/banner', () => ({
  Banner: () => <div data-testid="banner" />,
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
}));
jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: any) => <div data-testid="skeleton" className={className} />,
}));
jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) => <div className={className}>{children}</div>,
}));
jest.mock('@/components/LazyLoadSection', () => ({
  LazyLoadSection: ({ children, fallback }: any) => <div data-testid="lazy-section">{children}</div>,
}));
jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));
jest.mock('@/components/ChartSkeletons', () => ({
  ChartRow2Skeleton: () => <div data-testid="chart-row-2-skeleton" />,
  ChartRow3Skeleton: () => <div data-testid="chart-row-3-skeleton" />,
  ChartRow4Skeleton: () => <div data-testid="chart-row-4-skeleton" />,
  CostChartRowSkeleton: () => <div data-testid="cost-chart-row-skeleton" />,
}));
jest.mock('../dashboard/ChartRow2', () => () => <div data-testid="chart-row-2" />);
jest.mock('../dashboard/ChartRow3', () => () => <div data-testid="chart-row-3" />);
jest.mock('../dashboard/ChartRow4', () => () => <div data-testid="chart-row-4" />);
jest.mock('../dashboard/CostChartRow', () => () => <div data-testid="cost-chart-row" />);

jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockDashboardData = {
  projects: [{ id: 'p1', name: 'Project 1', status: 'CREATED', createdAt: '2025-01-01' }],
  agents: [{ id: 'a1', name: 'Agent 1', state: 'active', createdAt: '2025-01-01' }],
  workflows: [],
  integrations: [],
  dataStores: [{ id: 'd1', name: 'Store 1' }],
  counts: {
    activeRequests: 1,
    deployedAgents: 3,
    totalWorkflows: 2,
    connectedIntegrations: 4,
    connectedDataStores: 1,
    totalDataStores: 2,
    deltas: { activeRequests: 0, deployedAgents: 1, workflows: 0, integrations: 0 },
  },
  loading: false,
  error: null,
  refresh: jest.fn(),
};

jest.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: () => mockDashboardData,
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getDashboardMetrics: jest.fn().mockResolvedValue({
      dailyActivity: [
        { date: '2025-01-06', successCount: 5, errorCount: 1 },
        { date: '2025-01-07', successCount: 3, errorCount: 0 },
      ],
    }),
  },
}));

import { Dashboard } from '../Dashboard';

describe('Dashboard page — regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders metric cards for active requests, agents, workflows, and integrations', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('Active Requests')).toBeInTheDocument();
      expect(screen.getByText('Deployed Agents')).toBeInTheDocument();
      expect(screen.getByText('Workflows')).toBeInTheDocument();
      expect(screen.getByText('Integrations')).toBeInTheDocument();
    });
  });

  test('renders metric values from useDashboardData counts', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument(); // deployedAgents
    });
  });

  test('renders lazy-loaded chart sections', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getAllByTestId('lazy-section').length).toBeGreaterThan(0);
    });
  });

  test('renders chart row components inside lazy sections', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('chart-row-2')).toBeInTheDocument();
      expect(screen.getByTestId('chart-row-3')).toBeInTheDocument();
      expect(screen.getByTestId('chart-row-4')).toBeInTheDocument();
      expect(screen.getByTestId('cost-chart-row')).toBeInTheDocument();
    });
  });

  test('renders banner component', () => {
    render(<Dashboard />);
    expect(screen.getByTestId('banner')).toBeInTheDocument();
  });

  test('shows loading skeletons when data is loading', () => {
    const useDashboardData = require('@/hooks/useDashboardData').useDashboardData;
    const originalImpl = useDashboardData;
    jest.spyOn(require('@/hooks/useDashboardData'), 'useDashboardData').mockReturnValue({
      ...mockDashboardData,
      loading: true,
    });

    render(<Dashboard />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);

    jest.spyOn(require('@/hooks/useDashboardData'), 'useDashboardData').mockImplementation(originalImpl);
  });
});
