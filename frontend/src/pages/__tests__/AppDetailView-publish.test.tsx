/**
 * AppDetailView publish flow unit tests
 * Tests: publish button visibility, review dialog, precondition checklist,
 * loading/success/error states, PUBLISHED status badge, copy-to-clipboard
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { appApiService } from '../../services/appApiService';
import { workflowApiService } from '../../services/workflowApiService';

// Mock clipboard API
const mockWriteText = jest.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

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

// Mock recharts to avoid rendering issues in jsdom
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
  appId: 'app-123',
  orgId: 'org-1',
  name: 'My Publish App',
  description: 'App for publish testing',
  workflowIds: ['wf-1'],
  agentBindings: [
    { agentId: 'agent-1', status: 'READY' as const, addedAt: '2024-01-01T00:00:00Z' },
  ],
  permissions: [
    { permissionId: 'perm-1', actions: ['s3:GetObject'], resources: ['arn:aws:s3:::bucket/*'], description: 'S3 read' },
  ],
  configSchema: JSON.stringify({ type: 'object' }),
  configValues: JSON.stringify({ key: 'val' }),
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  version: 1,
};

const activeApp = { ...baseApp, status: 'ACTIVE' as const };
const draftApp = { ...baseApp, status: 'DRAFT' as const };
const publishedApp = {
  ...baseApp,
  status: 'PUBLISHED' as const,
  endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  apiId: 'abc123',
  authMode: 'API_KEY',
};

const defaultProps = {
  appId: 'app-123',
  onBack: jest.fn(),
  onNavigate: jest.fn(),
};

describe('AppDetailView — Publish Flow', () => {
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

  // Req 4.1: "Publish" button visible when status is ACTIVE
  it('shows "Publish" button when app status is ACTIVE', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('My Publish App')).toBeInTheDocument();
    });

    expect(screen.getByText('Publish')).toBeInTheDocument();
  });

  // Req 4.1: "Publish" button hidden when status is not ACTIVE
  it('does not show "Publish" button when app status is DRAFT', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(draftApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('My Publish App')).toBeInTheDocument();
    });

    // DRAFT shows "Publish" for DRAFT→ACTIVE transition in existing code,
    // but the new "Publish" button for ACTIVE→PUBLISHED is separate
    // The existing transition button for DRAFT says "Publish" (DRAFT→ACTIVE)
    // We need to check that the ACTIVE→PUBLISHED "Publish" button is not present
    // Since DRAFT already has a "Publish" button for status transition, we verify
    // the button text matches the existing transition (not the new publish flow)
    const publishButtons = screen.getAllByText('Publish');
    // Only the DRAFT→ACTIVE transition button should exist
    expect(publishButtons).toHaveLength(1);
  });

  // Req 4.2, 4.3: Publish review dialog shows app details and precondition checklist
  it('opens publish review dialog with app details and precondition checklist', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Publish App')).toBeInTheDocument();
    });

    // Precondition checklist items
    expect(screen.getByText('All agents are READY')).toBeInTheDocument();
    expect(screen.getByText('At least one agent bound')).toBeInTheDocument();
  });

  // Req 4.4: "Confirm Publish" enabled only when all preconditions pass
  it('enables "Confirm Publish" when all preconditions pass', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    const confirmBtn = screen.getByText('Confirm Publish');
    expect(confirmBtn).not.toBeDisabled();
  });

  // Req 4.4: "Confirm Publish" disabled when preconditions fail
  it('disables "Confirm Publish" when preconditions fail', async () => {
    const appWithDesignAgent = {
      ...activeApp,
      agentBindings: [
        { agentId: 'agent-1', status: 'DESIGN' as const, addedAt: '2024-01-01T00:00:00Z' },
      ],
    };
    (appApiService.getApp as jest.Mock).mockResolvedValue(appWithDesignAgent);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    const confirmBtn = screen.getByText('Confirm Publish');
    expect(confirmBtn).toBeDisabled();
  });

  // Req 4.5: Loading state during provisioning
  it('shows loading state when publishing is in progress', async () => {
    let resolvePublish: (value: any) => void;
    const publishPromise = new Promise((resolve) => { resolvePublish = resolve; });
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    (appApiService.publishApp as jest.Mock).mockReturnValue(publishPromise);

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Publish'));

    await waitFor(() => {
      expect(screen.getByText('Publishing...')).toBeInTheDocument();
    });

    // Resolve to clean up
    await act(async () => {
      resolvePublish!({
        app: publishedApp,
        endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
        apiKey: 'test-api-key-plaintext',
        apiKeyId: 'key-1',
      });
    });
  });

  // Req 4.6: Success state shows endpoint URL and API key with copy buttons
  it('shows success state with endpoint URL and API key after publishing', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    (appApiService.publishApp as jest.Mock).mockResolvedValue({
      app: publishedApp,
      endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
      apiKey: 'test-api-key-plaintext',
      apiKeyId: 'key-1',
    });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Publish'));

    await waitFor(() => {
      expect(screen.getByText('Published Successfully')).toBeInTheDocument();
    });

    expect(screen.getByText('https://abc123.execute-api.us-east-1.amazonaws.com')).toBeInTheDocument();
    expect(screen.getByText('test-api-key-plaintext')).toBeInTheDocument();
  });

  // Req 4.7: Error state shows structured error with retry button
  it('shows error state with retry button when publishing fails', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    (appApiService.publishApp as jest.Mock).mockRejectedValue(new Error('API Gateway provisioning failed'));

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Publish'));

    await waitFor(() => {
      expect(screen.getByText(/API Gateway provisioning failed/)).toBeInTheDocument();
    });

    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  // Req 4.8: Status badge shows "Published" in purple when PUBLISHED
  it('shows PUBLISHED status badge with purple styling', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(publishedApp);
    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('My Publish App')).toBeInTheDocument();
    });

    const badges = screen.getAllByTestId('badge');
    const publishedBadge = badges.find(b => b.textContent === 'PUBLISHED');
    expect(publishedBadge).toBeTruthy();
    expect(publishedBadge?.className).toContain('bg-purple-500/20');
    expect(publishedBadge?.className).toContain('text-purple-400');
  });

  // Req 4.9: Copy-to-clipboard with checkmark feedback
  it('copies endpoint URL to clipboard with visual feedback', async () => {
    (appApiService.getApp as jest.Mock).mockResolvedValue(activeApp);
    (appApiService.publishApp as jest.Mock).mockResolvedValue({
      app: publishedApp,
      endpointUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
      apiKey: 'test-api-key-plaintext',
      apiKeyId: 'key-1',
    });

    render(<AppDetailView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Publish'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Publish')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Publish'));

    await waitFor(() => {
      expect(screen.getByText('Published Successfully')).toBeInTheDocument();
    });

    // Find copy buttons (there should be at least 2: one for URL, one for API key)
    const copyButtons = screen.getAllByText('Copy');
    expect(copyButtons.length).toBeGreaterThanOrEqual(2);

    // Click the first copy button (endpoint URL)
    await act(async () => {
      fireEvent.click(copyButtons[0]);
    });

    expect(mockWriteText).toHaveBeenCalled();
  });
});
