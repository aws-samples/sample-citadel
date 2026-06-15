/**
 * GovernanceTracer tests.
 *
 * Mocks @xyflow/react with a simple <ul> renderer so the test environment
 * doesn't have to load ReactFlow's layout/measurement dom (which is heavy
 * for jsdom and unnecessary for assertion coverage). Mocks the governance
 * service, OrganizationContext, react-router-dom, and shadcn primitives.
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

// Replace @xyflow/react with a minimal renderer that exposes the supplied
// nodes + edges as <ul> lists. Real ReactFlow is heavy in jsdom and the
// page's behaviour we care about (status colouring, node click → side
// panel, override edge) can be asserted off the data prop directly.
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
            React.createElement(
              'li',
              {
                key: e.id,
                'data-testid': `rf-edge-${e.id}`,
                'data-override': e.data?.override ? 'true' : 'false',
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

// useOrganization (used for admin gating of the
// "Edit and re-evaluate" button) and useGovernanceEngine (the
// client-side engine that the counterfactual panel evaluates against).
// Default mocks: not-admin, engine ready. Tests that exercise the
// admin path override `isAdmin: true` via the `setMockIsAdmin` helper.
let mockIsAdmin = false;
function setMockIsAdmin(v: boolean) {
  mockIsAdmin = v;
}

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    isAdmin: mockIsAdmin,
    selectedOrganization: null,
    setSelectedOrganization: jest.fn(),
    organizations: [],
    currentUser: null,
    loading: false,
  }),
}));

interface MockEngineEvalResult {
  finding: {
    findingId: string;
    workflowId: string;
    decision: string;
    requestingAgent: string;
    targetAgent: string;
    reason: string;
    timestamp: number;
    scopeEvaluated: string | null;
    contractEvaluated: string | null;
    escalationTarget: string | null;
    residualAuthorityDenial: boolean;
  };
}

let mockEngineLoading = false;
let mockEngine: { evaluate: jest.Mock } | null = null;
function setMockEngine(loading: boolean, evalResult: MockEngineEvalResult | null) {
  mockEngineLoading = loading;
  mockEngine = evalResult
    ? { evaluate: jest.fn().mockReturnValue(evalResult.finding) }
    : null;
}

jest.mock('../../hooks/useGovernanceEngine', () => ({
  useGovernanceEngine: () => ({
    engine: mockEngine,
    loading: mockEngineLoading,
    error: null,
    refresh: jest.fn(),
  }),
}));

// Mock the CounterfactualPanel as a passthrough so tests can assert it
// was rendered (or not) and trigger its `onCommit` directly via the
// captured prop without dragging the full Sheet primitive into jsdom.
let lastCounterfactualProps: any = null;
jest.mock('../../components/CounterfactualPanel', () => {
  const React = require('react');
  return {
    CounterfactualPanel: (props: any) => {
      lastCounterfactualProps = props;
      return props.open
        ? React.createElement(
            'div',
            { 'data-testid': 'counterfactual-panel-mock' },
            'panel-open',
          )
        : null;
    },
  };
});

import { governanceService } from '../../services/governanceService';
import { GovernanceTracer } from '../../pages/governance/Tracer';

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

function makeFinding(overrides: any = {}) {
  return {
    findingId: 'f-1',
    workflowId: 'wf-1',
    decision: 'permit',
    reason: 'scope_match:unit-1',
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    scopeEvaluated: 'unit-1',
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    timestamp: 1715000000,
    ...overrides,
  };
}

function makeTrace(overrides: any = {}) {
  return {
    findingId: 'f-1',
    finding: makeFinding(),
    steps: [
      makeStep(1, 'pass-through'),
      makeStep(2, 'pass-through', { name: 'Composition arbitration scaffold' }),
      makeStep(3, 'matched'),
      makeStep(4, 'pass-through'),
      makeStep(5, 'matched', {
        outputs: JSON.stringify({ scope_evaluated: 'unit-1' }),
      }),
      makeStep(6, 'pass-through'),
      makeStep(7, 'permitted', {
        outputs: JSON.stringify({ decision: 'permit', scope_evaluated: 'unit-1' }),
      }),
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

describe('GovernanceTracer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    setMockIsAdmin(false);
    setMockEngine(false, {
      finding: {
        findingId: 'alt-default',
        workflowId: 'wf-1',
        decision: 'permit',
        requestingAgent: 'agent-a',
        targetAgent: 'agent-b',
        reason: 'scope_match:unit-alt',
        timestamp: 1715000000,
        scopeEvaluated: 'unit-alt',
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: false,
      },
    });
    lastCounterfactualProps = null;
  });

  it('shows the empty state when no findingId is in URL or input', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    expect(screen.getByTestId('tracer-empty-state')).toBeInTheDocument();
    expect(governanceService.getDecisionTrace).not.toHaveBeenCalled();
  });

  it('?findingId=X query param triggers fetch on mount', async () => {
    mockSearchParams = new URLSearchParams('findingId=preset-id-123');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace({ findingId: 'preset-id-123' }),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(governanceService.getDecisionTrace).toHaveBeenCalledWith(
        'preset-id-123',
      );
    });
  });

  it('renders 8 step nodes and the canvas when trace is loaded', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-pipeline-canvas')).toBeInTheDocument();
    });

    // 8 step nodes rendered (the mock ReactFlow lists them).
    for (let i = 1; i <= 8; i++) {
      expect(screen.getByTestId(`rf-node-step-${i}`)).toBeInTheDocument();
    }
  });

  it('constitutional override edge styled red when constitutionalOverride=true', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace({
        constitutionalOverride: true,
        terminalStepNumber: 8,
        reasonTokens: [
          'constitutional_review',
          'layer-global',
          'invariant_violated',
          'max_tokens',
        ],
        steps: [
          makeStep(1, 'pass-through'),
          makeStep(2, 'pass-through'),
          makeStep(3, 'pass-through'),
          makeStep(4, 'pass-through'),
          makeStep(5, 'pass-through'),
          makeStep(6, 'pass-through'),
          makeStep(7, 'pass-through'),
          makeStep(8, 'overridden', {
            outputs: JSON.stringify({
              override_layer: 'layer-global',
              override_field: 'max_tokens',
              decision: 'deny',
            }),
          }),
        ],
        terminalDecision: 'deny',
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-edge-e-7-8')).toBeInTheDocument();
    });

    const overrideEdge = screen.getByTestId('rf-edge-e-7-8');
    expect(overrideEdge.getAttribute('data-override')).toBe('true');
    expect(overrideEdge.getAttribute('data-stroke')).toContain('destructive');

    // Canvas marks override at the container level too.
    expect(
      screen.getByTestId('tracer-pipeline-canvas').getAttribute(
        'data-constitutional-override',
      ),
    ).toBe('true');
  });

  it('clicking a node opens the side panel with inputs/outputs', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-step-7')).toBeInTheDocument();
    });

    // Default: empty side panel hint.
    expect(screen.getByTestId('tracer-side-panel-empty')).toBeInTheDocument();

    // Click step 7 (permit decision).
    await act(async () => {
      fireEvent.click(screen.getByTestId('rf-node-step-7'));
    });

    expect(screen.getByTestId('tracer-side-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tracer-side-panel-inputs')).toBeInTheDocument();
    expect(screen.getByTestId('tracer-side-panel-outputs')).toBeInTheDocument();
    // The outputs JSON contains the permit decision.
    expect(screen.getByTestId('tracer-side-panel-outputs').textContent).toContain(
      'permit',
    );
  });

  it('renders reason tokens as monospaced badges', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace({
        reasonTokens: [
          'rivalrous_claim',
          'winner=A',
          'loser=B',
          'attenuation',
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-reason-tokens')).toBeInTheDocument();
    });

    // 4 tokens rendered.
    expect(screen.getByTestId('tracer-reason-token-0').textContent).toBe(
      'rivalrous_claim',
    );
    expect(screen.getByTestId('tracer-reason-token-1').textContent).toBe(
      'winner=A',
    );
    expect(screen.getByTestId('tracer-reason-token-3').textContent).toBe(
      'attenuation',
    );
  });

  it('terminal decision card shows the correct decision badge and step', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace({
        terminalDecision: 'deny',
        terminalStepNumber: 4,
        steps: [
          makeStep(1, 'pass-through'),
          makeStep(2, 'pass-through'),
          makeStep(3, 'matched'),
          makeStep(4, 'denied'),
          makeStep(5, 'skipped'),
          makeStep(6, 'skipped'),
          makeStep(7, 'skipped'),
          makeStep(8, 'skipped'),
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-terminal-card')).toBeInTheDocument();
    });

    const badge = screen.getByTestId('tracer-terminal-decision-badge');
    expect(badge.textContent).toBe('deny');
    expect(badge.getAttribute('data-variant')).toBe('destructive');
    expect(screen.getByTestId('tracer-terminal-step').textContent).toBe(
      'step 4',
    );
  });

  it('service throws → inline error rendered', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-broken');
    (governanceService.getDecisionTrace as jest.Mock).mockRejectedValue(
      new Error('AccessDenied: ledger read failed'),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tracer-error').textContent).toContain(
      'AccessDenied',
    );
    // Canvas not rendered when the service throws.
    expect(screen.queryByTestId('tracer-pipeline-canvas')).toBeNull();
  });

  it('shows an explanatory error when the resolver returns null (finding missing)', async () => {
    mockSearchParams = new URLSearchParams('findingId=missing-id');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(null);

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tracer-error').textContent).toContain(
      'missing-id',
    );
  });

  it('Load button typed in the input triggers a fetch', async () => {
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace({ findingId: 'pasted-id' }),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    const input = screen.getByTestId('tracer-finding-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'pasted-id' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-load-button'));
    });

    await waitFor(() => {
      expect(governanceService.getDecisionTrace).toHaveBeenCalledWith(
        'pasted-id',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// live tail mode
// ---------------------------------------------------------------------------

describe('GovernanceTracer — live tail', () => {
  // Capture the subscription callback the page registers so the tests can
  // simulate incoming findings.
  let liveCallback: ((finding: any) => void) | null = null;
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    setMockIsAdmin(false);
    setMockEngine(false, {
      finding: {
        findingId: 'alt-default',
        workflowId: 'wf-1',
        decision: 'permit',
        requestingAgent: 'agent-a',
        targetAgent: 'agent-b',
        reason: 'scope_match:unit-alt',
        timestamp: 1715000000,
        scopeEvaluated: 'unit-alt',
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: false,
      },
    });
    lastCounterfactualProps = null;
    liveCallback = null;
    mockUnsubscribe = jest.fn();
    (governanceService.subscribeGovernanceFindings as jest.Mock).mockImplementation(
      (cb: (finding: any) => void) => {
        liveCallback = cb;
        return mockUnsubscribe;
      },
    );
  });

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

  it('does NOT subscribe when live toggle is off (default state)', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    expect(
      governanceService.subscribeGovernanceFindings,
    ).not.toHaveBeenCalled();
  });

  it('toggling live ON activates the governance subscription', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    const liveToggle = screen.getByTestId('tracer-live-toggle');
    await act(async () => {
      fireEvent.click(liveToggle);
    });

    expect(
      governanceService.subscribeGovernanceFindings,
    ).toHaveBeenCalledTimes(1);
  });

  it('renders the empty live state before any findings arrive', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    expect(screen.getByTestId('tracer-live-empty')).toBeInTheDocument();
  });

  it('auto-replays the latest live finding into the pipeline', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    await act(async () => {
      liveCallback?.(makeLiveFinding({ findingId: 'live-replay-1' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-pipeline-canvas')).toBeInTheDocument();
    });
    // The synthetic trace surfaces the finding's reason tokens in the
    // breadcrumb (rivalrous_claim:winner=X → 2 tokens).
    expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
      'rivalrous_claim',
    );
  });

  it('buffer indicator updates as findings arrive', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    await act(async () => {
      liveCallback?.(makeLiveFinding({ findingId: 'a' }));
      liveCallback?.(makeLiveFinding({ findingId: 'b' }));
    });

    await waitFor(() => {
      const indicator = screen.getByTestId('tracer-live-buffer-indicator');
      expect(indicator.textContent).toMatch(/2 findings/);
    });
  });

  it('pin freezes the displayed pipeline while the buffer continues to grow', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    // First finding lands and surfaces.
    await act(async () => {
      liveCallback?.(
        makeLiveFinding({
          findingId: 'first',
          reason: 'first_token:a',
          decision: 'permit',
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
        'first_token',
      );
    });

    // Pin.
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-pin-button'));
    });
    expect(screen.getByTestId('tracer-terminal-card')).toHaveAttribute(
      'data-pinned',
      'true',
    );

    // New finding arrives; the buffer indicator advances but the
    // displayed reason tokens stay on `first`.
    await act(async () => {
      liveCallback?.(
        makeLiveFinding({
          findingId: 'second',
          reason: 'second_token:b',
          decision: 'deny',
        }),
      );
    });

    await waitFor(() => {
      const indicator = screen.getByTestId('tracer-live-buffer-indicator');
      expect(indicator.textContent).toMatch(/2 findings/);
    });

    // Reason still reflects `first` (pin held).
    expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
      'first_token',
    );
  });

  it('scrubber drag replays the buffered finding closest to the slider position', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    // Three findings spread across a 30s window, oldest to newest.
    await act(async () => {
      liveCallback?.(
        makeLiveFinding({
          findingId: 'old',
          reason: 'old_token:o',
          timestamp: 1715000000,
        }),
      );
      liveCallback?.(
        makeLiveFinding({
          findingId: 'mid',
          reason: 'mid_token:m',
          timestamp: 1715000015,
        }),
      );
      liveCallback?.(
        makeLiveFinding({
          findingId: 'new',
          reason: 'new_token:n',
          timestamp: 1715000030,
        }),
      );
    });

    // Scrubber to a position closest to the middle finding (1715000015).
    const slider = screen.getByTestId('tracer-scrubber-slider') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: String(1715000015 * 1000) } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
        'mid_token',
      );
    });
  });

  it('Resume live returns to the latest finding after scrubbing', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    await act(async () => {
      liveCallback?.(
        makeLiveFinding({
          findingId: 'old',
          reason: 'old_token:o',
          timestamp: 1715000000,
        }),
      );
      liveCallback?.(
        makeLiveFinding({
          findingId: 'new',
          reason: 'new_token:n',
          timestamp: 1715000010,
        }),
      );
    });

    const slider = screen.getByTestId('tracer-scrubber-slider') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: String(1715000000 * 1000) } });
    });
    await waitFor(() =>
      expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
        'old_token',
      ),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-resume-live'));
    });
    // After resume, a new arrival reactivates auto-replay.
    await act(async () => {
      liveCallback?.(
        makeLiveFinding({
          findingId: 'newer',
          reason: 'newer_token:x',
          timestamp: 1715000020,
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('tracer-reason-token-0')).toHaveTextContent(
        'newer_token',
      ),
    );
  });

  it('toggling live OFF tears down the subscription', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });
    expect(
      governanceService.subscribeGovernanceFindings,
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// counterfactual evaluator
// ---------------------------------------------------------------------------

describe('GovernanceTracer — counterfactual', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    setMockIsAdmin(true);
    setMockEngine(false, {
      finding: {
        findingId: 'alt-default',
        workflowId: 'wf-1',
        decision: 'deny',
        requestingAgent: 'agent-a',
        targetAgent: 'agent-b',
        reason: 'residual_authority_denial:no_scope_covers_action',
        timestamp: 1715000000,
        scopeEvaluated: null,
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: true,
      },
    });
    lastCounterfactualProps = null;
  });

  it('Edit and re-evaluate button hidden when no finding is loaded', async () => {
    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    expect(screen.queryByTestId('tracer-counterfactual-button')).toBeNull();
  });

  it('Edit and re-evaluate button hidden for non-admin users', async () => {
    setMockIsAdmin(false);
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-pipeline-canvas')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tracer-counterfactual-button')).toBeNull();
  });

  it('Edit and re-evaluate button disabled while engine is loading', async () => {
    setMockEngine(true, null);
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });
    const btn = screen.getByTestId(
      'tracer-counterfactual-button',
    ) as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('Loading governance state');
  });

  it('Edit and re-evaluate button visible + enabled when admin, finding loaded, engine ready', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });
    const btn = screen.getByTestId(
      'tracer-counterfactual-button',
    ) as HTMLButtonElement;
    expect(btn).not.toBeDisabled();
  });

  it('Click → counterfactual panel opens', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-counterfactual-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('counterfactual-panel-mock')).toBeInTheDocument();
    });
  });

  it('After commit, canvas splits into baseline + alternative with diff banner', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(), // baseline: scope_match permit, terminal step 7
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-counterfactual-button'));
    });

    // The mocked panel captured the props — bubble a deterministic
    // alternative trace via the `onCommit` prop that mirrors a residual
    // denial (terminal step 4, decision deny) so the diff banner has
    // something material to surface.
    expect(lastCounterfactualProps).not.toBeNull();
    const alternativeTrace = {
      findingId: 'alt-1',
      finding: {
        findingId: 'alt-1',
        workflowId: 'wf-1',
        decision: 'deny',
        reason: 'residual_authority_denial:no_scope_covers_action',
        requestingAgent: 'agent-a',
        targetAgent: 'agent-b',
        scopeEvaluated: null,
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: true,
        timestamp: 1715000000,
      },
      steps: [
        makeStep(1, 'pass-through'),
        makeStep(2, 'pass-through'),
        makeStep(3, 'matched'),
        makeStep(4, 'denied'),
        makeStep(5, 'skipped'),
        makeStep(6, 'skipped'),
        makeStep(7, 'skipped'),
        makeStep(8, 'skipped'),
      ],
      terminalDecision: 'deny',
      terminalStepNumber: 4,
      reasonTokens: ['residual_authority_denial', 'no_scope_covers_action'],
      constitutionalOverride: false,
      arbitrationPattern: null,
      scopeReduction: null,
    };

    await act(async () => {
      lastCounterfactualProps.onCommit({
        request: {
          requestingAgentId: 'agent-a',
          targetAgentId: 'agent-b',
          actionType: 'invoke_agent',
          domain: 'compute',
          workflowId: 'wf-1',
          agentUseId: '',
          context: {},
          agentInput: {},
        },
        finding: alternativeTrace.finding,
        trace: alternativeTrace,
      });
    });

    // Both canvases render side-by-side.
    expect(screen.getByTestId('tracer-baseline-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('tracer-alternative-canvas')).toBeInTheDocument();

    // Diff banner present with terminal-changed marker (permit@7 → deny@4).
    const banner = screen.getByTestId('tracer-counterfactual-diff-banner');
    expect(banner.getAttribute('data-terminal-changed')).toBe('true');
    expect(
      screen.getByTestId('tracer-counterfactual-terminal-changed'),
    ).toBeInTheDocument();

    // Per-step diff for step 7 changed (permitted → skipped) and step 4
    // changed (pass-through → denied).
    const diff7 = screen.getByTestId('tracer-counterfactual-step-diff-7');
    expect(diff7.getAttribute('data-changed')).toBe('true');
    const diff4 = screen.getByTestId('tracer-counterfactual-step-diff-4');
    expect(diff4.getAttribute('data-changed')).toBe('true');
  });

  it('Clear counterfactual returns to single-pane view', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-counterfactual-button'));
    });

    const alternativeTrace = {
      findingId: 'alt-1',
      finding: {
        findingId: 'alt-1',
        workflowId: 'wf-1',
        decision: 'deny',
        reason: 'residual_authority_denial:no_scope_covers_action',
        requestingAgent: 'agent-a',
        targetAgent: 'agent-b',
        scopeEvaluated: null,
        contractEvaluated: null,
        escalationTarget: null,
        residualAuthorityDenial: true,
        timestamp: 1715000000,
      },
      steps: [
        makeStep(1, 'pass-through'),
        makeStep(2, 'pass-through'),
        makeStep(3, 'matched'),
        makeStep(4, 'denied'),
        makeStep(5, 'skipped'),
        makeStep(6, 'skipped'),
        makeStep(7, 'skipped'),
        makeStep(8, 'skipped'),
      ],
      terminalDecision: 'deny',
      terminalStepNumber: 4,
      reasonTokens: ['residual_authority_denial', 'no_scope_covers_action'],
      constitutionalOverride: false,
      arbitrationPattern: null,
      scopeReduction: null,
    };

    await act(async () => {
      lastCounterfactualProps.onCommit({
        request: {
          requestingAgentId: 'agent-a',
          targetAgentId: 'agent-b',
          actionType: 'invoke_agent',
          domain: 'compute',
          workflowId: 'wf-1',
          agentUseId: '',
          context: {},
          agentInput: {},
        },
        finding: alternativeTrace.finding,
        trace: alternativeTrace,
      });
    });

    // Alternative is showing.
    expect(screen.getByTestId('tracer-alternative-canvas')).toBeInTheDocument();

    // Clear.
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-counterfactual-clear'));
    });

    // Alternative gone, baseline still rendered.
    expect(screen.queryByTestId('tracer-alternative-canvas')).toBeNull();
    expect(screen.getByTestId('tracer-baseline-canvas')).toBeInTheDocument();
    expect(
      screen.queryByTestId('tracer-counterfactual-diff-banner'),
    ).toBeNull();
  });

  it('Edit and re-evaluate button hidden in live mode (no live-tail interaction)', async () => {
    mockSearchParams = new URLSearchParams('findingId=f-1');
    (governanceService.getDecisionTrace as jest.Mock).mockResolvedValue(
      makeTrace(),
    );
    (governanceService.subscribeGovernanceFindings as jest.Mock).mockImplementation(
      () => jest.fn(),
    );

    await act(async () => {
      render(React.createElement(GovernanceTracer));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tracer-counterfactual-button')).toBeInTheDocument();
    });

    // Toggle live on — button should disappear so the operator can't
    // run a counterfactual against a transient pinned finding.
    await act(async () => {
      fireEvent.click(screen.getByTestId('tracer-live-toggle'));
    });

    expect(screen.queryByTestId('tracer-counterfactual-button')).toBeNull();
  });
});
