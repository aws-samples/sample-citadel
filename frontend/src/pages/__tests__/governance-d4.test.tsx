/**
 * GovernanceD4Retrospective tests.
 *
 * Mocks visx primitives, the governance service, OrganizationContext, and
 * the shadcn select/skeleton/button/label primitives so the test
 * environment renders inert SVG and predictable DOM. Mirrors the
 * jest.mock pattern used by governance-mismatches.test.tsx.
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement(
      'div',
      { className, 'data-testid': 'page-container' },
      children,
    ),
}));

jest.mock('../../components/ui/skeleton', () => ({
  Skeleton: ({ className, ...rest }: any) =>
    React.createElement('div', {
      'data-testid': 'skeleton',
      className,
      ...rest,
    }),
}));

jest.mock('../../components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../../components/ui/select', () => {
  const ReactLib = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) => {
      const options: Array<{ value: string; label: any }> = [];
      const collect = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const c of node) collect(c);
          return;
        }
        if (
          node?.props?.value !== undefined &&
          node.type?._optionMarker === true
        ) {
          options.push({ value: node.props.value, label: node.props.children });
        }
        if (node?.props?.children) collect(node.props.children);
      };
      collect(children);
      return ReactLib.createElement(
        'select',
        {
          value,
          onChange: (e: any) => onValueChange(e.target.value),
          'data-testid': 'select-mock',
          'data-current-value': value,
        },
        options.map((o: any) =>
          ReactLib.createElement(
            'option',
            { key: o.value, value: o.value },
            o.label,
          ),
        ),
      );
    },
    SelectTrigger: ({ children, id, className, ...rest }: any) =>
      ReactLib.createElement(
        'div',
        { id, className, 'data-testid': 'select-trigger', ...rest },
        children,
      ),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      ReactLib.createElement('div', null, children),
    SelectItem: Object.assign(
      ({ children }: any) => ReactLib.createElement('span', null, children),
      { _optionMarker: true },
    ),
  };
});

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, htmlFor, className }: any) =>
    React.createElement('label', { htmlFor, className }, children),
}));

// Mock visx primitives as inert SVG. The page only uses Group +
// ParentSize + Circle, so we provide minimal renderers that surface the
// supplied props as data attributes for assertions.
jest.mock('@visx/group', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    Group: ({ children, top, left }: any) =>
      ReactLib.createElement(
        'g',
        {
          'data-testid': 'visx-group',
          'data-top': String(top ?? ''),
          'data-left': String(left ?? ''),
        },
        children,
      ),
  };
});

jest.mock('@visx/responsive', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    ParentSize: ({ children }: any) =>
      ReactLib.createElement(
        'div',
        { 'data-testid': 'visx-parent-size' },
        children({ width: 800, height: 400 }),
      ),
  };
});

jest.mock('@visx/shape', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    Circle: ({ cx, cy, r, ...rest }: any) =>
      ReactLib.createElement('circle', {
        cx,
        cy,
        r,
        ...rest,
      }),
  };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getD4RetrospectiveReport: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceD4Retrospective } from '../../pages/governance/D4Retrospective';

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

interface ReportOverrides {
  recommendation?: string;
  insufficientEvidence?: boolean;
  truncated?: boolean;
  preFilterTotal?: number;
  toolHandlerTotal?: number;
  distinctPreFilter?: number;
  distinctToolHandler?: number;
  overlap?: number;
  overlapRatio?: number;
  windowDays?: number;
  generatedAt?: number;
}

function makeReport(overrides: ReportOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    generatedAt: overrides.generatedAt ?? nowSec,
    windowStart: nowSec - 30 * 86400,
    windowEnd: nowSec,
    windowDays: overrides.windowDays ?? 30,
    insufficientEvidence: overrides.insufficientEvidence ?? false,
    counts: {
      preFilterTotal: overrides.preFilterTotal ?? 12,
      toolHandlerTotal: overrides.toolHandlerTotal ?? 8,
      distinctPreFilter: overrides.distinctPreFilter ?? 10,
      distinctToolHandler: overrides.distinctToolHandler ?? 6,
      overlap: overrides.overlap ?? 5,
    },
    overlapRatio: overrides.overlapRatio ?? 0.5,
    recommendation: overrides.recommendation ?? 'keep-both',
    truncated: overrides.truncated ?? false,
  };
}

describe('GovernanceD4Retrospective', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the admin-only empty state for non-admins and does NOT fetch', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    expect(screen.getByTestId('d4-admin-only')).toBeInTheDocument();
    expect(governanceService.getD4RetrospectiveReport).not.toHaveBeenCalled();
  });

  it('admin: fetches getD4RetrospectiveReport on mount with windowDays=30 default', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(
        governanceService.getD4RetrospectiveReport,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      (governanceService.getD4RetrospectiveReport as jest.Mock).mock.calls[0][0],
    ).toBe(30);
  });

  it('changing the Window Select triggers a re-fetch with the new windowDays', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(
        governanceService.getD4RetrospectiveReport,
      ).toHaveBeenCalledTimes(1);
    });

    const selects = screen.getAllByTestId('select-mock');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: '7' } });
    });

    await waitFor(() => {
      expect(
        governanceService.getD4RetrospectiveReport,
      ).toHaveBeenCalledTimes(2);
    });
    const lastArg = (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mock.calls[1][0];
    expect(lastArg).toBe(7);
  });

  it('renders 4 summary cards with correct counts and percentage', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(
      makeReport({
        preFilterTotal: 100,
        toolHandlerTotal: 25,
        distinctPreFilter: 50,
        distinctToolHandler: 20,
        overlap: 10,
        overlapRatio: 0.2,
        recommendation: 'keep-both',
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-summary-cards')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-summary-pre-filter-total')).toHaveTextContent(
      '100',
    );
    expect(
      screen.getByTestId('d4-summary-tool-handler-total'),
    ).toHaveTextContent('25');
    expect(screen.getByTestId('d4-summary-overlap-count')).toHaveTextContent(
      '10',
    );
    // overlap ratio formatted to one decimal place.
    expect(screen.getByTestId('d4-summary-overlap-ratio')).toHaveTextContent(
      '20.0%',
    );
  });

  it.each([
    ['keep-both', 'Keep both layers (overlap moderate)'],
    [
      'keep-both-strong-evidence',
      'Keep both layers (strong evidence; overlap < 20%)',
    ],
    ['re-debate', 'Re-debate (overlap > 90%; layers may be redundant)'],
    ['deferred-90d', 'Insufficient evidence — retrospective deferred 90 days'],
  ])(
    'recommendation %s renders the correct badge label',
    async (recommendation, expectedLabel) => {
      setOrg(true);
      (
        governanceService.getD4RetrospectiveReport as jest.Mock
      ).mockResolvedValue(
        makeReport({
          recommendation,
          insufficientEvidence: recommendation === 'deferred-90d',
          toolHandlerTotal: recommendation === 'deferred-90d' ? 0 : 5,
        }),
      );

      await act(async () => {
        render(React.createElement(GovernanceD4Retrospective));
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('d4-recommendation-card'),
        ).toBeInTheDocument();
      });
      expect(screen.getByTestId('d4-recommendation-badge')).toHaveTextContent(
        recommendation,
      );
      expect(screen.getByTestId('d4-recommendation-label')).toHaveTextContent(
        expectedLabel,
      );
      expect(
        screen.getByTestId('d4-recommendation-card').getAttribute(
          'data-recommendation',
        ),
      ).toBe(recommendation);
    },
  );

  it('Venn diagram renders 2 circles when insufficientEvidence=false', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport({ insufficientEvidence: false }));

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-venn-svg')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-venn-circle-a')).toBeInTheDocument();
    expect(screen.getByTestId('d4-venn-circle-b')).toBeInTheDocument();
    expect(
      screen.queryByTestId('d4-venn-insufficient-circle'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('d4-venn-overlap-label')).toHaveTextContent(
      String(makeReport().counts.overlap),
    );
  });

  it('Venn renders a single grey circle when insufficientEvidence=true', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(
      makeReport({
        insufficientEvidence: true,
        recommendation: 'deferred-90d',
        toolHandlerTotal: 0,
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-venn-insufficient')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('d4-venn-insufficient-circle'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('d4-venn-circle-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('d4-venn-circle-b')).not.toBeInTheDocument();
  });

  it('truncation banner is visible when truncated=true', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport({ truncated: true }));

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-truncation-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-truncation-banner')).toHaveTextContent(
      '5000',
    );
  });

  it('hides the truncation banner when truncated=false', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport({ truncated: false }));

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-summary-cards')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('d4-truncation-banner')).not.toBeInTheDocument();
  });

  it('empty state renders when both sets empty and not insufficient', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(
      makeReport({
        // Force `totalFindings === 0 && !insufficientEvidence`. To keep
        // insufficientEvidence false the toolHandlerTotal must stay >= 1
        // per the resolver semantics — but we test the page-level branch
        // by directly constructing that state.
        preFilterTotal: 0,
        toolHandlerTotal: 0,
        distinctPreFilter: 0,
        distinctToolHandler: 0,
        overlap: 0,
        overlapRatio: 0,
        insufficientEvidence: false,
        recommendation: 'keep-both-strong-evidence',
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-empty-state')).toHaveTextContent(
      'No denials at either scope',
    );
    expect(screen.queryByTestId('d4-venn-svg')).not.toBeInTheDocument();
  });

  it('renders an error card with retry when the service throws', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockRejectedValue(new Error('Forbidden: admin required'));

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-retry')).toBeInTheDocument();
    expect(screen.getByTestId('d4-error')).toHaveTextContent(
      'Forbidden: admin required',
    );
  });

  it('refresh button forces a re-fetch (cache will return same value within 5min)', async () => {
    setOrg(true);
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport());

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(
        governanceService.getD4RetrospectiveReport,
      ).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('d4-refresh-button'));
    });

    await waitFor(() => {
      expect(
        governanceService.getD4RetrospectiveReport,
      ).toHaveBeenCalledTimes(2);
    });
  });

  it('renders the last-refreshed footer when a report is loaded', async () => {
    setOrg(true);
    const generatedAt = Math.floor(Date.now() / 1000) - 60;
    (
      governanceService.getD4RetrospectiveReport as jest.Mock
    ).mockResolvedValue(makeReport({ generatedAt }));

    await act(async () => {
      render(React.createElement(GovernanceD4Retrospective));
    });

    await waitFor(() => {
      expect(screen.getByTestId('d4-last-refreshed')).toBeInTheDocument();
    });
    expect(screen.getByTestId('d4-last-refreshed')).toHaveTextContent(
      'Computed',
    );
  });
});
