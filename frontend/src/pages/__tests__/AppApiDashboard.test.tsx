/**
 * AppApiDashboard unit tests
 * Tests: loading states, empty states, error states with retry,
 * create/revoke/rotate key actions, time range selector re-fetch, chart rendering
 * Validates: Requirements 4.3, 4.4, 5.1–5.8, 6.1–6.8, 7.1–7.5
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';

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

// ---- Mock data ----

const mockApp = { name: 'Test App', status: 'PUBLISHED', appId: 'app-123' };
const mockAppDraft = { name: 'Draft App', status: 'DRAFT', appId: 'app-456' };
const mockKeys = [
  {
    keyId: 'key-1',
    name: 'Production Key',
    prefix: 'a1b2c3d4',
    status: 'ACTIVE',
    createdAt: '2024-01-01T00:00:00Z',
    expiresAt: null,
    lastUsedAt: '2024-06-01T00:00:00Z',
  },
  {
    keyId: 'key-2',
    name: 'Staging Key',
    prefix: 'e5f6g7h8',
    status: 'REVOKED',
    createdAt: '2024-02-01T00:00:00Z',
    expiresAt: '2025-01-01T00:00:00Z',
    lastUsedAt: null,
  },
];
const mockMetrics = {
  totalRequests: 10000,
  successCount: 9500,
  clientErrorCount: 300,
  serverErrorCount: 200,
  p50Latency: 45.2,
  p95Latency: 120.5,
  p99Latency: 250.8,
  timeSeries: [
    { timestamp: '2024-06-01T00:00:00Z', requestCount: 100, errorCount: 5, avgLatency: 50 },
    { timestamp: '2024-06-01T01:00:00Z', requestCount: 150, errorCount: 8, avgLatency: 55 },
  ],
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

// ---- Helpers ----

function setupPublishedApp() {
  (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
  (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockKeys);
  (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);
}

function setupPublishedAppEmpty() {
  (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
  (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
  (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(null);
}

// ---- Tests ----

describe('AppApiDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. Shows loading state while fetching app data
  it('shows loading state while fetching app data', () => {
    (appApiService.getApp as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves
    render(React.createElement(AppApiDashboard, defaultProps));
    expect(screen.getByText('Loading app data…')).toBeInTheDocument();
  });

  // 2. Shows error state with retry button when getApp fails
  it('shows error state with retry button when getApp fails', async () => {
    (appApiService.getApp as jest.Mock).mockRejectedValue(new Error('Network error'));
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();

    // Clicking retry calls getApp again
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(null);

    await act(async () => {
      fireEvent.click(screen.getByText('Retry'));
    });

    expect(appApiService.getApp).toHaveBeenCalledTimes(2);
  });

  // 3. Shows non-PUBLISHED guard message when app status is DRAFT
  it('shows non-PUBLISHED guard message when app status is DRAFT', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockAppDraft);
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(
        screen.getByText('This app must be published before API data is available.')
      ).toBeInTheDocument();
    });
  });

  // 4. Shows loading indicator while fetching keys
  it('shows loading indicator while fetching keys', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (appApiService.listAppApiKeys as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(null);

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Loading API keys…')).toBeInTheDocument();
    });
  });

  // 5. Shows empty state when no keys exist
  it('shows empty state when no keys exist', async () => {
    setupPublishedAppEmpty();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(
        screen.getByText('No API keys yet. Create your first key to get started.')
      ).toBeInTheDocument();
    });
  });

  // 6. Shows error state with retry for keys section when listAppApiKeys fails
  it('shows error state with retry for keys section when listAppApiKeys fails', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (appApiService.listAppApiKeys as jest.Mock).mockRejectedValue(new Error('Keys fetch failed'));
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Keys fetch failed')).toBeInTheDocument();
    });
  });

  // 7. Renders keys table with masked keys when keys are loaded
  it('renders keys table with masked keys when keys are loaded', async () => {
    setupPublishedApp();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Production Key')).toBeInTheDocument();
    });

    expect(screen.getByText('Staging Key')).toBeInTheDocument();
    // Masked key format: 8-char prefix + 8 asterisks
    expect(screen.getByText('a1b2c3d4********')).toBeInTheDocument();
    expect(screen.getByText('e5f6g7h8********')).toBeInTheDocument();
  });

  // 8. Create key action — opens dialog, calls createAppApiKey, refreshes list
  it('opens create dialog, calls createAppApiKey, and refreshes list', async () => {
    setupPublishedApp();
    (appApiService.createAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-3',
      name: 'New Key',
      prefix: 'x1y2z3w4',
      status: 'ACTIVE',
      createdAt: '2024-07-01T00:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
      apiKey: 'new-key-plaintext-value',
    });

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Production Key')).toBeInTheDocument();
    });

    // Click "Create API Key" button
    fireEvent.click(screen.getByText('Create API Key'));

    // Dialog should open
    await waitFor(() => {
      expect(screen.getByText('Enter a name and optional expiration for the new API key.')).toBeInTheDocument();
    });

    // Type a name
    const input = screen.getByPlaceholderText('Key name (required)');
    fireEvent.change(input, { target: { value: 'New Key' } });

    // Click Create
    await act(async () => {
      fireEvent.click(screen.getByText('Create'));
    });

    expect(appApiService.createAppApiKey).toHaveBeenCalledWith('app-123', 'New Key', undefined);
    // fetchKeys is called again after dismissing confirmation
    await waitFor(() => {
      expect(screen.getByText('API Key Created')).toBeInTheDocument();
    });
  });

  // 8b. Create dialog two-step state machine: submit→confirmation shows apiKey
  it('shows plaintext apiKey in confirmation step after create', async () => {
    setupPublishedApp();
    (appApiService.createAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-new',
      name: 'My Key',
      prefix: 'abcd1234',
      status: 'ACTIVE',
      createdAt: '2024-07-01T00:00:00Z',
      apiKey: 'plaintext-secret-key-value',
    });

    render(React.createElement(AppApiDashboard, defaultProps));
    await waitFor(() => expect(screen.getByText('Production Key')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Create API Key'));
    await waitFor(() => expect(screen.getByText('Create API Key', { selector: 'h2' })).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Key name (required)');
    fireEvent.change(input, { target: { value: 'My Key' } });

    await act(async () => { fireEvent.click(screen.getByText('Create')); });

    // Confirmation step: shows plaintext key and "API Key Created" title
    await waitFor(() => {
      expect(screen.getByText('API Key Created')).toBeInTheDocument();
      expect(screen.getByText('plaintext-secret-key-value')).toBeInTheDocument();
    });
  });

  // 8c. Create dialog: dismiss confirmation triggers fetchKeys
  it('dismissing create confirmation triggers fetchKeys', async () => {
    setupPublishedApp();
    (appApiService.createAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-new',
      name: 'My Key',
      prefix: 'abcd1234',
      status: 'ACTIVE',
      createdAt: '2024-07-01T00:00:00Z',
      apiKey: 'plaintext-secret-key-value',
    });

    render(React.createElement(AppApiDashboard, defaultProps));
    await waitFor(() => expect(screen.getByText('Production Key')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Create API Key'));
    await waitFor(() => expect(screen.getByPlaceholderText('Key name (required)')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Key name (required)'), { target: { value: 'My Key' } });
    await act(async () => { fireEvent.click(screen.getByText('Create')); });

    await waitFor(() => expect(screen.getByText('API Key Created')).toBeInTheDocument());

    const callsBefore = (appApiService.listAppApiKeys as jest.Mock).mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByText('Done')); });

    expect((appApiService.listAppApiKeys as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  // 10b. Rotate defensive branch: missing apiKey shows error
  it('shows error when rotateAppApiKey returns no apiKey', async () => {
    setupPublishedApp();
    (appApiService.rotateAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-new',
      prefix: 'newprefix',
      status: 'ACTIVE',
      // apiKey intentionally missing
    });

    render(React.createElement(AppApiDashboard, defaultProps));
    await waitFor(() => expect(screen.getByText('Production Key')).toBeInTheDocument());

    const rotateButton = screen.getByTitle('Rotate key');
    await act(async () => { fireEvent.click(rotateButton); });

    // Should show error message, not the rotate dialog
    await waitFor(() => {
      expect(screen.getByText(/plaintext was not returned/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Key Rotated')).not.toBeInTheDocument();
  });

  // 10c. Rotate: present apiKey opens rotate dialog
  it('opens rotate dialog when apiKey is present in response', async () => {
    setupPublishedApp();
    (appApiService.rotateAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-new',
      prefix: 'newprefix',
      status: 'ACTIVE',
      apiKey: 'rotated-plaintext-key',
    });

    render(React.createElement(AppApiDashboard, defaultProps));
    await waitFor(() => expect(screen.getByText('Production Key')).toBeInTheDocument());

    const rotateButton = screen.getByTitle('Rotate key');
    await act(async () => { fireEvent.click(rotateButton); });

    await waitFor(() => {
      expect(screen.getByText('Key Rotated')).toBeInTheDocument();
      expect(screen.getByText('rotated-plaintext-key')).toBeInTheDocument();
    });
  });

  // 9. Revoke key action — calls revokeAppApiKey, refreshes list
  it('calls revokeAppApiKey and refreshes list when revoke is clicked', async () => {
    setupPublishedApp();
    (appApiService.revokeAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-1',
      status: 'REVOKED',
    });

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Production Key')).toBeInTheDocument();
    });

    // Find the revoke button (title="Revoke key")
    const revokeButton = screen.getByTitle('Revoke key');
    await act(async () => {
      fireEvent.click(revokeButton);
    });

    expect(appApiService.revokeAppApiKey).toHaveBeenCalledWith('app-123', 'key-1');
    // fetchKeys is called again to refresh
    expect(appApiService.listAppApiKeys).toHaveBeenCalledTimes(2);
  });

  // 10. Rotate key action — calls rotateAppApiKey, shows new key dialog
  it('calls rotateAppApiKey and shows new key dialog', async () => {
    setupPublishedApp();
    (appApiService.rotateAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-new',
      prefix: 'newprefix',
      status: 'ACTIVE',
      apiKey: 'rotated-key-plaintext',
    });

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Production Key')).toBeInTheDocument();
    });

    // Find the rotate button (title="Rotate key")
    const rotateButton = screen.getByTitle('Rotate key');
    await act(async () => {
      fireEvent.click(rotateButton);
    });

    expect(appApiService.rotateAppApiKey).toHaveBeenCalledWith('app-123', 'key-1');

    // Rotate dialog should show with the new key info
    await waitFor(() => {
      expect(screen.getByText('Key Rotated')).toBeInTheDocument();
    });
  });

  // 11. Shows skeleton placeholders while metrics are loading
  it('shows skeleton placeholders while metrics are loading', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockKeys);
    (appApiService.getAppMetrics as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      const skeletons = screen.getAllByTestId('skeleton');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  // 12. Shows empty state when no metrics data
  it('shows empty state when no metrics data', async () => {
    setupPublishedAppEmpty();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(
        screen.getByText('No data available for the selected time range')
      ).toBeInTheDocument();
    });
  });

  // 13. Shows error state with retry for metrics section when getAppMetrics fails
  it('shows error state with retry for metrics section when getAppMetrics fails', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(mockApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockKeys);
    (appApiService.getAppMetrics as jest.Mock).mockRejectedValue(new Error('Metrics fetch failed'));

    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('Metrics fetch failed')).toBeInTheDocument();
    });
  });

  // 14. Renders metrics summary cards with correct values
  it('renders metrics summary cards with correct values', async () => {
    setupPublishedApp();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('10,000')).toBeInTheDocument();
    });

    expect(screen.getByText('9,500')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('45.2 ms')).toBeInTheDocument();
    expect(screen.getByText('120.5 ms')).toBeInTheDocument();
    expect(screen.getByText('250.8 ms')).toBeInTheDocument();
  });

  // 15. Time range selector — clicking a different range re-fetches metrics
  it('re-fetches metrics when a different time range is clicked', async () => {
    setupPublishedApp();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('10,000')).toBeInTheDocument();
    });

    // getAppMetrics was called once on mount (default 24h)
    const initialCallCount = (appApiService.getAppMetrics as jest.Mock).mock.calls.length;

    // Click "1h" time range
    await act(async () => {
      fireEvent.click(screen.getByText('1h'));
    });

    await waitFor(() => {
      expect((appApiService.getAppMetrics as jest.Mock).mock.calls.length).toBeGreaterThan(
        initialCallCount
      );
    });
  });

  // 16. Renders chart containers (verify recharts mock divs are present)
  it('renders chart containers when metrics with timeSeries are loaded', async () => {
    setupPublishedApp();
    render(React.createElement(AppApiDashboard, defaultProps));

    await waitFor(() => {
      expect(screen.getByText('10,000')).toBeInTheDocument();
    });

    // Charts should be rendered (3 charts: Request Counts, Error Rates, Latency)
    expect(screen.getByText('Request Counts')).toBeInTheDocument();
    expect(screen.getByText('Error Rates')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();

    const containers = screen.getAllByTestId('responsive-container');
    expect(containers.length).toBe(3);

    const lineCharts = screen.getAllByTestId('line-chart');
    expect(lineCharts.length).toBe(3);
  });
});
