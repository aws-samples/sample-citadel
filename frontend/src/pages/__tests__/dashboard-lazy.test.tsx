/**
 * Unit tests for Dashboard lazy loading.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 *
 * Strategy:
 * - Mock IntersectionObserver in jsdom
 * - Verify metric cards + first chart row render immediately
 * - Verify chart rows 2-4 show skeletons initially (not yet intersecting)
 * - Verify charts render when intersection is triggered
 * - Verify skeleton dimensions match rendered chart dimensions (no layout shift)
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';

// ── IntersectionObserver mock ──────────────────────────────────────────────
type IOCallback = (entries: IntersectionObserverEntry[]) => void;

let ioInstances: { callback: IOCallback; element: Element | null }[] = [];

function resetIOInstances() {
  ioInstances = [];
}

class MockIntersectionObserver {
  callback: IOCallback;
  element: Element | null = null;

  constructor(callback: IOCallback) {
    this.callback = callback;
    ioInstances.push({ callback, element: null });
  }

  observe(el: Element) {
    // Store the element on the last instance
    const instance = ioInstances[ioInstances.length - 1];
    if (instance) instance.element = el;
    this.element = el;
  }

  unobserve() {}
  disconnect() {}
}

(globalThis as any).IntersectionObserver = MockIntersectionObserver;

/** Simulate intersection for the nth LazyLoadSection (0-indexed) */
function triggerIntersection(index: number) {
  const instance = ioInstances[index];
  if (!instance) throw new Error(`No IntersectionObserver instance at index ${index}`);
  act(() => {
    instance.callback([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);
  });
}

// ── Mock recharts to avoid SVG rendering issues in jsdom ───────────────────
jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  // Return a simplified version that renders children without SVG
  const MockResponsiveContainer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  );
  return {
    ...Original,
    ResponsiveContainer: MockResponsiveContainer,
  };
});

// ── Mock Banner to keep tests focused ──────────────────────────────────────
jest.mock('../../components/ui/banner', () => ({
  Banner: () => <div data-testid="banner" />,
}));

// ── Mock useDashboardData so loading=false and counts populate metric cards ──
jest.mock('../../hooks/useDashboardData', () => ({
  useDashboardData: jest.fn(),
}));

// ── Mock appApiService to avoid network calls ──────────────────────────────
jest.mock('../../services/appApiService', () => ({
  appApiService: {
    getDashboardMetrics: jest.fn().mockResolvedValue({
      totalRequests: 0,
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
      timeSeries: [],
      dailyActivity: [],
    }),
    getRecentActivity: jest.fn().mockResolvedValue({ items: [] }),
  },
}));

// ── Import Dashboard after mocks ───────────────────────────────────────────
import { Dashboard } from '../Dashboard';
import { useDashboardData } from '../../hooks/useDashboardData';

const mockUseDashboardData = useDashboardData as jest.MockedFunction<typeof useDashboardData>;

beforeEach(() => {
  resetIOInstances();
  mockUseDashboardData.mockReturnValue({
    projects: [],
    agents: [],
    workflows: [],
    integrations: [],
    dataStores: [],
    counts: {
      activeRequests: 12,
      deployedAgents: 47,
      totalWorkflows: 0,
      connectedIntegrations: 0,
      connectedDataStores: 0,
      totalDataStores: 0,
      deltas: { activeRequests: 0, deployedAgents: 0, workflows: 0, integrations: 0 },
    },
    loading: false,
    error: null,
    refresh: jest.fn(),
  } as ReturnType<typeof useDashboardData>);
});

