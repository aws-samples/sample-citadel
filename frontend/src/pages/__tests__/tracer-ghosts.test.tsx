/**
 * parallel ghost pipelines on the decision flow tracer.
 *
 * Two concerns:
 *   1. The pure `detectConcurrencyGroup` helper (unit tests, no React).
 *   2. The page integration: badge, ghost canvases, toggle, localStorage,
 *      static-mode disable.
 *
 * Mocks mirror governance-tracer.test.tsx (ReactFlow stub, shadcn primitives,
 * router, governance service) so the harness stays consistent.
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

import { detectConcurrencyGroup } from '../../pages/governance/tracerUtils';
import type { GovernanceFinding } from '../../services/governanceService';

// ---------------------------------------------------------------------------
// detectConcurrencyGroup — pure helper unit tests
// ---------------------------------------------------------------------------

function f(
  findingId: string,
  timestamp: number,
  overrides: Partial<GovernanceFinding> = {},
): GovernanceFinding {
  return {
    findingId,
    workflowId: `wf-${findingId}`,
    decision: 'permit',
    reason: '',
    requestingAgent: 'a',
    targetAgent: 'b',
    scopeEvaluated: null,
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    timestamp,
    ...overrides,
  };
}

describe('detectConcurrencyGroup', () => {
  it('returns null for an empty buffer', () => {
    expect(detectConcurrencyGroup([], null)).toBeNull();
  });

  it('returns foreground only when the buffer holds a single finding', () => {
    const only = f('only', 100);
    const result = detectConcurrencyGroup([only], null);
    expect(result).not.toBeNull();
    expect(result!.foreground.findingId).toBe('only');
    expect(result!.ghosts).toHaveLength(0);
  });

  it('attaches one ghost when two findings sit within the 100ms window', () => {
    // Buffer is most-recent-first: [b @100.05s, a @100.0s]; both within 0.1s.
    const newer = f('b', 100.05);
    const older = f('a', 100.0);
    const result = detectConcurrencyGroup([newer, older], null);
    expect(result!.foreground.findingId).toBe('b');
    expect(result!.ghosts.map((g) => g.findingId)).toEqual(['a']);
  });

  it('excludes findings outside the window', () => {
    // Foreground at t=100. Two within ±100ms (one inside is the "outsider"
    // off by 0.5s); the helper should drop the outsider only.
    const fg = f('fg', 100.0);
    const inside = f('inside', 100.04);
    const outside = f('outside', 99.4); // 0.6s away → excluded
    const result = detectConcurrencyGroup([fg, inside, outside], null);
    expect(result!.foreground.findingId).toBe('fg');
    expect(result!.ghosts.map((g) => g.findingId)).toEqual(['inside']);
  });

  it('caps ghosts at maxGhosts (default 4) even when more findings are concurrent', () => {
    // 5 findings within ±100ms of foreground (foreground + 4 ghosts limit).
    const fg = f('fg', 100.0);
    const g1 = f('g1', 100.01);
    const g2 = f('g2', 100.02);
    const g3 = f('g3', 100.03);
    const g4 = f('g4', 100.04);
    const g5 = f('g5', 100.05);
    const result = detectConcurrencyGroup([fg, g5, g4, g3, g2, g1], null);
    expect(result!.foreground.findingId).toBe('fg');
    expect(result!.ghosts).toHaveLength(4);
    // Ghosts sorted descending by timestamp — most recent ghost first.
    expect(result!.ghosts.map((g) => g.findingId)).toEqual([
      'g5',
      'g4',
      'g3',
      'g2',
    ]);
  });

  it('uses the pinned finding as the foreground when it is in the buffer', () => {
    // Newest is 'newest' but operator pinned 'pinned'. Foreground should be
    // the pinned finding, ghosts gathered around its timestamp.
    const pinned = f('pinned', 100.0);
    const aroundPinnedNew = f('around-new', 100.05);
    const aroundPinnedOld = f('around-old', 99.95);
    const newest = f('newest', 105.0); // outside the pinned window
    const result = detectConcurrencyGroup(
      [newest, aroundPinnedNew, pinned, aroundPinnedOld],
      'pinned',
    );
    expect(result!.foreground.findingId).toBe('pinned');
    expect(result!.ghosts.map((g) => g.findingId)).toEqual([
      'around-new',
      'around-old',
    ]);
  });

  it('falls back to most-recent when the pinned id is missing from the buffer', () => {
    const newest = f('newest', 100.0);
    const older = f('older', 99.5);
    const result = detectConcurrencyGroup(
      [newest, older],
      'evicted-id-not-in-buffer',
    );
    expect(result!.foreground.findingId).toBe('newest');
  });
});

// ---------------------------------------------------------------------------
// Page integration — mocks copied/adapted from governance-tracer.test.tsx
// ---------------------------------------------------------------------------

const mockNavigate = jest.fn();
let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = jest.fn(
  (next: URLSearchParams | Record<string, string>) => {
    if (next instanceof URLSearchParams) {
      mockSearchParams = next;
    } else {
      mockSearchParams = new URLSearchParams(next);
    }
  },
);

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

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
                'data-status': n.data?.step?.status,
                onClick: (e: any) => onNodeClick && onNodeClick(e, n),
              },
              n.data?.step?.name ?? n.id,
            ),
          ),
        ),
        React.createElement(
          'ul',
          { 'data-testid': 'rf-edges' },
          edges.map((e: any) =>
            React.createElement('li', {
              key: e.id,
              'data-testid': `rf-edge-${e.id}`,
            }),
          ),
        ),
      ),
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
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
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../../components/ui/input', () => ({
  Input: ({ id, value, onChange, onKeyDown, ...rest }: any) =>
    React.createElement('input', {
      id,
      value,
      onChange,
      onKeyDown,
      ...rest,
    }),
}));

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, htmlFor, className }: any) =>
    React.createElement('label', { htmlFor, className }, children),
}));

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, variant, ...rest }: any) =>
    React.createElement(
      'span',
      { 'data-variant': variant, 'data-testid': 'badge', ...rest },
      children,
    ),
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

jest.mock('../../components/ui/slider', () => ({
  Slider: ({ value, min, max, onValueChange, ...rest }: any) =>
    React.createElement('input', {
      type: 'range',
      min,
      max,
      value: Array.isArray(value) ? value[0] : value,
      onChange: (e: any) => onValueChange?.([Number(e.target.value)]),
      ...rest,
    }),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    getDecisionTrace: jest.fn(),
    subscribeGovernanceFindings: jest.fn(),
  },
}));

// the Tracer page now consumes useOrganization and
// useGovernanceEngine. The ghost tests do not exercise the
// counterfactual evaluator, so we stub both hooks with safe defaults
// (non-admin, no engine) to keep the render path clean.
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    isAdmin: false,
    selectedOrganization: null,
    setSelectedOrganization: jest.fn(),
    organizations: [],
    currentUser: null,
    loading: false,
  }),
}));

jest.mock('../../hooks/useGovernanceEngine', () => ({
  useGovernanceEngine: () => ({
    engine: null,
    loading: false,
    error: null,
    refresh: jest.fn(),
  }),
}));

jest.mock('../../components/CounterfactualPanel', () => ({
  CounterfactualPanel: () => null,
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceTracer } from '../../pages/governance/Tracer';

const GHOSTS_STORAGE_KEY = 'governance.tracer.showGhosts';

function makeStep(stepNumber: number, status: string, overrides: any = {}) {
  return {
    stepNumber,
    name: `Step ${stepNumber}`,
    status,
    inputs: JSON.stringify({ stepNumber }),
    outputs: null,
    detail: `detail for step ${stepNumber}`,
    ...overrides,
  };
}

function makeStaticTrace(overrides: any = {}) {
  return {
    findingId: 'static-1',
    finding: {
      findingId: 'static-1',
      workflowId: 'wf-static',
      decision: 'permit',
      reason: 'scope_match:unit-1',
      requestingAgent: 'agent-a',
      targetAgent: 'agent-b',
      scopeEvaluated: 'unit-1',
      contractEvaluated: null,
      escalationTarget: null,
      residualAuthorityDenial: false,
      timestamp: 1715000000,
    },
    steps: [
      makeStep(1, 'pass-through'),
      makeStep(2, 'pass-through'),
      makeStep(3, 'matched'),
      makeStep(4, 'pass-through'),
      makeStep(5, 'matched'),
      makeStep(6, 'pass-through'),
      makeStep(7, 'permitted'),
      makeStep(8, 'skipped'),
    ],
    terminalDecision: 'permit',
    terminalStepNumber: 7,
    reasonTokens: ['scope_match', 'unit-1'],
    constitutionalOverride: false,
    arbitrationPattern: null,
    scopeReduction: null,
    ...overrides,
  };
}

function makeLiveFinding(overrides: any = {}) {
  return {
    findingId: 'live-1',
    workflowId: 'wf-live',
    decision: 'deny',
    reason: 'rivalrous_claim:winner=X',
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    scopeEvaluated: null,
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    timestamp: 1715000000,
    ...overrides,
  };
}

describe('GovernanceTracer — ghost pipelines', () => {
  let liveCallback: ((finding: any) => void) | null = null;
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    liveCallback = null;
    mockUnsubscribe = jest.fn();
    (governanceService.subscribeGovernanceFindings as jest.Mock).mockImplementation(
      (cb: (finding: any) => void) => {
        liveCallback = cb;
        return mockUnsubscribe;
      },
    );
    // Wipe the persisted ghost-toggle preference so each test starts fresh.
    window.localStorage.removeItem(GHOSTS_STORAGE_KEY);
  });

  it('renders no ghost canvases or badge when only one live finding exists', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    await act(async () => {
      liveCallback?.(makeLiveFinding({ findingId: 'solo' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-pipeline-canvas')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tracer-concurrency-badge')).toBeNull();
    expect(screen.queryByTestId('tracer-ghost-canvas-0')).toBeNull();
  });

  it('renders 2 ghost canvases and a 3-concurrent badge when 3 findings arrive within the window', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    // Three findings within 100ms → foreground + 2 ghosts.
    await act(async () => {
      liveCallback?.(
        makeLiveFinding({ findingId: 'a', timestamp: 1715000000.0 }),
      );
      liveCallback?.(
        makeLiveFinding({ findingId: 'b', timestamp: 1715000000.05 }),
      );
      liveCallback?.(
        makeLiveFinding({ findingId: 'c', timestamp: 1715000000.09 }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-concurrency-badge')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('tracer-concurrency-badge').textContent,
    ).toMatch(/3 concurrent decisions/);

    // Two ghosts: indices 0 and 1.
    const ghost0 = screen.getByTestId('tracer-ghost-canvas-0');
    const ghost1 = screen.getByTestId('tracer-ghost-canvas-1');
    expect(ghost0).toBeInTheDocument();
    expect(ghost1).toBeInTheDocument();
    expect(screen.queryByTestId('tracer-ghost-canvas-2')).toBeNull();

    // Opacity ladder: 0.5 then 0.35.
    expect(ghost0.style.opacity).toBe('0.5');
    expect(ghost1.style.opacity).toBe('0.35');

    // Ghosts must NOT intercept clicks meant for the foreground.
    expect(ghost0.className).toContain('pointer-events-none');
    expect(ghost1.className).toContain('pointer-events-none');
  });

  it('hides ghost canvases when "Show ghosts" is toggled off but keeps the badge visible', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    await act(async () => {
      liveCallback?.(
        makeLiveFinding({ findingId: 'a', timestamp: 1715000000.0 }),
      );
      liveCallback?.(
        makeLiveFinding({ findingId: 'b', timestamp: 1715000000.05 }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-ghost-canvas-0')).toBeInTheDocument();
    });

    // Toggle Show ghosts off.
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-ghost-toggle'));
    });

    expect(screen.queryByTestId('tracer-ghost-canvas-0')).toBeNull();
    // Badge still surfaces concurrency so the operator can opt back in.
    expect(screen.getByTestId('tracer-concurrency-badge')).toBeInTheDocument();
    // localStorage now stores the preference.
    expect(window.localStorage.getItem(GHOSTS_STORAGE_KEY)).toBe('false');
  });

  it('does not render ghost canvases in static mode regardless of any prior buffer', async () => {
    mockSearchParams = new URLSearchParams('findingId=static-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeStaticTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-pipeline-canvas')).toBeInTheDocument();
    });

    // No live toggle → no subscription → no concurrency group → no ghosts.
    expect(governanceService.subscribeGovernanceFindings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tracer-concurrency-badge')).toBeNull();
    expect(screen.queryByTestId('tracer-ghost-canvas-0')).toBeNull();
    expect(screen.queryByTestId('tracer-ghost-toggle')).toBeNull();
  });

  it('persists the Show ghosts toggle to localStorage and restores it on remount', async () => {
    // First mount: turn ghosts off.
    const { unmount } = render(React.createElement(GovernanceTracer));
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-ghost-toggle'));
    });
    expect(window.localStorage.getItem(GHOSTS_STORAGE_KEY)).toBe('false');

    unmount();

    // Re-mount: the toggle should restore as off (unchecked).
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });
    const ghostToggle = screen.getByTestId(
      'tracer-ghost-toggle',
    ) as HTMLInputElement;
    expect(ghostToggle.checked).toBe(false);
  });
});
