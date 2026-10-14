/**
 * ToolCard + AgentTools — tool registry lifecycle controls.
 *
 * Validates that ToolCard renders the correct control surface for each
 * registryStatus value (DRAFT, PENDING_APPROVAL, APPROVED, REJECTED), that
 * Submit-for-review calls the mutation with status PENDING_APPROVAL, that
 * API errors surface in a toast, and that the Configuration button is absent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// --- UI mocks ---

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className, ...props }: any) =>
    React.createElement('span', { className, 'data-testid': props['data-testid'] || 'badge', ...props }, children),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardContent: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardDescription: ({ children, className }: any) => React.createElement('p', { className }, children),
  CardHeader: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardTitle: ({ children, className }: any) => React.createElement('h3', { className }, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
}));

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'alert-dialog' }, children) : null,
  AlertDialogContent: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogHeader: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogFooter: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  AlertDialogDescription: ({ children }: any) => React.createElement('p', null, children),
  AlertDialogAction: ({ children, onClick }: any) =>
    React.createElement('button', { onClick, 'data-testid': 'deprecate-confirm' }, children),
  AlertDialogCancel: ({ children, onClick }: any) =>
    React.createElement('button', { onClick, 'data-testid': 'deprecate-cancel' }, children),
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1', currentUser: { role: 'admin' } }),
}));

jest.mock('@/components/ToolTestingSandbox', () => ({
  ToolTestingSandbox: () => null,
}));

jest.mock('@/components/tool-card-badge-helpers', () => ({
  extractBindingBadges: () => [],
}));

jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement('div', null, children),
}));

import { ToolCard } from '../../components/ToolCard';
import type { ToolConfig } from '../../services/toolConfigService';

function makeTool(registryStatus: string, state: ToolConfig['state'] = 'maintenance', extra: Partial<ToolConfig> = {}): ToolConfig {
  return {
    toolId: `tool-${registryStatus.toLowerCase()}`,
    config: JSON.stringify({ name: `${registryStatus} Tool`, description: 'test desc' }),
    state,
    categories: [],
    registryStatus,
    ...extra,
  };
}

function makeLegacy(state: ToolConfig['state'] = 'active'): ToolConfig {
  return {
    toolId: 'legacy-tool',
    config: JSON.stringify({ name: 'Legacy Tool', description: 'test desc' }),
    state,
    categories: [],
  } as ToolConfig;
}

describe('ToolCard — lifecycle controls by registryStatus', () => {
  const noop = () => {};

  it('DRAFT → renders "Submit for review" button', () => {
    render(
      <ToolCard tool={makeTool('DRAFT')} onToggleState={noop} onConfigure={noop}
        onSubmitForReview={noop} userRole="admin" />,
    );
    expect(screen.getByText('Submit for review')).toBeInTheDocument();
    expect(screen.getByTestId('submit-for-review')).toBeInTheDocument();
  });

  it('DRAFT → Submit calls onSubmitForReview', () => {
    const onSubmit = jest.fn();
    const tool = makeTool('DRAFT');
    render(
      <ToolCard tool={tool} onToggleState={noop} onConfigure={noop}
        onSubmitForReview={onSubmit} userRole="admin" />,
    );
    fireEvent.click(screen.getByTestId('submit-for-review'));
    expect(onSubmit).toHaveBeenCalledWith(tool);
  });

  it('DRAFT + submitSuccess → shows "Submitted for review" badge instead of button', () => {
    render(
      <ToolCard tool={makeTool('DRAFT')} onToggleState={noop} onConfigure={noop}
        onSubmitForReview={noop} submitSuccess={true} userRole="admin" />,
    );
    expect(screen.getByText('Submitted for review')).toBeInTheDocument();
    expect(screen.queryByTestId('submit-for-review')).not.toBeInTheDocument();
  });

  it('PENDING_APPROVAL → renders "Awaiting approval" badge and link to /approvals', () => {
    render(
      <ToolCard tool={makeTool('PENDING_APPROVAL', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    const link = screen.getByTestId('approvals-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/approvals');
  });

  it('PENDING_REVIEW → renders "Awaiting approval" badge and link to /approvals', () => {
    render(
      <ToolCard tool={makeTool('PENDING_REVIEW', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    expect(screen.getByTestId('approvals-link')).toHaveAttribute('href', '/approvals');
  });

  it('APPROVED → renders existing Deprecate button (no Submit/Awaiting)', () => {
    render(
      <ToolCard tool={makeTool('APPROVED', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Deprecate')).toBeInTheDocument();
    expect(screen.queryByText('Submit for review')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting approval')).not.toBeInTheDocument();
  });

  it('REJECTED → renders "Rejected" badge with statusReason', () => {
    render(
      <ToolCard tool={makeTool('REJECTED', 'inactive', { statusReason: 'Insufficient docs' })}
        onToggleState={noop} onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByTestId('rejected-badge')).toHaveTextContent('Rejected');
    expect(screen.getByTestId('rejection-reason')).toHaveTextContent('Insufficient docs');
  });

  it('REJECTED → does not show a Resubmit or Activate button', () => {
    render(
      <ToolCard tool={makeTool('REJECTED', 'inactive')}
        onToggleState={noop} onConfigure={noop} userRole="admin" />,
    );
    expect(screen.queryByText('Resubmit')).not.toBeInTheDocument();
    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit for review')).not.toBeInTheDocument();
  });

  it('Legacy active → shows Deactivate (unchanged)', () => {
    render(
      <ToolCard tool={makeLegacy('active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('Legacy inactive → shows Activate (unchanged)', () => {
    render(
      <ToolCard tool={makeLegacy('inactive')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Activate')).toBeInTheDocument();
  });
});

describe('ToolCard — Configuration button absent', () => {
  const noop = () => {};

  it('does not render a Configure tool button', () => {
    render(
      <ToolCard tool={makeTool('APPROVED', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" configureDisabled={true} />,
    );
    expect(screen.queryByRole('button', { name: /configure tool/i })).not.toBeInTheDocument();
  });

  it('does not render a "Coming soon" tooltip', () => {
    render(
      <ToolCard tool={makeTool('APPROVED', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" configureDisabled={true} />,
    );
    const tooltips = screen.queryAllByTestId('tooltip-content');
    const comingSoon = tooltips.some((el) => /coming soon/i.test(el.textContent || ''));
    expect(comingSoon).toBe(false);
  });
});

describe('ToolCard — transient and unknown statuses', () => {
  const noop = () => {};

  it('UPDATING → renders disabled "Updating…" button with no lifecycle actions', () => {
    render(
      <ToolCard tool={makeTool('UPDATING', 'active')} onToggleState={noop} onConfigure={noop}
        userRole="admin" />,
    );
    const btn = screen.getByTestId('updating-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Updating…');
    expect(btn).toBeDisabled();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit for review')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('CREATING → also renders disabled "Updating…" button', () => {
    render(
      <ToolCard tool={makeTool('CREATING', 'maintenance')} onToggleState={noop} onConfigure={noop}
        userRole="admin" />,
    );
    const btn = screen.getByTestId('updating-button');
    expect(btn).toHaveTextContent('Updating…');
    expect(btn).toBeDisabled();
  });

  it('PENDING_APPROVAL → renders "Awaiting approval" badge and approvals link', () => {
    render(
      <ToolCard tool={makeTool('PENDING_APPROVAL', 'active')} onToggleState={noop}
        onConfigure={noop} userRole="admin" />,
    );
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
    const link = screen.getByTestId('approvals-link');
    expect(link).toHaveAttribute('href', '/approvals');
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });

  it('DRAFT → never shows Deprecate', () => {
    render(
      <ToolCard tool={makeTool('DRAFT', 'maintenance')} onToggleState={noop} onConfigure={noop}
        onSubmitForReview={noop} userRole="admin" />,
    );
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
    // Should show Submit instead
    expect(screen.getByText('Submit for review')).toBeInTheDocument();
  });

  it('unknown status → renders a badge with the raw status value', () => {
    render(
      <ToolCard tool={makeTool('BETA_TESTING', 'active')} onToggleState={noop} onConfigure={noop}
        userRole="admin" />,
    );
    const badge = screen.getByTestId('unknown-status-badge');
    expect(badge).toHaveTextContent('BETA_TESTING');
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit for review')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });
});

// --- AgentTools integration: submit + error toast ---

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: jest.fn(),
    updateToolConfig: jest.fn(),
  },
}));

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/FabricationButton', () => ({
  FabricationButton: () => React.createElement('div', { 'data-testid': 'fabrication-button' }),
}));

jest.mock('@/components/FabricationTray', () => ({
  FabricationTray: () => React.createElement('div', { 'data-testid': 'fabrication-tray' }),
}));

jest.mock('@/components/CreateToolWizard', () => ({
  CreateToolWizard: () => React.createElement('div', { 'data-testid': 'create-tool-wizard' }),
}));

jest.mock('@/components/DataStoreToolWizard', () => ({
  DataStoreToolWizard: () => React.createElement('div', { 'data-testid': 'datastore-wizard' }),
}));

jest.mock('@/components/IntegrationToolWizard', () => ({
  IntegrationToolWizard: () => React.createElement('div', { 'data-testid': 'integration-wizard' }),
}));

jest.mock('@/components/DataPipelineWizard', () => ({
  DataPipelineWizard: () => React.createElement('div', { 'data-testid': 'pipeline-wizard' }),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) =>
    React.createElement('input', { ...props, 'data-testid': 'search' }),
}));

jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

// Use real ToolCard for the integration tests (already mocked UI deps above)
jest.unmock('@/components/ToolCard');

import { Tools } from '../AgentTools';
import { toolConfigService } from '../../services/toolConfigService';
import { toast } from 'sonner';

describe('AgentTools — Submit for review integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clicking Submit for review calls updateToolConfig with status PENDING_APPROVAL', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'draft-tool',
        state: 'maintenance',
        categories: [],
        config: { name: 'Draft Tool' },
        registryStatus: 'DRAFT',
      },
    ]);
    (toolConfigService.updateToolConfig as jest.Mock).mockResolvedValue({
      toolId: 'draft-tool',
      state: 'active',
      registryStatus: 'PENDING_APPROVAL',
    });

    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Draft Tool')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('submit-for-review'));

    await waitFor(() =>
      expect(toolConfigService.updateToolConfig).toHaveBeenCalledWith({
        toolId: 'draft-tool',
        status: 'PENDING_APPROVAL',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Submitted for review'));
  });

  it('after submit, optimistically shows "Awaiting approval" from the mutation result', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'draft-tool',
        state: 'maintenance',
        categories: [],
        config: { name: 'Draft Tool' },
        registryStatus: 'DRAFT',
      },
    ]);
    (toolConfigService.updateToolConfig as jest.Mock).mockResolvedValue({
      toolId: 'draft-tool',
      state: 'active',
      registryStatus: 'PENDING_APPROVAL',
    });

    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Draft Tool')).toBeInTheDocument());
    // Initially DRAFT: shows Submit button
    expect(screen.getByTestId('submit-for-review')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('submit-for-review'));

    // After submit resolves, the card updates to PENDING_APPROVAL → "Awaiting approval"
    await waitFor(() => expect(screen.getByText('Awaiting approval')).toBeInTheDocument());
    expect(screen.getByTestId('approvals-link')).toHaveAttribute('href', '/approvals');
  });

  it('API error on submit shows error toast', async () => {
    (toolConfigService.listToolConfigs as jest.Mock).mockResolvedValue([
      {
        toolId: 'draft-tool',
        state: 'maintenance',
        categories: [],
        config: { name: 'Draft Tool' },
        registryStatus: 'DRAFT',
      },
    ]);
    (toolConfigService.updateToolConfig as jest.Mock).mockRejectedValue(
      new Error('Invalid status transition: DRAFT → APPROVED'),
    );

    render(<Tools />);
    await waitFor(() => expect(screen.getByText('Draft Tool')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('submit-for-review'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Invalid status transition: DRAFT → APPROVED'),
    );
  });
});
