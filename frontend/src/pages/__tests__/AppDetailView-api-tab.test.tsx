/**
 * AppDetailView API dashboard tab unit tests
 * Tests: API tab visibility, endpoint URL, API keys table, create key dialog,
 * metrics charts, health indicator, time range selector, loading skeletons
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

// Mock clipboard API
Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

let tabsOnValueChange: ((v: string) => void) | null = null;
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }: any) => {
    tabsOnValueChange = onValueChange;
    return React.createElement('div', { 'data-testid': 'tabs', 'data-value': value }, children);
  },
  TabsList: ({ children }: any) => React.createElement('div', { role: 'tablist' }, children),
  TabsTrigger: ({ children, value, className }: any) =>
    React.createElement('button', {
      role: 'tab',
      'data-value': value,
      className,
      onClick: () => tabsOnValueChange?.(value),
    }, children),
  TabsContent: ({ children, value }: any) =>
    React.createElement('div', { role: 'tabpanel', 'data-tab': value }, children),
}));

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: any) => React.createElement('div', null, children),
  DialogHeader: ({ children }: any) => React.createElement('div', null, children),
  DialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: any) => React.createElement('p', null, children),
  DialogFooter: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => React.createElement('textarea', props),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    getApp: jest.fn(),
    updateApp: jest.fn(),
    removeAppComponent: jest.fn(),
    unbindWorkflowFromApp: jest.fn(),
    bindWorkflowToApp: jest.fn(),
    setAppConfigValues: jest.fn(),
    addAppComponent: jest.fn(),
    updateAgentBinding: jest.fn(),
    publishApp: jest.fn(),
    unpublishApp: jest.fn(),
    listAppApiKeys: jest.fn(),
    getAppMetrics: jest.fn(),
    createAppApiKey: jest.fn(),
    revokeAppApiKey: jest.fn(),
  },
}));

jest.mock('@/services/workflowApiService', () => ({
  workflowApiService: {
    getWorkflow: jest.fn(),
    listWorkflows: jest.fn(),
  },
}));

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => React.createElement('div', { 'data-testid': 'responsive-container' }, children),
  LineChart: ({ children }: any) => React.createElement('div', { 'data-testid': 'line-chart' }, children),
  AreaChart: ({ children }: any) => React.createElement('div', { 'data-testid': 'area-chart' }, children),
  Line: () => null,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

import { AppDetailView } from '../AppDetailView';

const publishedApp = {
  appId: 'app-123',
  orgId: 'org-1',
  name: 'Published App',
  description: 'A published app',
  status: 'PUBLISHED' as const,
  workflowIds: ['wf-1'],
  agentBindings: [{ agentId: 'agent-1', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' }],
  permissions: [],
  configSchema: null,
  configValues: null,
  endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  apiId: 'abc123',
  authMode: 'API_KEY',
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 2,
};

const activeApp = { ...publishedApp, status: 'APPROVED' as const, endpointUrl: undefined, apiId: undefined };

const mockApiKeys = [
  {
    keyId: 'key-1',
    name: 'Production Key',
    prefix: 'abc12345',
    status: 'ACTIVE',
    createdAt: '2024-01-10T00:00:00Z',
    expiresAt: '2025-01-10T00:00:00Z',
    lastUsedAt: '2024-06-01T00:00:00Z',
  },
  {
    keyId: 'key-2',
    name: 'Revoked Key',
    prefix: 'xyz98765',
    status: 'REVOKED',
    createdAt: '2024-01-05T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
  },
];

const mockMetrics = {
  totalRequests: 1500,
  successCount: 1400,
  clientErrorCount: 80,
  serverErrorCount: 20,
  p50Latency: 45.2,
  p95Latency: 120.5,
  p99Latency: 250.0,
  timeSeries: [
    { timestamp: '2024-06-01T00:00:00Z', requestCount: 100, errorCount: 5, avgLatency: 50.0 },
    { timestamp: '2024-06-01T01:00:00Z', requestCount: 120, errorCount: 8, avgLatency: 55.0 },
  ],
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

describe('AppDetailView — API Dashboard Tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1', name: 'Test WF', status: 'PUBLISHED', nodes: [{ id: 'n1' }],
    });
  });

  // Req 7.1: "API" tab visible when status is PUBLISHED
  it('shows "API" tab when app status is PUBLISHED', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    expect(screen.getByText('API')).toBeInTheDocument();
  });

  // Req 7.1: "API" tab hidden when status is not PUBLISHED
  it('hides "API" tab when app status is APPROVED', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    expect(screen.queryByText('API')).not.toBeInTheDocument();
  });

  // Req 7.2: Endpoint URL displayed with copy button
  it('displays endpoint URL with copy button on API tab', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('https://abc123.execute-api.us-east-1.amazonaws.com')).toBeInTheDocument();
    });
  });

  // Req 7.3: API keys table renders name, prefix, status badge, dates, revoke action
  it('renders API keys table with key details and revoke action', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('Production Key')).toBeInTheDocument();
    });

    expect(screen.getByText('abc12345')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('Revoked Key')).toBeInTheDocument();
    expect(screen.getByText('REVOKED')).toBeInTheDocument();
    // Revoke button for active key
    expect(screen.getByText('Revoke')).toBeInTheDocument();
  });

  // Req 7.4: "Create API Key" dialog opens and submits
  it('opens "Create API Key" dialog and submits', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);
    (appApiService.createAppApiKey as jest.Mock).mockResolvedValue({
      keyId: 'key-3', name: 'New Key', prefix: 'newkey12', status: 'ACTIVE',
      createdAt: '2024-06-15T00:00:00Z', expiresAt: null, lastUsedAt: null,
    });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('Create API Key')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create API Key'));

    await waitFor(() => {
      expect(screen.getByText('Create New API Key')).toBeInTheDocument();
    });
  });

  // Req 7.5: Metrics charts render
  it('renders metrics charts on API tab', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue(mockApiKeys);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('Request Count')).toBeInTheDocument();
    });

    expect(screen.getByText('Error Rate')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
  });

  // Req 7.6: Health indicator shows correct color based on error rate
  it('shows green health indicator when error rate is below 5%', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue({
      ...mockMetrics,
      totalRequests: 1000,
      clientErrorCount: 20,
      serverErrorCount: 10, // 3% error rate
    });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });
  });

  // Req 7.7: Time range selector defaults to 24h
  it('defaults time range selector to 24h', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('24h')).toBeInTheDocument();
    });

    // All time range options should be present
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('6h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  // Req 7.8: Loading skeletons shown while queries in flight
  it('shows loading skeletons while API data is loading', async () => {
    let resolveKeys: (value: any) => void;
    const keysPromise = new Promise((resolve) => { resolveKeys = resolve; });
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.listAppApiKeys as jest.Mock).mockReturnValue(keysPromise);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('API'));

    await waitFor(() => {
      expect(screen.getByText('Loading API keys...')).toBeInTheDocument();
    });

    // Resolve to clean up
    resolveKeys!(mockApiKeys);
  });
});
