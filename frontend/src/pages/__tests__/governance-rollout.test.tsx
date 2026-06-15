/**
 * GovernanceRollout tests.
 *
 * Mocks the governance service, OrganizationContext, react-router-dom, and
 * lucide-react/tooltip primitives so we can assert page composition,
 * admin gating, the disabled flip controls + tooltip, and the
 * strict-mode info card.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
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
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

// Mock ModeFlipDialog so we can assert it opens with the right target mode
// without dragging shadcn / sonner / Radix portal internals into this suite.
jest.mock('../../components/ModeFlipDialog', () => ({
  ModeFlipDialog: ({ open, targetMode, onConfirmed, currentMode }: any) =>
    open
      ? React.createElement(
          'div',
          {
            'data-testid': 'mode-flip-dialog-mock',
            'data-target-mode': targetMode,
            'data-current-mode': currentMode,
          },
          React.createElement(
            'button',
            {
              'data-testid': 'mock-confirm-success',
              onClick: () =>
                onConfirmed({
                  ok: true,
                  previousMode: currentMode,
                  newMode: targetMode,
                  effectiveAt: '2026-05-19T00:00:00Z',
                  noop: false,
                  emittedEventDetailType: 'governance.mode.transition',
                }),
            },
            'Confirm flip (mock)',
          ),
        )
      : null,
}));

// Mock MarkVerifiedDialog so we can assert it opens with the right
// checkId/checkLabel and exercise the onVerified callback without
// pulling in shadcn Select internals.
jest.mock('../../components/MarkVerifiedDialog', () => ({
  MarkVerifiedDialog: ({
    open,
    checkId,
    checkLabel,
    onVerified,
  }: any) =>
    open
      ? React.createElement(
          'div',
          {
            'data-testid': 'mark-verified-dialog-mock',
            'data-check-id': checkId,
            'data-check-label': checkLabel,
          },
          React.createElement(
            'button',
            {
              'data-testid': 'mock-mark-verified-confirm',
              onClick: () =>
                onVerified({
                  ok: true,
                  checkId,
                  verifiedAt: '2026-05-19T08:00:00Z',
                  expiresAt: '2026-05-26T08:00:00Z',
                  verifiedBy: 'sub-1',
                }),
            },
            'Confirm mark verified (mock)',
          ),
        )
      : null,
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('lucide-react', () => ({
  CheckCircle2: () => React.createElement('span', { 'data-testid': 'icon-check' }),
  XCircle: () => React.createElement('span', { 'data-testid': 'icon-x' }),
  AlertTriangle: () => React.createElement('span', { 'data-testid': 'icon-warn' }),
  HelpCircle: () => React.createElement('span', { 'data-testid': 'icon-help' }),
  Clock: () => React.createElement('span', { 'data-testid': 'icon-clock' }),
  ChevronRight: () => React.createElement('span', { 'data-testid': 'icon-chevron-right' }),
  MoreHorizontal: () => React.createElement('span', { 'data-testid': 'icon-more-horizontal' }),
}));

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getRolloutReadiness: jest.fn(),
    getGovernanceMode: jest.fn(),
    listGovernanceFindings: jest.fn(),
    getGovernanceFinding: jest.fn(),
    getReconcilerStatus: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceRollout } from '../../pages/governance/Rollout';

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

function makeReport(overrides: Partial<any> = {}) {
  // After commits 35/36, tel-1, tel-2, and rb-2 are automated PASS checks
  // (no longer manual stubs). The only remaining manual checks — i.e. the
  // ones in the production MANUAL_VERIFICATION_ALLOWLIST — are own-1,
  // own-2, own-3. Default counts: 8 PASS, 3 STUB, 0 FAIL, 0 WARN.
  const STUB_DETAIL = 'Manual operator check — wired in Wave 2.B.2';
  const baseChecks = [
    { id: 'data-1', label: 'Every active AuthorityUnit has a non-null registryId', status: 'PASS', detail: 'All 5 authority units have registryId', evidence: null, category: 'data-integrity' },
    { id: 'data-2', label: 'Every registryId points to a live registry record', status: 'PASS', detail: 'Sampled 5 units, all live and non-deprecated', evidence: null, category: 'data-integrity' },
    { id: 'data-3', label: 'Every governance-aware agent and tool has a workload-identity attribute', status: 'PASS', detail: 'All 2 agents and 1 tools have workload-identity attribute', evidence: null, category: 'data-integrity' },
    { id: 'tel-1', label: 'governance-gate-decisions dashboard shows ≥7 days of shadow traffic', status: 'PASS', detail: 'Shadow traffic spans 8 days', evidence: null, category: 'telemetry' },
    { id: 'tel-2', label: 'workload-identity-mismatch-rate < 0.5% over 24h', status: 'PASS', detail: 'Mismatch rate 0.10% over 24h (10 mismatches in 10000 total findings)', evidence: null, category: 'telemetry' },
    { id: 'tel-3', label: 'registry-sync-failures DLQ empty for ≥48h', status: 'PASS', detail: 'Zero sync failures in last 48h', evidence: null, category: 'telemetry' },
    { id: 'rb-1', label: 'GOVERNANCE_MODE controllable via CFN parameter', status: 'PASS', detail: 'Mode parameter present, value: permissive', evidence: null, category: 'rollback' },
    { id: 'rb-2', label: 'permissive fallback exercised in non-prod within 7 days', status: 'PASS', detail: 'Permissive fallback exercised on 2026-05-14T10:30:00Z', evidence: null, category: 'rollback' },
    { id: 'own-1', label: 'On-call runbook entry updated and PagerDuty escalation verified', status: 'STUB', detail: STUB_DETAIL, evidence: null, category: 'ownership' },
    { id: 'own-2', label: 'Flip announced to stakeholders ≥48h in advance', status: 'STUB', detail: STUB_DETAIL, evidence: null, category: 'ownership' },
    { id: 'own-3', label: 'Change ticket lists rollback criteria', status: 'STUB', detail: STUB_DETAIL, evidence: null, category: 'ownership' },
  ];
  return {
    generatedAt: 1715000000000,
    currentMode: 'permissive',
    effectiveAt: null,
    env: 'dev',
    shadowSoakStartedAt: null,
    checks: baseChecks,
    passCount: 8,
    failCount: 0,
    warnCount: 0,
    stubCount: 3,
    ...overrides,
  };
}

describe('GovernanceRollout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an empty state for non-admins and does not fetch readiness', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    expect(screen.getByTestId('rollout-admin-only')).toBeInTheDocument();
    expect(governanceService.getRolloutReadiness).not.toHaveBeenCalled();
  });

  it('fetches readiness on mount when admin', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(governanceService.getRolloutReadiness).toHaveBeenCalledTimes(1);
    });
  });

  it('renders all 11 checks grouped by the four categories', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-checklist')).toBeInTheDocument();
    });

    // 11 check rows
    for (const id of [
      'data-1', 'data-2', 'data-3',
      'tel-1', 'tel-2', 'tel-3',
      'rb-1', 'rb-2',
      'own-1', 'own-2', 'own-3',
    ]) {
      expect(screen.getByTestId(`rollout-check-${id}`)).toBeInTheDocument();
    }

    // Four categories
    expect(screen.getByTestId('rollout-category-data-integrity')).toBeInTheDocument();
    expect(screen.getByTestId('rollout-category-telemetry')).toBeInTheDocument();
    expect(screen.getByTestId('rollout-category-rollback')).toBeInTheDocument();
    expect(screen.getByTestId('rollout-category-ownership')).toBeInTheDocument();

    // Counts: 8 PASS (data-1 + data-2 + data-3 + tel-1 + tel-2 + tel-3 + rb-1 + rb-2),
    // 3 STUB (own-1 + own-2 + own-3), 0 FAIL, 0 WARN.
    expect(screen.getByTestId('rollout-count-pass')).toHaveTextContent('8 PASS');
    expect(screen.getByTestId('rollout-count-fail')).toHaveTextContent('0 FAIL');
    expect(screen.getByTestId('rollout-count-warn')).toHaveTextContent('0 WARN');
    expect(screen.getByTestId('rollout-count-stub')).toHaveTextContent('3 STUB');
  });

  it('STUB checks render with the manual-operator-check detail text', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-checklist')).toBeInTheDocument();
    });

    // Each remaining manual-check ID surfaces the operator-instruction text.
    const stubIds = ['own-1', 'own-2', 'own-3'];
    for (const id of stubIds) {
      const row = screen.getByTestId(`rollout-check-${id}`);
      expect(row).toHaveTextContent('Manual operator check — wired in Wave 2.B.2');
    }
  });

  it('shows correct totals in the counts bar', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport({ passCount: 3, failCount: 2, warnCount: 1, stubCount: 5 }),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-counts-bar')).toBeInTheDocument();
    });

    expect(screen.getByTestId('rollout-count-pass')).toHaveTextContent('3 PASS');
    expect(screen.getByTestId('rollout-count-fail')).toHaveTextContent('2 FAIL');
    expect(screen.getByTestId('rollout-count-warn')).toHaveTextContent('1 WARN');
    expect(screen.getByTestId('rollout-count-stub')).toHaveTextContent('5 STUB');
  });

  it('renders an active flip-to-shadow button (no longer disabled) when mode = permissive and opens ModeFlipDialog on click', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport({ currentMode: 'permissive' }),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-flip-shadow')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('rollout-flip-shadow') as HTMLButtonElement;
    expect(btn).not.toBeDisabled();

    // Clicking opens the dialog with target = shadow.
    await act(async () => {
      btn.click();
    });
    const dialog = await screen.findByTestId('mode-flip-dialog-mock');
    expect(dialog).toHaveAttribute('data-target-mode', 'shadow');
    expect(dialog).toHaveAttribute('data-current-mode', 'permissive');
    // Strict-only info card must NOT render in permissive mode.
    expect(screen.queryByTestId('rollout-strict-info')).toBeNull();
  });

  it('successful flip refetches readiness', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport({ currentMode: 'permissive' }),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-flip-shadow')).toBeInTheDocument();
    });
    const initialFetchCount = (
      governanceService.getRolloutReadiness as jest.Mock
    ).mock.calls.length;

    await act(async () => {
      screen.getByTestId('rollout-flip-shadow').click();
    });
    await act(async () => {
      screen.getByTestId('mock-confirm-success').click();
    });

    await waitFor(() => {
      expect(
        (governanceService.getRolloutReadiness as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(initialFetchCount);
    });
  });

  it('renders an active flip-to-strict button when mode = shadow (and a rollback button)', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport({
        currentMode: 'shadow',
        effectiveAt: '2026-05-18T10:00:00Z',
        shadowSoakStartedAt: '2026-05-18T10:00:00Z',
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-flip-strict')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('rollout-flip-strict') as HTMLButtonElement;
    expect(btn).not.toBeDisabled();
    expect(screen.queryByTestId('rollout-flip-shadow')).toBeNull();
    expect(
      screen.getByTestId('rollout-rollback-permissive'),
    ).toBeInTheDocument();
  });

  it('renders rollback button (and the strict-mode info card) when currentMode = strict', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport({
        currentMode: 'strict',
        effectiveAt: '2026-05-18T10:00:00Z',
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-strict-info')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rollout-strict-info')).toHaveTextContent(
      'Strict mode active. Rollback available.',
    );
    expect(
      screen.getByTestId('rollout-rollback-permissive'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('rollout-flip-shadow')).toBeNull();
    expect(screen.queryByTestId('rollout-flip-strict')).toBeNull();
  });

  it('renders an error card with retry when the service throws', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rollout-retry')).toBeInTheDocument();
  });

  it('manual STUB checks (own-1/own-2/own-3) render a Mark verified button for admins', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-checklist')).toBeInTheDocument();
    });

    for (const id of ['own-1', 'own-2', 'own-3']) {
      expect(
        screen.getByTestId(`rollout-check-${id}-mark-verified`),
      ).toBeInTheDocument();
    }
  });

  it('real-check PASS rows do NOT render a Mark verified button', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-checklist')).toBeInTheDocument();
    });

    for (const id of [
      'data-1', 'data-2', 'data-3',
      'tel-1', 'tel-2', 'tel-3',
      'rb-1', 'rb-2',
    ]) {
      expect(
        screen.queryByTestId(`rollout-check-${id}-mark-verified`),
      ).toBeNull();
      expect(
        screen.queryByTestId(`rollout-check-${id}-re-verify`),
      ).toBeNull();
    }
  });

  it('non-admins do NOT see the Mark verified button on manual stubs', async () => {
    setOrg(false);
    // Non-admins land on the admin-only empty state and never invoke the
    // service. The empty state rendering is asserted elsewhere; here we
    // assert that no Mark-verified buttons leak into that state.
    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    expect(screen.getByTestId('rollout-admin-only')).toBeInTheDocument();
    for (const id of ['own-1', 'own-2', 'own-3']) {
      expect(
        screen.queryByTestId(`rollout-check-${id}-mark-verified`),
      ).toBeNull();
    }
  });

  it('clicking Mark verified opens the dialog with the matching checkId', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rollout-check-own-1-mark-verified'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId('rollout-check-own-1-mark-verified').click();
    });

    const dialog = await screen.findByTestId('mark-verified-dialog-mock');
    expect(dialog).toHaveAttribute('data-check-id', 'own-1');
  });

  it('successful mark-verified re-fetches readiness', async () => {
    setOrg(true);
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      makeReport(),
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rollout-check-own-1-mark-verified'),
      ).toBeInTheDocument();
    });
    const initialFetchCount = (
      governanceService.getRolloutReadiness as jest.Mock
    ).mock.calls.length;

    await act(async () => {
      screen.getByTestId('rollout-check-own-1-mark-verified').click();
    });
    await act(async () => {
      screen.getByTestId('mock-mark-verified-confirm').click();
    });

    await waitFor(() => {
      expect(
        (governanceService.getRolloutReadiness as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(initialFetchCount);
    });
  });

  it('verified-PASS row (detail starts with "Verified by ") renders a Re-verify button + unverify-pending tooltip', async () => {
    setOrg(true);
    const verifiedReport = makeReport({
      checks: makeReport().checks.map((c: any) =>
        c.id === 'own-1'
          ? {
              ...c,
              status: 'PASS',
              detail:
                'Verified by alice@example.com at 2026-05-19T08:00:00Z, expires 2026-05-26T08:00:00Z',
            }
          : c,
      ),
      passCount: 9,
      stubCount: 2,
    });
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      verifiedReport,
    );

    await act(async () => {
      render(React.createElement(GovernanceRollout));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rollout-check-own-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rollout-check-own-1-re-verify')).toBeInTheDocument();
    expect(
      screen.getByTestId('rollout-check-own-1-unverify-pending'),
    ).toBeInTheDocument();
    // Mark verified button must NOT also be on this row — it's a Re-verify now.
    expect(
      screen.queryByTestId('rollout-check-own-1-mark-verified'),
    ).toBeNull();
  });
});
