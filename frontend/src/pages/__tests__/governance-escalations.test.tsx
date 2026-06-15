/**
 * GovernanceEscalations tests.
 *
 * Mocks the governance service, OrganizationContext, react-router-dom,
 * recharts, and shadcn primitives so we can assert page composition
 * (filter bar, summary cards, accordion vs flat table, empty state,
 * admin gate, time-range re-fetch).
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('recharts', () => {
  const React = require('react');
  return {
    ResponsiveContainer: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'responsive-container' }, children),
    AreaChart: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'area-chart' }, children),
    Area: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

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

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, variant, ...rest }: any) =>
    React.createElement(
      'span',
      { 'data-variant': variant, 'data-testid': 'badge', ...rest },
      children,
    ),
}));

// Render shadcn Select primitives as native <select>/<option> so jest can
// fire onValueChange via fireEvent.change(...).
jest.mock('../../components/ui/select', () => {
  const React = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) => {
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

// Render Accordion primitives transparently — the test just needs the
// rendered group headers and bodies side-by-side so it can count groups.
jest.mock('../../components/ui/accordion', () => {
  const React = require('react');
  return {
    Accordion: ({ children, ...rest }: any) =>
      React.createElement('div', { 'data-testid': 'accordion', ...rest }, children),
    AccordionItem: ({ children, value, ...rest }: any) =>
      React.createElement(
        'div',
        { 'data-testid': 'accordion-item', 'data-value': value, ...rest },
        children,
      ),
    AccordionTrigger: ({ children }: any) =>
      React.createElement('button', { 'data-testid': 'accordion-trigger' }, children),
    AccordionContent: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'accordion-content' }, children),
  };
});

jest.mock('../../components/ui/table', () => {
  const React = require('react');
  return {
    Table: ({ children }: any) =>
      React.createElement('table', { 'data-testid': 'table' }, children),
    TableHeader: ({ children }: any) => React.createElement('thead', null, children),
    TableBody: ({ children }: any) => React.createElement('tbody', null, children),
    TableRow: ({ children, ...rest }: any) =>
      React.createElement('tr', { ...rest }, children),
    TableHead: ({ children, ...rest }: any) =>
      React.createElement('th', { ...rest }, children),
    TableCell: ({ children, ...rest }: any) =>
      React.createElement('td', { ...rest }, children),
  };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listGovernanceFindings: jest.fn(),
    getEscalationMetricSeries: jest.fn(),
    getMismatchHeatmap: jest.fn(),
    getGovernanceMode: jest.fn(),
    getGovernanceFinding: jest.fn(),
    getReconcilerStatus: jest.fn(),
    getRolloutReadiness: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceEscalations } from '../../pages/governance/Escalations';

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

function makeFinding(over: Partial<any> = {}) {
  return {
    findingId: over.findingId ?? `f-${Math.random().toString(36).slice(2, 8)}`,
    workflowId: over.workflowId ?? 'wf-1',
    decision: 'escalate',
    reason: over.reason ?? 'rule:winner=A',
    requestingAgent: over.requestingAgent ?? 'agent-a',
    targetAgent: 'agent-b',
    scopeEvaluated: null,
    contractEvaluated: null,
    escalationTarget:
      over.escalationTarget ?? 'arn:aws:sns:us-east-1:123:gov-escalations',
    residualAuthorityDenial: false,
    timestamp: over.timestamp ?? Math.floor(Date.now() / 1000) - 3600,
  };
}

function makeFindingsConn(items: any[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

function makeMetricSeries(over: Partial<any> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    namespace: 'CitadelGovernance',
    metric: 'OffFrontierEscalations',
    statistic: 'Sum',
    periodSeconds: 3600,
    sinceTs: nowSec - 7 * 86_400,
    untilTs: nowSec,
    datapoints: [
      { timestamp: nowSec - 3600, value: 2 },
      { timestamp: nowSec - 1800, value: 1 },
    ],
    total: 3,
    ...over,
  };
}

describe('GovernanceEscalations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('non-admin: renders the admin-only empty state and does NOT fetch', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    expect(screen.getByTestId('escalation-admin-only')).toBeInTheDocument();
    expect(governanceService.listGovernanceFindings).not.toHaveBeenCalled();
    expect(governanceService.getEscalationMetricSeries).not.toHaveBeenCalled();
  });

  it('admin: fetches both listGovernanceFindings and getEscalationMetricSeries on mount with defaults', async () => {
    setOrg(true);
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn([makeFinding()]),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries(),
    );

    const before = Math.floor(Date.now() / 1000);

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
      expect(governanceService.getEscalationMetricSeries).toHaveBeenCalled();
    });

    const after = Math.floor(Date.now() / 1000);

    const findArgs = (governanceService.listGovernanceFindings as jest.Mock).mock
      .calls[0][0];
    expect(findArgs.decision).toBe('escalate');
    expect(findArgs.limit).toBe(200);
    // Default range is 7d.
    expect(findArgs.sinceTs).toBeGreaterThanOrEqual(before - 7 * 86_400 - 5);
    expect(findArgs.sinceTs).toBeLessThanOrEqual(after - 7 * 86_400 + 5);

    const metricArgs = (governanceService.getEscalationMetricSeries as jest.Mock)
      .mock.calls[0][0];
    expect(metricArgs.periodSeconds).toBe(3600);
    expect(metricArgs.sinceTs).toBeGreaterThanOrEqual(before - 7 * 86_400 - 5);
    expect(metricArgs.untilTs).toBeGreaterThanOrEqual(before);
    expect(metricArgs.untilTs).toBeLessThanOrEqual(after);
  });

  it('renders 4 summary cards with correct counts', async () => {
    setOrg(true);
    const findings = [
      makeFinding({ workflowId: 'wf-A', requestingAgent: 'agent-1' }),
      makeFinding({ workflowId: 'wf-A', requestingAgent: 'agent-2' }),
      makeFinding({ workflowId: 'wf-B', requestingAgent: 'agent-1' }),
    ];
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn(findings),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries({ total: 5 }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(screen.getByTestId('escalation-summary-cards')).toBeInTheDocument();
    });

    expect(screen.getByTestId('escalation-summary-total')).toHaveTextContent('3');
    expect(screen.getByTestId('escalation-summary-workflows')).toHaveTextContent(
      '2',
    );
    expect(screen.getByTestId('escalation-summary-agents')).toHaveTextContent('2');
    expect(screen.getByTestId('escalation-summary-alarms')).toHaveTextContent('5');
  });

  it('Group By = Workflow renders accordion groups with count badges', async () => {
    setOrg(true);
    const findings = [
      makeFinding({ workflowId: 'wf-A' }),
      makeFinding({ workflowId: 'wf-A' }),
      makeFinding({ workflowId: 'wf-B' }),
    ];
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn(findings),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries(),
    );

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(screen.getByTestId('escalation-grouped-list')).toBeInTheDocument();
    });

    const groups = screen.getAllByTestId('escalation-group');
    expect(groups).toHaveLength(2); // wf-A + wf-B

    // Count badges total all findings (2 + 1).
    const countBadges = screen.getAllByTestId('escalation-group-count');
    const counts = countBadges.map((b) => Number(b.textContent));
    expect(counts.sort()).toEqual([1, 2]);
  });

  it('Group By = None renders a flat chronological table', async () => {
    setOrg(true);
    const findings = [
      makeFinding({ workflowId: 'wf-A', timestamp: 100 }),
      makeFinding({ workflowId: 'wf-B', timestamp: 200 }),
    ];
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn(findings),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries(),
    );

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    // selects[0] = range, selects[1] = group-by. Switch group-by to none.
    const selects = screen.getAllByTestId('select-mock');
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: 'none' } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('escalation-flat-table')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('escalation-grouped-list')).toBeNull();
  });

  it('renders the empty-state card when both fetches return no data', async () => {
    setOrg(true);
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn([]),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries({ datapoints: [], total: 0 }),
    );

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(screen.getByTestId('escalation-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByTestId('escalation-empty-state')).toHaveTextContent(
      'No escalations in the selected window',
    );
    expect(screen.queryByTestId('escalation-grouped-list')).toBeNull();
    expect(screen.queryByTestId('escalation-flat-table')).toBeNull();
  });

  it('time-range Select changes trigger a re-fetch with new sinceTs', async () => {
    setOrg(true);
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue(
      makeFindingsConn([makeFinding()]),
    );
    (governanceService.getEscalationMetricSeries as jest.Mock).mockResolvedValue(
      makeMetricSeries(),
    );

    await act(async () => {
      render(React.createElement(GovernanceEscalations));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalledTimes(1);
    });

    const firstSinceTs = (governanceService.listGovernanceFindings as jest.Mock)
      .mock.calls[0][0].sinceTs;

    // selects[0] = range, change to 24h.
    const selects = screen.getAllByTestId('select-mock');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: '24h' } });
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalledTimes(2);
    });
    const secondSinceTs = (governanceService.listGovernanceFindings as jest.Mock)
      .mock.calls[1][0].sinceTs;
    // 24h since is much later than 7d since.
    expect(secondSinceTs).toBeGreaterThan(firstSinceTs);
  });
});
