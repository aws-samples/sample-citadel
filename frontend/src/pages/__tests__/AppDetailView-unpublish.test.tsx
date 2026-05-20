/**
 * AppDetailView unpublish flow unit tests
 * Tests: unpublish button visibility, confirmation dialog, loading state,
 * success returns to DRAFT, partial failure warnings
 * Validates: Requirements 8.1, 8.5, 8.7
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

// Mock UI components
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
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

const baseApp = {
  appId: 'app-unpub',
  orgId: 'org-1',
  name: 'Published App',
  description: 'App for unpublish testing',
  workflowIds: ['wf-1'],
  agentBindings: [
    { agentId: 'agent-1', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' },
  ],
  permissions: [],
  configSchema: null,
  configValues: null,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 2,
};

const publishedApp = {
  ...baseApp,
  status: 'PUBLISHED' as const,
  endpointUrl: 'https://xyz789.execute-api.us-east-1.amazonaws.com',
  apiId: 'xyz789',
  authMode: 'API_KEY',
};

const draftApp = {
  ...baseApp,
  status: 'DRAFT' as const,
};

const activeApp = {
  ...baseApp,
  status: 'ACTIVE' as const,
};

const defaultProps = {
  appId: 'app-unpub',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

describe('AppDetailView — Unpublish Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tabsOnValueChange = null;
    jest.useFakeTimers();
    (workflowApiService.getWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1', name: 'Test WF', status: 'PUBLISHED', nodes: [{ id: 'n1' }],
    });
    (appApiService.listAppApiKeys as jest.Mock).mockResolvedValue([]);
    (appApiService.getAppMetrics as jest.Mock).mockResolvedValue({
      totalRequests: 0, successCount: 0, clientErrorCount: 0, serverErrorCount: 0,
      p50Latency: 0, p95Latency: 0, p99Latency: 0, timeSeries: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Req 8.1: "Unpublish" button visible when status is PUBLISHED
  it('shows "Unpublish" button when app status is PUBLISHED', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    expect(screen.getByText('Unpublish')).toBeInTheDocument();
  });

  it('does not show "Unpublish" button when app status is DRAFT', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(draftApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    expect(screen.queryByText('Unpublish')).not.toBeInTheDocument();
  });

  it('does not show "Unpublish" button when app status is ACTIVE', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Published App')).toBeInTheDocument();
    });

    expect(screen.queryByText('Unpublish')).not.toBeInTheDocument();
  });

  // Req 8.5: Confirmation dialog warns about teardown consequences
  it('opens confirmation dialog with teardown warning when Unpublish is clicked', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Unpublish'));

    await waitFor(() => {
      expect(screen.getByText('Unpublish App')).toBeInTheDocument();
    });

    // Should warn about teardown consequences
    expect(screen.getByText(/API Gateway endpoint will be deleted/i)).toBeInTheDocument();
  });

  // Loading state during teardown
  it('shows loading state during unpublish teardown', async () => {
    let resolveUnpublish: (value: any) => void;
    const unpublishPromise = new Promise((resolve) => { resolveUnpublish = resolve; });
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    (appApiService.unpublishApp as jest.Mock).mockReturnValue(unpublishPromise);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Unpublish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Unpublish'));

    await waitFor(() => {
      expect(screen.getByText('Unpublishing...')).toBeInTheDocument();
    });

    // Resolve to clean up
    await act(async () => {
      resolveUnpublish!({ ...draftApp });
    });
  });

  // Req 8.5: Success returns to DRAFT status, API tab hidden
  it('returns to DRAFT status and hides API tab on successful unpublish', async () => {
    const draftResult = { ...baseApp, status: 'DRAFT' as const };
    (appApiService.getApp as jest.Mock)
      .mockResolvedValueOnce(publishedApp)
      .mockResolvedValueOnce(draftResult);
    (appApiService.unpublishApp as jest.Mock).mockResolvedValue(draftResult);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Unpublish')).toBeInTheDocument();
    });

    // API tab should be visible for PUBLISHED
    const apiTab = screen.getByRole('tab', { name: /API/i });
    expect(apiTab).toBeInTheDocument();

    fireEvent.click(screen.getByText('Unpublish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Unpublish'));

    // After unpublish, app reloads as DRAFT
    await waitFor(() => {
      const badges = screen.getAllByTestId('badge');
      const draftBadge = badges.find(b => b.textContent === 'DRAFT');
      expect(draftBadge).toBeTruthy();
    });

    // API tab should no longer be visible
    expect(screen.queryByRole('tab', { name: /API/i })).not.toBeInTheDocument();
  });

  // Req 8.7: Warnings displayed for partial teardown failures
  it('displays warnings for partial teardown failures', async () => {
    const resultWithWarnings = {
      ...baseApp,
      status: 'DRAFT' as const,
      warnings: ['Failed to delete API Gateway: timeout', 'Failed to revoke 2 keys'],
    };
    (appApiService.getApp as jest.Mock)
      .mockResolvedValueOnce(publishedApp)
      .mockResolvedValueOnce(resultWithWarnings);
    (appApiService.unpublishApp as jest.Mock).mockResolvedValue(resultWithWarnings);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Unpublish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Unpublish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Unpublish'));

    await waitFor(() => {
      expect(screen.getByText(/Failed to delete API Gateway/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Failed to revoke 2 keys/)).toBeInTheDocument();
  });
});
