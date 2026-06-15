/**
 * GovernanceOverview tests
 *
 * Mocks the governance service, the useGovernanceMode hook, the
 * OrganizationContext, react-router-dom, and recharts so we can assert the
 * page composition (mode card, ledger pulse, reconciler card, quick-link
 * buttons) and the admin gate behaviour.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'responsive-container' }, children),
  BarChart: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'bar-chart' }, children),
  Bar: ({ children }: any) => React.createElement('div', { 'data-testid': 'bar' }, children),
  PieChart: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'pie-chart' }, children),
  Pie: ({ children }: any) => React.createElement('div', { 'data-testid': 'pie' }, children),
  Cell: () => React.createElement('div', { 'data-testid': 'cell' }),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className, 'data-testid': 'page-container' }, children),
}));

jest.mock('../../components/ui/skeleton', () => ({
  Skeleton: ({ className, ...rest }: any) =>
    React.createElement('div', { 'data-testid': 'skeleton', className, ...rest }),
}));

jest.mock('../../components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement(
      'button',
      { onClick, disabled, ...rest },
      children
    ),
}));

const mockUseGovernanceMode = jest.fn();
jest.mock('../../hooks/useGovernanceMode', () => ({
  useGovernanceMode: () => mockUseGovernanceMode(),
}));

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listGovernanceFindings: jest.fn(),
    getReconcilerStatus: jest.fn(),
    getGovernanceMode: jest.fn(),
    getGovernanceFinding: jest.fn(),
    getMismatchHeatmap: jest.fn(),
    getRolloutReadiness: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceOverview } from '../../pages/governance/Overview';

function setMode(mode: any, opts: { loading?: boolean; error?: string | null } = {}) {
  mockUseGovernanceMode.mockReturnValue({
    mode,
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    refresh: jest.fn(),
  });
}

function setOrg(isAdmin: boolean) {
  mockUseOrganization.mockReturnValue({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: null,
    isAdmin,
    loading: false,
  });
}

describe('GovernanceOverview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    (governanceService.getReconcilerStatus as jest.Mock).mockResolvedValue({
      lastRunAt: '2026-05-18T10:00:00Z',
      lastRunMode: 'apply',
      classifications: { inSync: 5, missing: 1, stale: 0, orphan: 0 },
      totalRecords: 6,
    });
  });

  it('renders the mode card, ledger pulse, and quick links for non-admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: '2026-01-01T00:00:00Z', env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-mode-card')).toBeInTheDocument();
    expect(screen.getByTestId('mode-card-enforce')).toHaveTextContent('shadow');
    expect(screen.getByTestId('governance-ledger-pulse')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-ledger')).toBeInTheDocument();
  });

  it('hides the reconciler quick link for non-admins and shows the admin-only placeholder', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('reconciler-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('governance-link-reconciler')).toBeNull();
    expect(governanceService.getReconcilerStatus).not.toHaveBeenCalled();
  });

  it('shows the reconciler card and reconciler quick link for admins, fetching status', async () => {
    setMode({ enforce: 'strict', effectiveAt: '2026-02-01T00:00:00Z', env: 'prod' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    await waitFor(() => {
      expect(governanceService.getReconcilerStatus).toHaveBeenCalled();
    });
    expect(screen.getByTestId('governance-reconciler-card')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-reconciler')).toBeInTheDocument();
  });

  it('shows the mismatch-heatmap quick link for admins and hides it for non-admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });

    // Admin sees the link.
    setOrg(true);
    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });
    expect(screen.getByTestId('governance-link-mismatches')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-mismatches')).toHaveTextContent(
      'Mismatch heatmap',
    );
  });

  it('hides the mismatch-heatmap quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-mismatches')).toBeNull();
  });

  it('shows the escalations quick link for admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-escalations')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-escalations')).toHaveTextContent(
      'Escalations',
    );
  });

  it('shows the decision flow tracer quick link for admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-tracer')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-tracer')).toHaveTextContent(
      'Decision flow tracer',
    );
  });

  it('shows the authority graph quick link for admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-graph')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-graph')).toHaveTextContent(
      'Authority graph',
    );
  });

  it('shows the constitution quick link for admins', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-constitution')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-constitution')).toHaveTextContent(
      'Constitution',
    );
  });

  it('shows the case-law quick link for admins (9th admin link)', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-case-law')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-case-law')).toHaveTextContent(
      'Case law',
    );
  });

  it('shows the D4 retrospective quick link for admins (10th admin link)', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-d4')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-d4')).toHaveTextContent(
      'D4 retrospective',
    );
  });

  it('hides the D4 retrospective quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-d4')).toBeNull();
  });

  it('hides the case-law quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-case-law')).toBeNull();
  });

  it('hides the constitution quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-constitution')).toBeNull();
  });

  it('hides the authority graph quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-graph')).toBeNull();
  });

  it('hides the decision flow tracer quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-tracer')).toBeNull();
  });

  it('hides the escalations quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-escalations')).toBeNull();
  });

  it('shows the IAM trust path quick link for admins (11th admin link)', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.getByTestId('governance-link-iam')).toBeInTheDocument();
    expect(screen.getByTestId('governance-link-iam')).toHaveTextContent(
      'IAM trust path',
    );
  });

  it('hides the IAM trust path quick link for non-admins', async () => {
    setMode({ enforce: 'permissive', effectiveAt: null, env: 'dev' });
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    expect(screen.queryByTestId('governance-link-iam')).toBeNull();
  });

  it('calls listGovernanceFindings with sinceTs in the last 24h on mount', async () => {
    setMode({ enforce: 'shadow', effectiveAt: null, env: 'dev' });
    setOrg(false);

    const before = Math.floor(Date.now() / 1000);

    await act(async () => {
      render(React.createElement(GovernanceOverview));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    const after = Math.floor(Date.now() / 1000);
    const args = (governanceService.listGovernanceFindings as jest.Mock).mock.calls[0][0];
    expect(args).toMatchObject({ limit: 200 });
    expect(args.sinceTs).toBeGreaterThanOrEqual(before - 86_400 - 5);
    expect(args.sinceTs).toBeLessThanOrEqual(after - 86_400 + 5);
  });
});