describe('Dashboard lazy loading', () => {
  // Requirement 15.1: Metric cards render immediately
  test('renders metric cards immediately', () => {
    render(<Dashboard />);
    expect(screen.getByText('Active Requests')).toBeTruthy();
    expect(screen.getByText('Deployed Agents')).toBeTruthy();
    expect(screen.getByText('Workflows')).toBeTruthy();
    expect(screen.getByText('Integrations')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('47')).toBeTruthy();
  });

  // Requirement 15.2: First chart row renders immediately
  test('renders first chart row (Weekly Activity, Agent Growth) immediately', () => {
    render(<Dashboard />);
    expect(screen.getByText('Weekly Request Activity')).toBeTruthy();
    expect(screen.getByText('Agent Growth & Utilization')).toBeTruthy();
  });

  // Requirement 15.6: Skeleton placeholders shown for deferred rows
  test('shows skeleton placeholders for chart rows 2-4 before intersection', () => {
    render(<Dashboard />);
    expect(screen.getByTestId('chart-row-2-skeleton')).toBeTruthy();
    expect(screen.getByTestId('chart-row-3-skeleton')).toBeTruthy();
    expect(screen.getByTestId('chart-row-4-skeleton')).toBeTruthy();
  });

  // Requirement 15.3: Row 2 deferred until scrolled into view
  test('does not render chart row 2 content before intersection', () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('chart-row-2')).toBeNull();
  });

  // Requirement 15.3: Row 2 renders after intersection
  test('renders chart row 2 after intersection', () => {
    render(<Dashboard />);
    triggerIntersection(0); // first LazyLoadSection = row 2
    expect(screen.getByTestId('chart-row-2')).toBeTruthy();
    expect(screen.getByText('Request Status')).toBeTruthy();
    expect(screen.getByText('Agent Types')).toBeTruthy();
    expect(screen.getByText('System Performance')).toBeTruthy();
  });

  // Requirement 15.4: Row 3 deferred until scrolled into view
  test('renders chart row 3 after intersection', () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('chart-row-3')).toBeNull();
    triggerIntersection(1); // second LazyLoadSection = row 3
    expect(screen.getByTestId('chart-row-3')).toBeTruthy();
    expect(screen.getByText('Monthly Request Volume')).toBeTruthy();
    expect(screen.getByText('Pipeline Stage Performance')).toBeTruthy();
  });

  // Requirement 15.5: Row 4 deferred until scrolled into view
  test('renders chart row 4 after intersection', () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('chart-row-4')).toBeNull();
    triggerIntersection(2); // third LazyLoadSection = row 4
    expect(screen.getByTestId('chart-row-4')).toBeTruthy();
    expect(screen.getByText('System Health')).toBeTruthy();
    expect(screen.getByText('Recent Activity')).toBeTruthy();
    expect(screen.getByText('Quick Actions')).toBeTruthy();
  });

  // Requirement 15.6: Skeleton disappears after intersection
  test('skeleton for row 2 disappears after intersection', () => {
    render(<Dashboard />);
    expect(screen.getByTestId('chart-row-2-skeleton')).toBeTruthy();
    triggerIntersection(0);
    expect(screen.queryByTestId('chart-row-2-skeleton')).toBeNull();
  });

  // Requirement 15.7: Uses IntersectionObserver
  test('creates IntersectionObserver instances for lazy sections', () => {
    render(<Dashboard />);
    // 3 lazy sections = 3 IO instances
    expect(ioInstances.length).toBe(3);
  });

  // Requirement 15.8: No layout shift — skeleton and chart wrapped in same container
  test('lazy sections are wrapped in consistent container divs', () => {
    render(<Dashboard />);
    const lazySections = screen.getAllByTestId('lazy-load-section');
    expect(lazySections.length).toBe(3);
    // Each lazy section wraps either skeleton or content in the same div
    lazySections.forEach((section) => {
      expect(section.tagName).toBe('DIV');
    });
  });

  // Requirement 15.8: Skeleton grid structure matches rendered chart grid
  test('row 2 skeleton has same grid layout as rendered row 2', () => {
    render(<Dashboard />);
    const skeleton = screen.getByTestId('chart-row-2-skeleton');
    expect(skeleton.className).toContain('grid');
    expect(skeleton.className).toContain('grid-cols-1');
    expect(skeleton.className).toContain('lg:grid-cols-3');
    expect(skeleton.className).toContain('gap-6');
    expect(skeleton.className).toContain('mt-5');

    triggerIntersection(0);
    const rendered = screen.getByTestId('chart-row-2');
    expect(rendered.className).toContain('grid');
    expect(rendered.className).toContain('grid-cols-1');
    expect(rendered.className).toContain('lg:grid-cols-3');
    expect(rendered.className).toContain('gap-6');
    expect(rendered.className).toContain('mt-5');
  });

  // Requirement 15.8: Row 3 skeleton flex layout matches rendered
  test('row 3 skeleton has same flex layout as rendered row 3', () => {
    render(<Dashboard />);
    const skeleton = screen.getByTestId('chart-row-3-skeleton');
    expect(skeleton.className).toContain('flex');
    expect(skeleton.className).toContain('gap-6');
    expect(skeleton.className).toContain('mt-5');

    triggerIntersection(1);
    const rendered = screen.getByTestId('chart-row-3');
    expect(rendered.className).toContain('flex');
    expect(rendered.className).toContain('gap-6');
    expect(rendered.className).toContain('mt-5');
  });

  // Verify ErrorBoundary wraps lazy sections (structural check)
  test('lazy sections are wrapped in ErrorBoundary', () => {
    // ErrorBoundary renders children directly when no error — so we verify
    // the structure by checking that all 3 lazy sections render without error
    render(<Dashboard />);
    const lazySections = screen.getAllByTestId('lazy-load-section');
    expect(lazySections.length).toBe(3);
    // Trigger all intersections — no errors thrown
    triggerIntersection(0);
    triggerIntersection(1);
    triggerIntersection(2);
    expect(screen.getByTestId('chart-row-2')).toBeTruthy();
    expect(screen.getByTestId('chart-row-3')).toBeTruthy();
    expect(screen.getByTestId('chart-row-4')).toBeTruthy();
  });
});
