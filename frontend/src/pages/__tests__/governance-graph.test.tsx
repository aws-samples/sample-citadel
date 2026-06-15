/**
 * GovernanceGraph tests.
 *
 * Mocks @xyflow/react with a simple <ul> renderer (same pattern as the
 * tracer test) and `d3-force` with a synchronous identity layout so we
 * can assert positional behaviour without waiting on simulation ticks.
 * Mocks the governance service, OrganizationContext, react-router-dom,
 * and shadcn primitives so the assertion surface stays focused on the
 * page's composition logic.
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

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Replace @xyflow/react with a minimal renderer. Each node renders a
// `<li>` with data-testid `rf-node-<id>` and a `data-kind` attribute so
// we can assert kind-based composition. Edges expose their source/target
// + `data-edge-kind` for binding/delegation/composition assertions.
jest.mock('@xyflow/react', () => {
  const React = require('react');
  return {
    __esModule: true,
    ReactFlow: ({
      nodes,
      edges,
      onNodeClick,
    }: {
      nodes: any[];
      edges: any[];
      onNodeClick?: (evt: any, node: any) => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'reactflow-mock' },
        React.createElement(
          'ul',
          { 'data-testid': 'rf-nodes' },
          nodes.map((n: any) =>
            React.createElement(
              'li',
              {
                key: n.id,
                'data-testid': `rf-node-${n.id}`,
                'data-kind': n.data?.kind,
                'data-x': String(n.position?.x ?? ''),
                'data-y': String(n.position?.y ?? ''),
                onClick: (e: any) => onNodeClick && onNodeClick(e, n),
              },
              n.id,
            ),
          ),
        ),
        React.createElement(
          'ul',
          { 'data-testid': 'rf-edges' },
          edges.map((e: any) =>
            React.createElement(
              'li',
              {
                key: e.id,
                'data-testid': `rf-edge-${e.id}`,
                'data-edge-kind': e.data?.edgeKind,
                'data-source': e.source,
                'data-target': e.target,
                'data-stroke': e.style?.stroke ?? '',
              },
              `${e.source}->${e.target}`,
            ),
          ),
        ),
      ),
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
  };
});

// Replace d3-force with a synchronous no-op simulation. The page calls
// .force(...).force(...).stop() then iterates .tick(); we just need
// numeric x/y on each node for the page's positionedNodes mapping. We
// assign deterministic positions so the test can assert "positions are
// numbers" without depending on the actual simulation output.
jest.mock('d3-force', () => {
  const makeSim = (nodes: any[]) => {
    const sim: any = {};
    nodes.forEach((n, i) => {
      n.x = 100 + i * 10;
      n.y = 200 + i * 10;
    });
    sim.force = () => sim;
    sim.stop = () => sim;
    sim.tick = () => sim;
    return sim;
  };
  return {
    __esModule: true,
    forceSimulation: (nodes: any[]) => makeSim(nodes),
    forceLink: () => {
      const f: any = {};
      f.id = () => f;
      f.distance = () => f;
      f.strength = () => f;
      return f;
    },
    forceManyBody: () => ({ strength: () => ({}) }),
    forceCenter: () => ({}),
    forceCollide: () => ({}),
  };
});

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
    React.createElement(
      'button',
      { onClick, disabled, ...rest },
      children,
    ),
}));

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, htmlFor, className }: any) =>
    React.createElement('label', { htmlFor, className }, children),
}));

jest.mock('../../components/ui/switch', () => ({
  Switch: ({ id, checked, onCheckedChange, ...rest }: any) =>
    React.createElement('input', {
      id,
      type: 'checkbox',
      role: 'switch',
      checked: !!checked,
      onChange: (e: any) => onCheckedChange?.(!!e.target.checked),
      ...rest,
    }),
}));

// Slider primitive — render as a native range input so tests can drive
// the value via fireEvent.change. shadcn Slider takes value as
// number[]; the mock unwraps the first element on read and re-wraps on
// change, mirroring the production component's [v] ↔ v contract.
jest.mock('../../components/ui/slider', () => ({
  Slider: ({ value, onValueChange, min, max, step, ...rest }: any) =>
    React.createElement('input', {
      type: 'range',
      min,
      max,
      step,
      value: Array.isArray(value) ? value[0] : value,
      onChange: (e: any) => onValueChange?.([Number(e.target.value)]),
      ...rest,
    }),
}));

// Select primitive — render as a native <select> so we can drive the
// value via fireEvent.change, no portal-based shadcn mechanics. The
// SelectTrigger / SelectValue render to nothing (or fragments) to keep
// the DOM a strict <select><option/></select> shape.
jest.mock('../../components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) =>
    React.createElement(
      'select',
      {
        value,
        onChange: (e: any) => onValueChange?.(e.target.value),
        'data-testid': 'select',
      },
      children,
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) =>
    React.createElement(React.Fragment, null, children),
  SelectItem: ({ value, children }: any) =>
    React.createElement('option', { value }, children),
}));

// Tabs primitive — replace Radix's portalised tabs with a plain
// state-driven mock so tests can fireEvent.click on a TabsTrigger and
// assert TabsContent visibility without shadcn's keyboard mechanics.
jest.mock('../../components/ui/tabs', () => {
  const React = require('react');
  const TabsContext = React.createContext({
    value: '',
    setValue: (_v: string) => {},
  });
  const Tabs = ({ defaultValue, children }: any) => {
    const [value, setValue] = React.useState(defaultValue ?? '');
    return React.createElement(
      TabsContext.Provider,
      { value: { value, setValue } },
      React.createElement('div', { 'data-testid': 'tabs' }, children),
    );
  };
  const TabsList = ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'tabs-list' }, children);
  const TabsTrigger = ({ value, children, ...rest }: any) => {
    const ctx = React.useContext(TabsContext);
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => ctx.setValue(value),
        'data-state': ctx.value === value ? 'active' : 'inactive',
        ...rest,
      },
      children,
    );
  };
  const TabsContent = ({ value, children, ...rest }: any) => {
    const ctx = React.useContext(TabsContext);
    if (ctx.value !== value) return null;
    return React.createElement(
      'div',
      { 'data-testid': `tabs-content-${value}`, ...rest },
      children,
    );
  };
  return { __esModule: true, Tabs, TabsList, TabsTrigger, TabsContent };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listAuthorityUnits: jest.fn(),
    listCompositionContracts: jest.fn(),
    getRevokeImpact: jest.fn(),
    getAuthorityGraphHistorySettings: jest.fn(),
    updateAuthorityGraphHistorySettings: jest.fn(),
    listAuthorityGraphSnapshots: jest.fn(),
    getAuthorityGraphSnapshot: jest.fn(),
  },
}));

// Mock the settings dialog component itself so the page test stays
// focused on the card composition + dialog open/close wiring (the
// dialog itself has its own dedicated test).
jest.mock('../../components/AuthorityGraphHistorySettingsDialog', () => ({
  __esModule: true,
  AuthorityGraphHistorySettingsDialog: ({ open, onSaved }: any) =>
    open
      ? React.createElement(
          'div',
          { 'data-testid': 'authority-graph-history-settings-dialog' },
          React.createElement(
            'button',
            {
              'data-testid':
                'authority-graph-history-mock-confirm',
              onClick: () =>
                onSaved?.({
                  ok: true,
                  settings: {
                    enabled: true,
                    retentionDays: 30,
                    captureMode: 'daily',
                    lastSnapshotAt: null,
                    snapshotCountInWindow: 0,
                    storageEstimate: '—',
                  },
                  emittedEventDetailType:
                    'governance.authority-graph-history.config.changed',
                }),
            },
            'Mock confirm',
          ),
        )
      : null,
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceGraph } from '../../pages/governance/Graph';

function makeUnit(overrides: any = {}): any {
  return {
    unitId: 'u-1',
    agentId: 'agent-a',
    scope: {
      decisionType: 'invoke_agent',
      domain: 'payment',
      conditions: JSON.stringify({ tier: 'gold' }),
      limits: JSON.stringify({ max_amount: 1000 }),
      specificity: 2,
    },
    delegationSource: null,
    canRedelegate: false,
    expiryTimestamp: null,
    revoked: false,
    riskRating: 'low',
    registryId: 'reg-app-1',
    isValid: true,
    ...overrides,
  };
}

function makeContract(overrides: any = {}): any {
  return {
    contractId: 'c-1',
    partyA: 'agent-a',
    partyB: 'agent-b',
    authorityPrecedence: 'agent-a',
    conflictResolution: 'halt_and_escalate',
    invariants: ['inv-1'],
    stopRights: ['agent-a'],
    scope: {
      decisionType: '*',
      domain: '*',
      conditions: '{}',
      limits: '{}',
      specificity: 0,
    },
    escalationPath: null,
    ...overrides,
  };
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

describe('GovernanceGraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [],
    );
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: false,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: null,
      snapshotCountInWindow: 0,
      storageEstimate: '—',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(null);
  });

  it('non-admin renders empty state and does NOT fetch', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    expect(screen.getByTestId('graph-admin-only')).toBeInTheDocument();
    expect(governanceService.listAuthorityUnits).not.toHaveBeenCalled();
    expect(governanceService.listCompositionContracts).not.toHaveBeenCalled();
  });

  it('admin: fetches both listAuthorityUnits and listCompositionContracts on mount', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit(),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [makeContract()],
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(governanceService.listAuthorityUnits).toHaveBeenCalledTimes(1);
      expect(governanceService.listCompositionContracts).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  it('renders stat line with correct N/M/P/Q', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-1', agentId: 'a1', scope: { ...makeUnit().scope, domain: 'd1' } }),
      makeUnit({ unitId: 'u-2', agentId: 'a2', scope: { ...makeUnit().scope, domain: 'd2' } }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue([
      makeContract({ contractId: 'c-1', partyA: 'a1', partyB: 'a2' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-stats')).toBeInTheDocument();
    });

    const stats = screen.getByTestId('graph-stats').textContent || '';
    // 2 agents, 2 units, 1 contract, 2 domains.
    expect(stats).toMatch(/2 agents/);
    expect(stats).toMatch(/2 units/);
    expect(stats).toMatch(/1 contract/);
    expect(stats).toMatch(/2 domains/);
  });

  it('domain filter hides non-matching units (client-side)', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-pay', scope: { ...makeUnit().scope, domain: 'payment' } }),
      makeUnit({ unitId: 'u-fra', agentId: 'agent-c', scope: { ...makeUnit().scope, domain: 'fraud' } }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-pay')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-unit-u-fra')).toBeInTheDocument();
    });

    // Switch the domain filter to 'payment'. The native <select> we mocked
    // is the only one in the DOM (registry select is hidden when there is
    // a single registryId across loaded units).
    const selectEls = document.querySelectorAll('select');
    expect(selectEls.length).toBeGreaterThanOrEqual(1);
    // The domain select is the LAST one rendered in the filter bar
    // (registry is hidden when only one registryId).
    const lastSelect = selectEls[selectEls.length - 1] as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(lastSelect, { target: { value: 'payment' } });
    });

    expect(screen.getByTestId('rf-node-unit-u-pay')).toBeInTheDocument();
    expect(screen.queryByTestId('rf-node-unit-u-fra')).toBeNull();
  });

  it('includeRevoked toggle re-fetches with the flag', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(governanceService.listAuthorityUnits).toHaveBeenCalledTimes(1);
    });
    // Initial: includeRevoked false.
    expect(
      (governanceService.listAuthorityUnits as jest.Mock).mock.calls[0][0],
    ).toEqual({
      registryId: null,
      includeRevoked: false,
    });

    // Flip the switch.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-include-revoked-toggle'));
    });

    await waitFor(() => {
      expect(governanceService.listAuthorityUnits).toHaveBeenCalledTimes(2);
    });
    expect(
      (governanceService.listAuthorityUnits as jest.Mock).mock.calls[1][0],
    ).toEqual({
      registryId: null,
      includeRevoked: true,
    });
  });

  it('clicking a unit node opens the side panel with the unit details', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({
        unitId: 'u-detail',
        scope: {
          decisionType: 'invoke_agent',
          domain: 'payment',
          conditions: JSON.stringify({ tier: 'gold' }),
          limits: JSON.stringify({}),
          specificity: 1,
        },
        riskRating: 'high',
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-detail')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-detail'));
    });

    expect(screen.getByTestId('graph-side-panel-unit')).toBeInTheDocument();
    expect(screen.getByTestId('graph-side-panel-unit-risk').textContent).toBe(
      'high',
    );
    expect(
      screen.getByTestId('graph-side-panel-unit-conditions').textContent,
    ).toContain('"tier"');
  });

  it('clicking an agent node lists bound units', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-1', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-2', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-3', agentId: 'agent-b' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-agent-agent-a')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-agent-agent-a'));
    });

    expect(screen.getByTestId('graph-side-panel-agent')).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-side-panel-agent-unit-u-1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-side-panel-agent-unit-u-2'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('graph-side-panel-agent-unit-u-3'),
    ).toBeNull();
  });

  it('clicking a contract node shows partyA/partyB scopes', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-a1', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-b1', agentId: 'agent-b' }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue([
      makeContract({
        contractId: 'c-detail',
        partyA: 'agent-a',
        partyB: 'agent-b',
        conflictResolution: 'precedence_resolution',
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rf-node-contract-c-detail'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-contract-c-detail'));
    });

    expect(screen.getByTestId('graph-side-panel-contract')).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-side-panel-contract-conflict').textContent,
    ).toBe('precedence_resolution');
    expect(
      screen.getByTestId('graph-side-panel-contract-partyA-units').textContent,
    ).toContain('u-a1');
    expect(
      screen.getByTestId('graph-side-panel-contract-partyB-units').textContent,
    ).toContain('u-b1');
  });

  it('empty fetch -> empty state', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [],
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-empty-state')).toBeInTheDocument();
    });
  });

  it('500+ node truncation notice renders', async () => {
    setOrg(true);
    // 600 units → 600 unit nodes + agent nodes + contract nodes; the cap
    // is 500, so the truncation notice MUST render.
    const lots = Array.from({ length: 600 }, (_, i) =>
      makeUnit({ unitId: `u-${i}`, agentId: `agent-${i}` }),
    );
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue(lots);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-truncation-notice'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('graph-truncation-notice').textContent,
    ).toMatch(/Showing first 500 of/);
  });

  it('positions on rendered nodes are numbers', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-a', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-b', agentId: 'agent-b' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-a')).toBeInTheDocument();
    });

    const nodeA = screen.getByTestId('rf-node-unit-u-a');
    const x = Number(nodeA.getAttribute('data-x'));
    const y = Number(nodeA.getAttribute('data-y'));
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('composition edges colour-encode the conflictResolution', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-a', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-b', agentId: 'agent-b' }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue([
      makeContract({
        contractId: 'c-deny',
        partyA: 'agent-a',
        partyB: 'agent-b',
        conflictResolution: 'default_deny',
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-edge-comp-c-deny')).toBeInTheDocument();
    });

    const edge = screen.getByTestId('rf-edge-comp-c-deny');
    expect(edge.getAttribute('data-edge-kind')).toBe('composition');
    expect(edge.getAttribute('data-stroke')).toContain('destructive');
  });
});

// ---------------------------------------------------------------------------
// blast-radius mode tests
// ---------------------------------------------------------------------------

describe('GovernanceGraph blast-radius mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Always-fresh localStorage between cases — toggle/window persistence
    // is asserted explicitly inside the localStorage test below.
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-br', agentId: 'agent-a' }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [],
    );
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: false,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: null,
      snapshotCountInWindow: 0,
      storageEstimate: '—',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(null);
    (governanceService.getRevokeImpact as jest.Mock).mockResolvedValue({
      unitId: 'u-br',
      sinceTs: 0,
      untilTs: 0,
      totalPermits: 7,
      distinctWorkflows: 2,
      distinctAgentPairs: 2,
      workflows: [
        { workflowId: 'wf-a', permitCount: 4, lastTimestamp: 1700000200 },
        { workflowId: 'wf-b', permitCount: 3, lastTimestamp: 1700000100 },
      ],
      agentPairs: [
        { requestingAgent: 'a', targetAgent: 'b', permitCount: 4 },
        { requestingAgent: 'c', targetAgent: 'd', permitCount: 3 },
      ],
      truncated: false,
    });
  });

  it('blast-radius toggle is hidden when not admin (page is admin-gated)', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    // Admin-only state renders; the toggle is part of the filter bar
    // which is not rendered for non-admins.
    expect(screen.getByTestId('graph-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-blast-radius-toggle')).toBeNull();
  });

  it('toggle OFF: clicking a unit opens the regular side panel and does NOT call getRevokeImpact', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    // Toggle is OFF by default; click the unit node.
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    expect(screen.getByTestId('graph-side-panel-unit')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-blast-radius-section')).toBeNull();
    expect(governanceService.getRevokeImpact).not.toHaveBeenCalled();
  });

  it('toggle ON: clicking a unit calls getRevokeImpact with the correct sinceTs window (1h)', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    // Flip the blast-radius toggle ON.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });

    // Click the unit node.
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    await waitFor(() => {
      expect(governanceService.getRevokeImpact).toHaveBeenCalledTimes(1);
    });
    const call = (governanceService.getRevokeImpact as jest.Mock).mock
      .calls[0][0];
    expect(call.unitId).toBe('u-br');
    // 1h window: untilTs - sinceTs == 3600.
    expect(call.untilTs - call.sinceTs).toBe(3600);
  });

  it('toggle ON: side panel renders Workflows + Agent pairs tabs in blast mode', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-blast-radius-section'),
      ).toBeInTheDocument();
    });

    // Stat row populated.
    expect(
      screen.getByTestId('graph-blast-radius-total-permits').textContent,
    ).toBe('7');
    expect(
      screen.getByTestId('graph-blast-radius-distinct-workflows').textContent,
    ).toBe('2');
    expect(
      screen.getByTestId('graph-blast-radius-distinct-pairs').textContent,
    ).toBe('2');

    // Tabs render — workflows visible by default, switch to pairs.
    expect(
      screen.getByTestId('graph-blast-radius-tab-workflows'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-blast-radius-tab-pairs'),
    ).toBeInTheDocument();

    // Workflows list rendered.
    expect(screen.getByTestId('graph-blast-radius-workflows')).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-blast-radius-workflow-wf-a'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-blast-radius-workflow-wf-b'),
    ).toBeInTheDocument();

    // Switch to agent pairs tab.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-tab-pairs'));
    });
    expect(screen.getByTestId('graph-blast-radius-pairs')).toBeInTheDocument();
    expect(
      screen.getByTestId('graph-blast-radius-pair-a-b'),
    ).toBeInTheDocument();
  });

  it('truncated=true renders the truncation banner', async () => {
    setOrg(true);
    (governanceService.getRevokeImpact as jest.Mock).mockResolvedValue({
      unitId: 'u-br',
      sinceTs: 0,
      untilTs: 0,
      totalPermits: 5000,
      distinctWorkflows: 100,
      distinctAgentPairs: 100,
      workflows: [],
      agentPairs: [],
      truncated: true,
    });

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-blast-radius-truncated'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('graph-blast-radius-truncated').textContent,
    ).toMatch(/5000\+ permits/);
  });

  it('totalPermits=0 renders the zero-impact message', async () => {
    setOrg(true);
    (governanceService.getRevokeImpact as jest.Mock).mockResolvedValue({
      unitId: 'u-br',
      sinceTs: 0,
      untilTs: 0,
      totalPermits: 0,
      distinctWorkflows: 0,
      distinctAgentPairs: 0,
      workflows: [],
      agentPairs: [],
      truncated: false,
    });

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-blast-radius-zero'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('graph-blast-radius-zero').textContent,
    ).toMatch(/No permits selected this unit/);
  });

  it('time-range change exposes a Re-run button that triggers a re-fetch with the new window', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-br')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-br'));
    });

    await waitFor(() => {
      expect(governanceService.getRevokeImpact).toHaveBeenCalledTimes(1);
    });

    // Change the window from 1h to 6h via the native select mock. The
    // mocked Select renders a <select>; the blast-radius window select
    // is the LAST one rendered (after optional registry select +
    // domain select).
    const allSelects = document.querySelectorAll('select');
    const blastSelect = allSelects[allSelects.length - 1] as HTMLSelectElement;
    expect(blastSelect).toBeTruthy();

    await act(async () => {
      fireEvent.change(blastSelect, { target: { value: '6h' } });
    });

    // Re-run button surfaces and dispatches a fresh fetch.
    await waitFor(() => {
      expect(
        screen.getByTestId('graph-blast-radius-rerun'),
      ).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-rerun'));
    });

    await waitFor(() => {
      expect(governanceService.getRevokeImpact).toHaveBeenCalledTimes(2);
    });
    const second = (governanceService.getRevokeImpact as jest.Mock).mock
      .calls[1][0];
    // 6h window: untilTs - sinceTs == 6 * 3600.
    expect(second.untilTs - second.sinceTs).toBe(6 * 3600);
  });

  it('Clear button returns the graph to the neutral state (no destructive overlay on any edge)', async () => {
    setOrg(true);
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-a', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-b', agentId: 'agent-b' }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [
        makeContract({
          contractId: 'c-1',
          partyA: 'agent-a',
          partyB: 'agent-b',
          conflictResolution: 'precedence_resolution',
        }),
      ],
    );
    (governanceService.getRevokeImpact as jest.Mock).mockResolvedValue({
      unitId: 'u-a',
      sinceTs: 0,
      untilTs: 0,
      totalPermits: 1,
      distinctWorkflows: 1,
      distinctAgentPairs: 1,
      workflows: [
        { workflowId: 'wf-a', permitCount: 1, lastTimestamp: 100 },
      ],
      agentPairs: [
        { requestingAgent: 'a', targetAgent: 'b', permitCount: 1 },
      ],
      truncated: false,
    });

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-a')).toBeInTheDocument();
    });

    // Toggle ON, click u-a → destructive overlay applied to incident edges.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-unit-u-a'));
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('graph-blast-radius-section'),
      ).toBeInTheDocument();
    });

    // Find an edge incident on u-a — it must carry the destructive overlay
    // stroke; non-incident edges fade to opacity 0.3 via `style.opacity`.
    // The composition edge between agents is non-incident and the binding
    // edge `bind-agent-a-u-a` IS incident (target = unit-u-a).
    const incidentEdge = screen.getByTestId('rf-edge-bind-agent-a-u-a');
    expect(incidentEdge.getAttribute('data-stroke')).toContain('destructive');

    // Click Clear → highlight removed; incident edge no longer destructive.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-clear'));
    });

    // Section is gone (selection still open but the highlight cleared);
    // the incident edge stroke reverts to the muted-foreground default
    // emitted by buildGraph for binding edges.
    await waitFor(() => {
      const edgeAfter = screen.getByTestId('rf-edge-bind-agent-a-u-a');
      expect(edgeAfter.getAttribute('data-stroke')).not.toContain(
        'destructive',
      );
    });
  });

  it('localStorage persists the blast-radius toggle and time range', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    // Flip toggle → localStorage now has the truthy flag.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-blast-radius-toggle'));
    });
    expect(window.localStorage.getItem('governance.graph.blastRadius')).toBe(
      'true',
    );

    // Change window to 24h.
    const allSelects = document.querySelectorAll('select');
    const windowSelect = allSelects[allSelects.length - 1] as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(windowSelect, { target: { value: '24h' } });
    });
    expect(
      window.localStorage.getItem('governance.graph.blastRadius.window'),
    ).toBe('24h');
  });

  // ---- history settings card ----

  it('admin sees the authority graph history settings card', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('authority-graph-history-card'),
      ).toBeInTheDocument();
    });
    // Default settings stub is enabled=false → DISABLED pill.
    await waitFor(() => {
      const pill = screen.getByTestId(
        'authority-graph-history-status-pill',
      );
      expect(pill).toHaveTextContent('History: DISABLED');
    });
  });

  it('card shows ENABLED state when settings.enabled === true', async () => {
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 5,
      storageEstimate: '~40KB',
    });
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      const pill = screen.getByTestId(
        'authority-graph-history-status-pill',
      );
      expect(pill).toHaveTextContent('History: ENABLED');
      expect(pill.getAttribute('data-history-enabled')).toBe('true');
    });
    expect(
      screen.getByTestId('authority-graph-history-detail').textContent,
    ).toContain('Last snapshot: 2026-05-19T03:00:00.000Z');
    expect(
      screen.getByTestId('authority-graph-history-detail').textContent,
    ).toContain('5 snapshots in window');
    expect(
      screen.getByTestId('authority-graph-history-detail').textContent,
    ).toContain('~40KB');
  });

  it('Configure button opens the settings dialog', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('authority-graph-history-configure'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-configure'),
      );
    });

    expect(
      screen.getByTestId('authority-graph-history-settings-dialog'),
    ).toBeInTheDocument();
  });

  it('refetches settings after a successful save', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        governanceService.getAuthorityGraphHistorySettings,
      ).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-configure'),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-mock-confirm'),
      );
    });

    await waitFor(() => {
      expect(
        governanceService.getAuthorityGraphHistorySettings,
      ).toHaveBeenCalledTimes(2);
    });
  });

  it('non-admin does NOT fetch the history settings', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    expect(
      governanceService.getAuthorityGraphHistorySettings,
    ).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// time scrubber tests
// ---------------------------------------------------------------------------

describe('GovernanceGraph time scrubber', () => {
  function makeSummary(overrides: any = {}): any {
    return {
      snapshotId: 's-1',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      kind: 'full',
      partial: false,
      authorityUnitsCount: 2,
      compositionContractsCount: 1,
      constitutionalLayersCount: 0,
      caseLawCount: 0,
      ...overrides,
    };
  }

  function makeSnapshotPayload(overrides: any = {}): any {
    return {
      snapshotId: 's-1',
      timestamp: 1715000000,
      expiresAt: 1715000000 + 30 * 86400,
      kind: 'full',
      partial: false,
      authorityUnits: [makeUnit({ unitId: 'u-snap-1', agentId: 'agent-a' })],
      compositionContracts: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-live', agentId: 'agent-a' }),
    ]);
    (governanceService.listCompositionContracts as jest.Mock).mockResolvedValue(
      [],
    );
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(null);
  });

  it('scrubber hidden when history is disabled — Enable history notice renders', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: false,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: null,
      snapshotCountInWindow: 0,
      storageEstimate: '—',
    });

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-time-scrubber-notice'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('graph-time-scrubber-notice').textContent,
    ).toMatch(/Enable history/);
    expect(screen.queryByTestId('graph-time-scrubber')).toBeNull();
  });

  it('scrubber hidden when history enabled but no snapshots — first snapshot notice renders', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: null,
      snapshotCountInWindow: 0,
      storageEstimate: '—',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('graph-time-scrubber-notice'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('graph-time-scrubber-notice').textContent,
    ).toMatch(/first snapshot at 03:00 UTC/);
    expect(screen.queryByTestId('graph-time-scrubber')).toBeNull();
  });

  it('scrubber visible when history enabled + at least 1 snapshot exists', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 1,
      storageEstimate: '~8KB',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([makeSummary()]);

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-time-scrubber')).toBeInTheDocument();
    });
    expect(screen.getByTestId('graph-scrubber-now')).toBeInTheDocument();
    expect(screen.getByTestId('graph-scrubber-slider')).toBeInTheDocument();
  });

  it('selecting a historical snapshot fetches getAuthorityGraphSnapshot and re-renders graph from snapshot data', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 1,
      storageEstimate: '~8KB',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([makeSummary({ snapshotId: 's-historical' })]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(
      makeSnapshotPayload({
        snapshotId: 's-historical',
        authorityUnits: [
          makeUnit({ unitId: 'u-historical', agentId: 'agent-h' }),
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-time-scrubber')).toBeInTheDocument();
      // Live data renders u-live initially.
      expect(screen.getByTestId('rf-node-unit-u-live')).toBeInTheDocument();
    });

    // Move slider to index 0 — first historical snapshot.
    const slider = screen.getByTestId(
      'graph-scrubber-slider',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0' } });
    });

    await waitFor(() => {
      expect(
        governanceService.getAuthorityGraphSnapshot,
      ).toHaveBeenCalledWith('s-historical');
    });

    // Snapshot data drives rendering — u-historical now visible, u-live gone.
    await waitFor(() => {
      expect(
        screen.getByTestId('rf-node-unit-u-historical'),
      ).toBeInTheDocument();
    });
  });

  it('Show-delta toggle ON adds ghost markers for added-since units', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 1,
      storageEstimate: '~8KB',
    });
    // Live data has TWO units: u-live (also in snapshot) + u-added (new).
    (governanceService.listAuthorityUnits as jest.Mock).mockResolvedValue([
      makeUnit({ unitId: 'u-live', agentId: 'agent-a' }),
      makeUnit({ unitId: 'u-added', agentId: 'agent-a' }),
    ]);
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([makeSummary({ snapshotId: 's-historical' })]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(
      makeSnapshotPayload({
        snapshotId: 's-historical',
        authorityUnits: [makeUnit({ unitId: 'u-live', agentId: 'agent-a' })],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-time-scrubber')).toBeInTheDocument();
    });

    const slider = screen.getByTestId(
      'graph-scrubber-slider',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0' } });
    });

    // Show-delta is ON by default when scrubbed back; ghost marker should
    // surface for u-added.
    await waitFor(() => {
      expect(
        screen.getByTestId('rf-node-ghost-unit-u-added'),
      ).toBeInTheDocument();
    });
  });

  it('Now button returns to live data', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 1,
      storageEstimate: '~8KB',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([makeSummary({ snapshotId: 's-historical' })]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(
      makeSnapshotPayload({
        snapshotId: 's-historical',
        authorityUnits: [
          makeUnit({ unitId: 'u-historical', agentId: 'agent-h' }),
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-time-scrubber')).toBeInTheDocument();
    });

    const slider = screen.getByTestId(
      'graph-scrubber-slider',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0' } });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rf-node-unit-u-historical'),
      ).toBeInTheDocument();
    });

    // Click Now → returns to live data.
    await act(async () => {
      fireEvent.click(screen.getByTestId('graph-scrubber-now'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-unit-u-live')).toBeInTheDocument();
      expect(screen.queryByTestId('rf-node-unit-u-historical')).toBeNull();
    });
  });

  it('Blast-radius toggle is disabled when viewing a historical snapshot', async () => {
    setOrg(true);
    (
      governanceService.getAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue({
      enabled: true,
      retentionDays: 30,
      captureMode: 'daily',
      lastSnapshotAt: '2026-05-19T03:00:00.000Z',
      snapshotCountInWindow: 1,
      storageEstimate: '~8KB',
    });
    (
      governanceService.listAuthorityGraphSnapshots as jest.Mock
    ).mockResolvedValue([makeSummary({ snapshotId: 's-historical' })]);
    (
      governanceService.getAuthorityGraphSnapshot as jest.Mock
    ).mockResolvedValue(
      makeSnapshotPayload({ snapshotId: 's-historical' }),
    );

    await act(async () => {
      render(React.createElement(GovernanceGraph));
    });

    await waitFor(() => {
      expect(screen.getByTestId('graph-time-scrubber')).toBeInTheDocument();
    });

    // Initially the toggle is enabled (default Now slot).
    const toggle = screen.getByTestId(
      'graph-blast-radius-toggle',
    ) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);

    // Move to historical snapshot.
    const slider = screen.getByTestId(
      'graph-scrubber-slider',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '0' } });
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId('graph-blast-radius-toggle') as HTMLInputElement)
          .disabled,
      ).toBe(true);
    });
    expect(
      screen
        .getByTestId('graph-blast-radius-toggle')
        .getAttribute('title'),
    ).toMatch(/historical snapshot/);
  });
});
