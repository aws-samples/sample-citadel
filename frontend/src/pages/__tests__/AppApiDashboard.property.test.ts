/**
 * Property-Based Tests — AppApiDashboard
 *
 * Property 2: Reveal toggle round-trip
 * Property 4: Non-PUBLISHED status guard
 * Property 5: Metrics summary card completeness
 *
 * Uses fast-check for property-based testing.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import * as fc from 'fast-check';
import { appApiService } from '../../services/appApiService';
import { maskApiKey } from '../../utils/publishUtils';

// ---- Mock UI components ----

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
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
  LineChart: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'line-chart' }, children),
  Line: () => React.createElement('div', { 'data-testid': 'line' }),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getApp: jest.fn(),
    listAppApiKeys: jest.fn(),
    getAppMetrics: jest.fn(),
    createAppApiKey: jest.fn(),
    revokeAppApiKey: jest.fn(),
    rotateAppApiKey: jest.fn(),
  },
}));

// Do NOT mock publishUtils — use real implementation

import { AppApiDashboard } from '../../pages/AppApiDashboard';

// ---- Helpers ----

const defaultProps = {
  appId: 'app-test',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

// ---- Property 2: Reveal toggle round-trip ----

/**
 * Feature: app-publishing-frontend-gaps, Property 2: Reveal toggle round-trip
 *
 * For any API key row in the dashboard, toggling the reveal control twice
 * (reveal → hide) should return the displayed key text to the original
 * masked format, identical to the initial state.
 *
 * **Validates: Requirements 5.4, 5.5**
 */
describe('Property 2: Reveal toggle round-trip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('toggling reveal twice returns key display to original masked format', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          keyId: fc.uuid(),
          name: fc.constant('TestKey'),
          prefix: fc.stringMatching(/^[a-z0-9]{8}$/),
          status: fc.constant('ACTIVE' as const),
          createdAt: fc.constant('2024-01-01T00:00:00Z'),
          expiresAt: fc.constant(null),
          lastUsedAt: fc.constant(null),
        }),
        async (key) => {
          // Setup mocks for a PUBLISHED app with the generated key
          (appApiService.getApp as jest.Mock).mockResolvedValue({
            name: 'Test App',
            status: 'PUBLISHED',
            appId: 'app-test',
          });
          (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([key]);
          (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(null);

          const { unmount } = render(React.createElement(AppApiDashboard, defaultProps));

          // Wait for the masked key to appear (data loaded)
          const expectedMasked = maskApiKey(key.prefix);
          await waitFor(() => {
            expect(screen.getByText(expectedMasked)).toBeInTheDocument();
          });

          // Click reveal toggle — should show keyId
          const revealButton = screen.getByLabelText('Reveal key');
          fireEvent.click(revealButton);
          expect(screen.getByText(key.keyId)).toBeInTheDocument();

          // Click toggle again — should return to masked format
          const hideButton = screen.getByLabelText('Hide key');
          fireEvent.click(hideButton);
          expect(screen.getByText(expectedMasked)).toBeInTheDocument();

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- Property 4: Non-PUBLISHED status guard ----

/**
 * Feature: app-publishing-frontend-gaps, Property 4: Non-PUBLISHED status guard
 *
 * For any app status that is not 'PUBLISHED' (i.e., 'DRAFT', 'APPROVED', or
 * 'DEPRECATED'), the API Dashboard page should render a "not published" guard
 * message and should not render the keys table or metrics charts.
 *
 * **Validates: Requirements 4.4**
 */
describe('Property 4: Non-PUBLISHED status guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows guard message and hides keys/metrics for non-PUBLISHED statuses', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('DRAFT', 'APPROVED', 'DEPRECATED'),
        async (status) => {
          (appApiService.getApp as jest.Mock).mockResolvedValue({
            name: 'Guard Test App',
            status,
            appId: 'app-test',
          });

          const { unmount } = render(React.createElement(AppApiDashboard, defaultProps));

          // Wait for the guard message to appear
          await waitFor(() => {
            expect(
              screen.getByText('This app must be published before API data is available.'),
            ).toBeInTheDocument();
          });

          // Keys table should not be rendered
          expect(screen.queryByText('API Keys')).not.toBeInTheDocument();

          // Metrics section should not be rendered
          expect(screen.queryByText('Metrics')).not.toBeInTheDocument();

          // Charts should not be rendered
          expect(screen.queryByTestId('responsive-container')).not.toBeInTheDocument();

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---- Property 5: Metrics summary card completeness ----

/**
 * Feature: app-publishing-frontend-gaps, Property 5: Metrics summary completeness
 *
 * For any valid AppMetrics object, the rendered metrics summary section should
 * contain text representations of all seven required fields: total requests,
 * success count, client error count, server error count, p50 latency,
 * p95 latency, and p99 latency.
 *
 * **Validates: Requirements 6.2**
 */
describe('Property 5: Metrics summary completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all seven metric values for any valid AppMetrics', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          totalRequests: fc.nat(),
          successCount: fc.nat(),
          clientErrorCount: fc.nat(),
          serverErrorCount: fc.nat(),
          p50Latency: fc.double({ min: 0, max: 10000, noNaN: true }),
          p95Latency: fc.double({ min: 0, max: 10000, noNaN: true }),
          p99Latency: fc.double({ min: 0, max: 10000, noNaN: true }),
          timeSeries: fc.constant([]),
        }),
        async (metrics) => {
          (appApiService.getApp as jest.Mock).mockResolvedValue({
            name: 'Metrics App',
            status: 'PUBLISHED',
            appId: 'app-test',
          });
          (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
          (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(metrics);

          const { unmount, container } = render(
            React.createElement(AppApiDashboard, defaultProps),
          );

          // Wait for metrics to render — look for the "Total Requests" label
          await waitFor(() => {
            expect(screen.getByText('Total Requests')).toBeInTheDocument();
          });

          const content = container.textContent || '';

          // Verify all 7 metric values are present in the rendered output
          // Integer metrics use toLocaleString() formatting
          expect(content).toContain(metrics.totalRequests.toLocaleString());
          expect(content).toContain(metrics.successCount.toLocaleString());
          expect(content).toContain(metrics.clientErrorCount.toLocaleString());
          expect(content).toContain(metrics.serverErrorCount.toLocaleString());

          // Latency metrics use toFixed(1) + " ms" formatting
          expect(content).toContain(metrics.p50Latency.toFixed(1) + ' ms');
          expect(content).toContain(metrics.p95Latency.toFixed(1) + ' ms');
          expect(content).toContain(metrics.p99Latency.toFixed(1) + ' ms');

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });
});
