/**
 * ModeFlipDialog tests.
 *
 * Mocks the governance service and the shadcn primitives that wrap Radix
 * portals (Dialog) so we can assert gate composition (typed match,
 * acknowledgement, OVERRIDE bypass), service args mapping, and the
 * error-vs-noop divergence in submission.
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

// shadcn Dialog wraps Radix Portal — render its children inline so jest can
// query the form widgets without a real DOM portal.
jest.mock('../ui/dialog', () => {
  const React = require('react');
  return {
    Dialog: ({ children, open }: any) =>
      open ? React.createElement('div', { role: 'dialog' }, children) : null,
    DialogContent: ({ children, ...rest }: any) =>
      React.createElement('div', { ...rest }, children),
    DialogHeader: ({ children }: any) =>
      React.createElement('div', null, children),
    DialogFooter: ({ children }: any) =>
      React.createElement('div', null, children),
    DialogTitle: ({ children, ...rest }: any) =>
      React.createElement('h2', { ...rest }, children),
    DialogDescription: ({ children, ...rest }: any) =>
      React.createElement('p', { ...rest }, children),
  };
});

jest.mock('../ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, ...rest }, children),
}));

jest.mock('../ui/input', () => ({
  Input: ({ onChange, value, ...rest }: any) =>
    React.createElement('input', { value, onChange, ...rest }),
}));

jest.mock('../ui/textarea', () => ({
  Textarea: ({ onChange, value, ...rest }: any) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}));

jest.mock('../ui/label', () => ({
  Label: ({ children, htmlFor, ...rest }: any) =>
    React.createElement('label', { htmlFor, ...rest }, children),
}));

jest.mock('../ui/alert', () => ({
  Alert: ({ children, ...rest }: any) =>
    React.createElement('div', { role: 'alert', ...rest }, children),
  AlertTitle: ({ children }: any) =>
    React.createElement('div', null, children),
  AlertDescription: ({ children }: any) =>
    React.createElement('div', null, children),
}));

// Render Checkbox as a real input[type=checkbox] so fireEvent.click works
// against it without simulating Radix internals.
jest.mock('../ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: any) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: !!checked,
      onChange: (e: any) => onCheckedChange?.(e.target.checked),
      ...rest,
    }),
}));

jest.mock('lucide-react', () => ({
  ArrowRight: () => React.createElement('span', { 'data-testid': 'arrow' }),
  Loader2: () => React.createElement('span', { 'data-testid': 'spinner' }),
}));

jest.mock('../../services/governanceService', () => {
  const actual = jest.requireActual('../../services/governanceService');
  return {
    ...actual,
    governanceService: {
      getRolloutReadiness: jest.fn(),
      setGovernanceMode: jest.fn(),
    },
    MODE_FLIP_ACKNOWLEDGEMENT_TEXT: actual.MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
  };
});

import {
  governanceService,
  MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
} from '../../services/governanceService';
import { ModeFlipDialog } from '../ModeFlipDialog';

const cleanReadiness = {
  generatedAt: 1715000000000,
  currentMode: 'permissive',
  effectiveAt: null,
  env: 'dev',
  shadowSoakStartedAt: null,
  checks: [
    {
      id: 'data-1',
      label: 'd1',
      status: 'PASS' as const,
      detail: null,
      evidence: null,
      category: 'data-integrity',
    },
  ],
  passCount: 1,
  failCount: 0,
  warnCount: 0,
  stubCount: 0,
};

const dirtyReadiness = {
  ...cleanReadiness,
  checks: [
    {
      id: 'data-1',
      label: 'd1',
      status: 'FAIL' as const,
      detail: null,
      evidence: null,
      category: 'data-integrity',
    },
    {
      id: 'tel-3',
      label: 't3',
      status: 'UNKNOWN' as const,
      detail: null,
      evidence: null,
      category: 'telemetry',
    },
  ],
  passCount: 0,
  failCount: 1,
  warnCount: 0,
  stubCount: 0,
};

const cleanSummary = {
  passCount: 1,
  failCount: 0,
  warnCount: 0,
  stubCount: 0,
};
const dirtySummary = {
  passCount: 0,
  failCount: 1,
  warnCount: 0,
  stubCount: 0,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof ModeFlipDialog>> = {}) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    currentMode: 'permissive',
    targetMode: 'shadow' as const,
    readinessSummary: cleanSummary,
    onConfirmed: jest.fn(),
    ...overrides,
  };
}

async function renderDialog(
  props: Partial<React.ComponentProps<typeof ModeFlipDialog>> = {},
) {
  await act(async () => {
    render(React.createElement(ModeFlipDialog, makeProps(props) as any));
  });
}

describe('ModeFlipDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      cleanReadiness,
    );
    (governanceService.setGovernanceMode as jest.Mock).mockResolvedValue({
      ok: true,
      previousMode: 'permissive',
      newMode: 'shadow',
      effectiveAt: '2026-05-19T00:00:00Z',
      noop: false,
      emittedEventDetailType: 'governance.mode.transition',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title with current → target mode', async () => {
    await renderDialog({ currentMode: 'permissive', targetMode: 'shadow' });

    expect(screen.getByTestId('mode-flip-dialog-current')).toHaveTextContent(
      'permissive',
    );
    expect(screen.getByTestId('mode-flip-dialog-target')).toHaveTextContent(
      'shadow',
    );
  });

  it('Confirm button starts disabled', async () => {
    await renderDialog();

    const confirm = screen.getByTestId('mode-flip-confirm') as HTMLButtonElement;
    expect(confirm).toBeDisabled();
  });

  it('typing wrong target name keeps Confirm disabled', async () => {
    await renderDialog({ targetMode: 'shadow' });

    const typed = screen.getByTestId('mode-flip-typed-input') as HTMLInputElement;
    fireEvent.change(typed, { target: { value: 'shado' } });
    const confirm = screen.getByTestId('mode-flip-confirm') as HTMLButtonElement;
    expect(confirm).toBeDisabled();
  });

  it('exact target + acknowledgement enables Confirm when readiness is clean', async () => {
    await renderDialog({ targetMode: 'shadow' });

    await waitFor(() => {
      expect(governanceService.getRolloutReadiness).toHaveBeenCalled();
    });

    const typed = screen.getByTestId('mode-flip-typed-input') as HTMLInputElement;
    fireEvent.change(typed, { target: { value: 'shadow' } });

    const ack = screen.getByTestId('mode-flip-ack-checkbox') as HTMLInputElement;
    fireEvent.click(ack);

    const confirm = screen.getByTestId('mode-flip-confirm') as HTMLButtonElement;
    expect(confirm).not.toBeDisabled();
  });

  it('failCount > 0 disables Confirm and shows the OVERRIDE field', async () => {
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      dirtyReadiness,
    );

    await renderDialog({ targetMode: 'shadow', readinessSummary: dirtySummary });

    await waitFor(() => {
      expect(
        screen.getByTestId('mode-flip-readiness-warning'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('mode-flip-override-input')).toBeInTheDocument();

    // Fill typed + ack so only the readiness gate blocks Confirm.
    fireEvent.change(screen.getByTestId('mode-flip-typed-input'), {
      target: { value: 'shadow' },
    });
    fireEvent.click(screen.getByTestId('mode-flip-ack-checkbox'));
    expect(
      screen.getByTestId('mode-flip-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('typing OVERRIDE re-enables Confirm in fail branch', async () => {
    (governanceService.getRolloutReadiness as jest.Mock).mockResolvedValue(
      dirtyReadiness,
    );

    await renderDialog({ targetMode: 'shadow', readinessSummary: dirtySummary });

    await waitFor(() => {
      expect(
        screen.getByTestId('mode-flip-readiness-warning'),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mode-flip-override-input'), {
      target: { value: 'OVERRIDE' },
    });
    fireEvent.change(screen.getByTestId('mode-flip-typed-input'), {
      target: { value: 'shadow' },
    });
    fireEvent.click(screen.getByTestId('mode-flip-ack-checkbox'));

    expect(
      screen.getByTestId('mode-flip-confirm') as HTMLButtonElement,
    ).not.toBeDisabled();
  });

  it('Confirm calls service with the verbatim acknowledgement constant and target mode', async () => {
    const onConfirmed = jest.fn();
    await renderDialog({ targetMode: 'shadow', onConfirmed });

    await waitFor(() => {
      expect(governanceService.getRolloutReadiness).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId('mode-flip-typed-input'), {
      target: { value: 'shadow' },
    });
    fireEvent.click(screen.getByTestId('mode-flip-ack-checkbox'));
    fireEvent.change(screen.getByTestId('mode-flip-reason-input'), {
      target: { value: 'soak start' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mode-flip-confirm'));
    });

    expect(governanceService.setGovernanceMode).toHaveBeenCalledTimes(1);
    expect(governanceService.setGovernanceMode).toHaveBeenCalledWith({
      targetMode: 'shadow',
      acknowledgement: MODE_FLIP_ACKNOWLEDGEMENT_TEXT,
      reason: 'soak start',
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, newMode: 'shadow' }),
    );
  });

  it('service throws → error rendered inline; dialog stays open', async () => {
    (governanceService.setGovernanceMode as jest.Mock).mockRejectedValue(
      new Error('SSM enforce write failed'),
    );
    const onOpenChange = jest.fn();
    const onConfirmed = jest.fn();
    await renderDialog({
      targetMode: 'shadow',
      onOpenChange,
      onConfirmed,
    });

    await waitFor(() => {
      expect(governanceService.getRolloutReadiness).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId('mode-flip-typed-input'), {
      target: { value: 'shadow' },
    });
    fireEvent.click(screen.getByTestId('mode-flip-ack-checkbox'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('mode-flip-confirm'));
    });

    expect(screen.getByTestId('mode-flip-submit-error')).toBeInTheDocument();
    expect(screen.getByTestId('mode-flip-submit-error')).toHaveTextContent(
      'SSM enforce write failed',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('service noop result is delivered to onConfirmed', async () => {
    (governanceService.setGovernanceMode as jest.Mock).mockResolvedValue({
      ok: true,
      previousMode: 'shadow',
      newMode: 'shadow',
      effectiveAt: '2026-05-01T00:00:00Z',
      noop: true,
      emittedEventDetailType: null,
    });
    const onConfirmed = jest.fn();
    await renderDialog({
      currentMode: 'shadow',
      targetMode: 'shadow',
      onConfirmed,
    });

    await waitFor(() => {
      expect(governanceService.getRolloutReadiness).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId('mode-flip-typed-input'), {
      target: { value: 'shadow' },
    });
    fireEvent.click(screen.getByTestId('mode-flip-ack-checkbox'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('mode-flip-confirm'));
    });

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ noop: true, newMode: 'shadow' }),
    );
  });
});
