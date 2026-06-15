/**
 * GovernanceMismatches tests.
 *
 * Mocks the governance service, OrganizationContext, react-router-dom, and
 * shadcn/lucide primitives so we can assert page composition (filter bar,
 * summary cards, heatmap grid, empty state, admin gate, error retry, and
 * re-fetch on filter change).
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
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

// Render shadcn Select primitives as a native <select> so jest can fire
// onValueChange via fireEvent.change(...) in the granularity / range tests.
jest.mock('../../components/ui/select', () => {
  const React = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) => {
      // Pull the SelectItem options out of the children tree so the native
      // <select> mock can render a real list of <option>s.
      const options: Array<{ value: string; label: any }> = [];
      const collect = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const c of node) collect(c);
          return;
        }
        if (node?.props?.value !== undefined && node.type?._optionMarker === true) {
          options.push({ value: node.props.value, label: node.props.children });
        }
        if (node?.props?.children) collect(node.props.children);
      };
      collect(children);
      return React.createElement(
        'select',
        {
          value,
          onChange: (e: any) => onValueChange(e.target.value),
          'data-testid': 'select-mock',
          'data-current-value': value,
        },
        options.map((o: any) =>
          React.createElement('option', { key: o.value, value: o.value }, o.label),
        ),
      );
    },
    SelectTrigger: ({ children, id, className }: any) =>
      React.createElement('div', { id, className, 'data-testid': 'select-trigger' }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement('div', null, children),
    SelectItem: Object.assign(
      ({ children }: any) => React.createElement('span', null, children),
      { _optionMarker: true },
    ),
  };
});

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, htmlFor, className }: any) =>
    React.createElement('label', { htmlFor, className }, children),
}));

jest.mock('../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) => {
    // The component invokes asChild; we just render the child directly.
    if (Array.isArray(children)) return React.createElement(React.Fragment, null, ...children);
    return children;
  },
  TooltipContent: ({ children }: any) =>
    React.createElement('span', { 'data-testid': 'tooltip-content', role: 'tooltip' }, children),
}));

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getMismatchHeatmap: jest.fn(),
    getGovernanceMode: jest.fn(),
    listGovernanceFindings: jest.fn(),
    getGovernanceFinding: jest.fn(),
    getReconcilerStatus: jest.fn(),
    getRolloutReadiness: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceMismatches } from '../../pages/governance/Mismatches';

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
  const sinceTs = Math.floor(Date.now() / 1000) - 7 * 86400;
  const untilTs = Math.floor(Date.now() / 1000);
  return {
    generatedAt: Date.now() / 1000,
    sinceTs,
    untilTs,
    bucketSeconds: 3600,
    totalDenials: 5,
    totalEscalations: 2,
    modeWindows: [{ startTs: sinceTs, endTs: untilTs, mode: 'shadow' }],
    buckets: [
      {
        bucketStart: sinceTs - (sinceTs % 3600),
        count: 3,
        decision: 'deny',
        topReason: 'rule',
      },
      {
        bucketStart: untilTs - (untilTs % 3600),
        count: 2,
        decision: 'deny',
        topReason: 'auth',
      },
      {
        bucketStart: untilTs - (untilTs % 3600),
        count: 2,
        decision: 'escalate',
        topReason: 'rule',
      },
    ],
    ...overrides,
  };
}

describe('GovernanceMismatches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the admin-only empty state for non-admins and does NOT fetch', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    expect(screen.getByTestId('mismatch-admin-only')).toBeInTheDocument();
    expect(governanceService.getMismatchHeatmap).not.toHaveBeenCalled();
  });

  it('admin: fetches on mount with default args (sinceTs ~ now-7d, bucketSeconds 3600)', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(makeReport());

    const before = Math.floor(Date.now() / 1000);

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(governanceService.getMismatchHeatmap).toHaveBeenCalled();
    });

    const after = Math.floor(Date.now() / 1000);
    const args = (governanceService.getMismatchHeatmap as jest.Mock).mock.calls[0][0];
    expect(args.bucketSeconds).toBe(3600);
    expect(args.sinceTs).toBeGreaterThanOrEqual(before - 7 * 86400 - 5);
    expect(args.sinceTs).toBeLessThanOrEqual(after - 7 * 86400 + 5);
    expect(args.untilTs).toBeGreaterThanOrEqual(before);
    expect(args.untilTs).toBeLessThanOrEqual(after);
  });

  it('renders the peak summary card with the highest-count bucket', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(screen.getByTestId('mismatch-summary-peak')).toBeInTheDocument();
    });
    // The peak bucket aggregates deny (2) + escalate (2) at the latest hour
    // = 4 mismatches; the earlier bucket has 3.
    expect(screen.getByTestId('mismatch-summary-peak')).toHaveTextContent('4');
    expect(screen.getByTestId('mismatch-summary-peak-time')).toBeInTheDocument();
  });

  it('renders the empty-state when totalDenials + totalEscalations = 0', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(
      makeReport({ totalDenials: 0, totalEscalations: 0, buckets: [] }),
    );

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(screen.getByTestId('mismatch-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mismatch-empty-state')).toHaveTextContent(
      'No mismatches in the selected window',
    );
    expect(screen.queryByTestId('mismatch-heatmap-grid')).toBeNull();
  });

  it('granularity Select changes trigger a re-fetch with new bucketSeconds', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(governanceService.getMismatchHeatmap).toHaveBeenCalledTimes(1);
    });

    const selects = screen.getAllByTestId('select-mock');
    // selects[0] = range, selects[1] = granularity. Change granularity to 15min.
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: '900' } });
    });

    await waitFor(() => {
      expect(governanceService.getMismatchHeatmap).toHaveBeenCalledTimes(2);
    });
    const lastCall = (governanceService.getMismatchHeatmap as jest.Mock).mock.calls[1][0];
    expect(lastCall.bucketSeconds).toBe(900);
  });

  it('time-range Select changes trigger a re-fetch with new sinceTs', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(governanceService.getMismatchHeatmap).toHaveBeenCalledTimes(1);
    });
    const firstSinceTs = (governanceService.getMismatchHeatmap as jest.Mock).mock.calls[0][0]
      .sinceTs;

    const selects = screen.getAllByTestId('select-mock');
    // selects[0] = range. Change to 24h.
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: '24h' } });
    });

    await waitFor(() => {
      expect(governanceService.getMismatchHeatmap).toHaveBeenCalledTimes(2);
    });
    const secondSinceTs = (governanceService.getMismatchHeatmap as jest.Mock).mock.calls[1][0]
      .sinceTs;
    // The 24h since should be much later than the 7d since.
    expect(secondSinceTs).toBeGreaterThan(firstSinceTs);
  });

  it('renders an error card with retry when the service throws', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockRejectedValue(
      new Error('Forbidden: admin required'),
    );

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(screen.getByTestId('mismatch-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mismatch-retry')).toBeInTheDocument();
  });

  it('30d + hourly auto-falls-back to daily with an inline note', async () => {
    setOrg(true);
    (governanceService.getMismatchHeatmap as jest.Mock).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceMismatches));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('select-mock')).toHaveLength(2);
    });

    const selects = screen.getAllByTestId('select-mock');
    // Change time range to 30d.
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: '30d' } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('mismatch-daily-fallback-note')).toBeInTheDocument();
    });
  });
});
