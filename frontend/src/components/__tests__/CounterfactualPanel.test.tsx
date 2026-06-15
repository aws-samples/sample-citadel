/**
 * CounterfactualPanel tests.
 *
 * Mocks the shadcn Sheet primitives (which wrap Radix portals) so the
 * dialog renders inline in jsdom. Asserts:
 *   - Form renders pre-filled from the baseline finding.
 *   - Re-evaluate disabled when context / agentInput JSON is malformed.
 *   - Inline error chip appears on JSON parse failure.
 *   - Valid edits + Re-evaluate → engine.evaluate called → onCommit fires
 *     with the alternative request, finding, and decomposed trace.
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../ui/sheet', () => ({
  Sheet: ({ children, open }: any) =>
    open ? React.createElement('div', { role: 'dialog' }, children) : null,
  SheetContent: ({ children, className, ...rest }: any) =>
    React.createElement('div', { className, ...rest }, children),
  SheetHeader: ({ children }: any) =>
    React.createElement('div', null, children),
  SheetTitle: ({ children, ...rest }: any) =>
    React.createElement('h2', { ...rest }, children),
  SheetDescription: ({ children, ...rest }: any) =>
    React.createElement('p', { ...rest }, children),
}));

jest.mock('../ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../ui/input', () => ({
  Input: ({ id, value, onChange, disabled, ...rest }: any) =>
    React.createElement('input', { id, value, onChange, disabled, ...rest }),
}));

jest.mock('../ui/textarea', () => ({
  Textarea: ({ id, value, onChange, ...rest }: any) =>
    React.createElement('textarea', { id, value, onChange, ...rest }),
}));

jest.mock('../ui/label', () => ({
  Label: ({ children, htmlFor, ...rest }: any) =>
    React.createElement('label', { htmlFor, ...rest }, children),
}));

import {
  ArbitrationDecision,
  GovernanceEngine,
  type DispatchRequest,
  type GovernanceFinding as EngineFinding,
} from '@/lib/governance-engine';
import { CounterfactualPanel } from '../CounterfactualPanel';

function makeAlternativeFinding(
  overrides: Partial<EngineFinding> = {},
): EngineFinding {
  return {
    findingId: 'alt-finding',
    workflowId: 'wf-1',
    decision: ArbitrationDecision.PERMIT,
    requestingAgent: 'agent-a',
    targetAgent: 'agent-b',
    reason: 'scope_match:unit-alt',
    timestamp: 1_700_000_000,
    scopeEvaluated: 'unit-alt',
    contractEvaluated: null,
    escalationTarget: null,
    residualAuthorityDenial: false,
    ...overrides,
  };
}

function makeFakeEngine(
  capturedRequests: DispatchRequest[],
  alternative: EngineFinding,
): GovernanceEngine {
  // The CounterfactualPanel only needs `engine.evaluate`, so synthesise
  // a minimal stub typed as the GovernanceEngine class. Cast through
  // unknown to avoid implementing the full constructor.
  const stub = {
    evaluate: (request: DispatchRequest) => {
      capturedRequests.push(request);
      return alternative;
    },
  } as unknown as GovernanceEngine;
  return stub;
}

const baseline = {
  findingId: 'f-baseline',
  workflowId: 'wf-1',
  requestingAgent: 'agent-a',
  targetAgent: 'agent-b',
};

afterEach(() => {
  cleanup();
});

describe('CounterfactualPanel', () => {
  it('renders the form pre-filled from baselineFinding', async () => {
    const captured: DispatchRequest[] = [];
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: true,
          onOpenChange: jest.fn(),
          baselineFinding: baseline,
          engine: makeFakeEngine(captured, makeAlternativeFinding()),
          onCommit: jest.fn(),
        } as any),
      );
    });

    expect(
      (screen.getByTestId('counterfactual-requesting-agent') as HTMLInputElement)
        .value,
    ).toBe('agent-a');
    expect(
      (screen.getByTestId('counterfactual-target-agent') as HTMLInputElement)
        .value,
    ).toBe('agent-b');
    expect(
      (screen.getByTestId('counterfactual-workflow-id') as HTMLInputElement)
        .value,
    ).toBe('wf-1');
    // workflow + agent-use IDs are locked.
    expect(
      (screen.getByTestId('counterfactual-workflow-id') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('counterfactual-agent-use-id') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    // Default JSON fields.
    expect(
      (screen.getByTestId('counterfactual-context') as HTMLTextAreaElement)
        .value,
    ).toBe('{}');
    expect(
      (screen.getByTestId('counterfactual-agent-input') as HTMLTextAreaElement)
        .value,
    ).toBe('{}');
  });

  it('Re-evaluate disabled when context JSON is malformed; inline error shown', async () => {
    const captured: DispatchRequest[] = [];
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: true,
          onOpenChange: jest.fn(),
          baselineFinding: baseline,
          engine: makeFakeEngine(captured, makeAlternativeFinding()),
          onCommit: jest.fn(),
        } as any),
      );
    });

    const ctx = screen.getByTestId('counterfactual-context');
    fireEvent.change(ctx, { target: { value: '{not json' } });

    const reeval = screen.getByTestId(
      'counterfactual-reevaluate',
    ) as HTMLButtonElement;
    expect(reeval.disabled).toBe(true);

    expect(
      screen.getByTestId('counterfactual-context-error'),
    ).toBeInTheDocument();
  });

  it('Re-evaluate disabled when agentInput JSON is malformed', async () => {
    const captured: DispatchRequest[] = [];
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: true,
          onOpenChange: jest.fn(),
          baselineFinding: baseline,
          engine: makeFakeEngine(captured, makeAlternativeFinding()),
          onCommit: jest.fn(),
        } as any),
      );
    });

    const inp = screen.getByTestId('counterfactual-agent-input');
    fireEvent.change(inp, { target: { value: '[1, 2, 3]' } });

    const reeval = screen.getByTestId(
      'counterfactual-reevaluate',
    ) as HTMLButtonElement;
    // Arrays are JSON-parseable but the form requires an object — the
    // panel surfaces a parse error chip and disables the button.
    expect(reeval.disabled).toBe(true);
    expect(
      screen.getByTestId('counterfactual-agent-input-error'),
    ).toBeInTheDocument();
  });

  it('valid edits + Re-evaluate → engine.evaluate called → onCommit fires with trace', async () => {
    const captured: DispatchRequest[] = [];
    const onCommit = jest.fn();
    const onOpenChange = jest.fn();
    const alternative = makeAlternativeFinding({
      reason: 'rivalrous_claim:winner=agent-a:loser=agent-b:attenuation',
      contractEvaluated: 'contract-rivalrous',
    });
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: true,
          onOpenChange,
          baselineFinding: baseline,
          engine: makeFakeEngine(captured, alternative),
          onCommit,
        } as any),
      );
    });

    fireEvent.change(screen.getByTestId('counterfactual-action-type'), {
      target: { value: 'invoke_agent' },
    });
    fireEvent.change(screen.getByTestId('counterfactual-domain'), {
      target: { value: 'payment' },
    });
    fireEvent.change(screen.getByTestId('counterfactual-context'), {
      target: { value: '{"region":"us-east-1"}' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('counterfactual-reevaluate'));
    });

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    // engine.evaluate received the edited request.
    expect(captured).toHaveLength(1);
    expect(captured[0].actionType).toBe('invoke_agent');
    expect(captured[0].domain).toBe('payment');
    expect(captured[0].context).toEqual({ region: 'us-east-1' });
    expect(captured[0].agentInput).toEqual({});

    // onCommit received the alternative request, finding, and trace.
    const commit = onCommit.mock.calls[0][0];
    expect(commit.request.actionType).toBe('invoke_agent');
    expect(commit.finding).toBe(alternative);
    expect(commit.trace.terminalStepNumber).toBe(6);
    expect(commit.trace.arbitrationPattern).toBe('rivalrous_claim');
    expect(commit.trace.scopeReduction).toBe('attenuation');

    // Panel closes after a successful commit.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when open=false', async () => {
    const captured: DispatchRequest[] = [];
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: false,
          onOpenChange: jest.fn(),
          baselineFinding: baseline,
          engine: makeFakeEngine(captured, makeAlternativeFinding()),
          onCommit: jest.fn(),
        } as any),
      );
    });

    expect(screen.queryByTestId('counterfactual-panel')).not.toBeInTheDocument();
  });

  it('engine.evaluate throws → submit error rendered, onCommit not called', async () => {
    const onCommit = jest.fn();
    const failingEngine = {
      evaluate: () => {
        throw new Error('engine blew up');
      },
    } as unknown as GovernanceEngine;
    await act(async () => {
      render(
        React.createElement(CounterfactualPanel, {
          open: true,
          onOpenChange: jest.fn(),
          baselineFinding: baseline,
          engine: failingEngine,
          onCommit,
        } as any),
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('counterfactual-reevaluate'));
    });

    expect(
      screen.getByTestId('counterfactual-submit-error'),
    ).toHaveTextContent('engine blew up');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
