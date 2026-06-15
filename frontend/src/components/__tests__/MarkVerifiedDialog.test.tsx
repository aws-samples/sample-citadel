/**
 * MarkVerifiedDialog tests.
 *
 * Mocks the governance service and the shadcn primitives that wrap Radix
 * portals (Dialog / Select) so we can assert title rendering, default day
 * selection, service argument plumbing, loading state, error handling,
 * and the success callback.
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

// shadcn Select is Radix-based; flatten to a native <select> so test code
// can change the value via fireEvent.change without portals or pointer
// events.
jest.mock('../ui/select', () => {
  const React = require('react');
  return {
    Select: ({ value, onValueChange, children, disabled }: any) =>
      React.createElement(
        'select',
        {
          'data-testid': 'select-mock',
          value,
          disabled,
          onChange: (e: any) => onValueChange?.(e.target.value),
        },
        children,
      ),
    SelectTrigger: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({ children, value, ...rest }: any) =>
      React.createElement('option', { value, ...rest }, children),
  };
});

jest.mock('lucide-react', () => ({
  Loader2: () => React.createElement('span', { 'data-testid': 'spinner' }),
}));

jest.mock('../../services/governanceService', () => {
  const actual = jest.requireActual('../../services/governanceService');
  return {
    ...actual,
    governanceService: {
      markReadinessCheckVerified: jest.fn(),
    },
  };
});

import { governanceService } from '../../services/governanceService';
import { MarkVerifiedDialog } from '../MarkVerifiedDialog';

function makeProps(
  overrides: Partial<React.ComponentProps<typeof MarkVerifiedDialog>> = {},
) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    checkId: 'tel-1',
    checkLabel: 'governance-gate-decisions dashboard shows ≥7 days of shadow traffic',
    onVerified: jest.fn(),
    ...overrides,
  };
}

async function renderDialog(
  props: Partial<React.ComponentProps<typeof MarkVerifiedDialog>> = {},
) {
  await act(async () => {
    render(React.createElement(MarkVerifiedDialog, makeProps(props) as any));
  });
}

describe('MarkVerifiedDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.markReadinessCheckVerified as jest.Mock).mockResolvedValue({
      ok: true,
      checkId: 'tel-1',
      verifiedAt: '2026-05-19T08:00:00.000Z',
      expiresAt: '2026-05-26T08:00:00.000Z',
      verifiedBy: 'sub-1',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title with the check label', async () => {
    await renderDialog({
      checkId: 'own-1',
      checkLabel: 'On-call runbook entry updated',
    });

    expect(screen.getByTestId('mark-verified-dialog-title')).toHaveTextContent(
      'Mark verified: On-call runbook entry updated',
    );
  });

  it('default verification window is 7 days', async () => {
    await renderDialog();

    const select = screen.getByTestId('select-mock') as HTMLSelectElement;
    expect(select.value).toBe('7');
  });

  it('Confirm calls service with checkId, expiresInDays and trimmed note', async () => {
    await renderDialog({ checkId: 'tel-2', checkLabel: 'tel-2 label' });

    // Change the days select to 30.
    const select = screen.getByTestId('select-mock') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '30' } });

    // Add a note (with surrounding whitespace, to assert trim()).
    const note = screen.getByTestId('mark-verified-note') as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: '  paged Bob in #ops  ' } });

    await act(async () => {
      (
        screen.getByTestId('mark-verified-confirm') as HTMLButtonElement
      ).click();
    });

    expect(governanceService.markReadinessCheckVerified).toHaveBeenCalledTimes(1);
    expect(governanceService.markReadinessCheckVerified).toHaveBeenCalledWith({
      checkId: 'tel-2',
      expiresInDays: 30,
      note: 'paged Bob in #ops',
    });
  });

  it('passes note: null when the textarea is empty / whitespace only', async () => {
    await renderDialog();

    const note = screen.getByTestId('mark-verified-note') as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: '   ' } });

    await act(async () => {
      (
        screen.getByTestId('mark-verified-confirm') as HTMLButtonElement
      ).click();
    });

    const args = (
      governanceService.markReadinessCheckVerified as jest.Mock
    ).mock.calls[0][0];
    expect(args.note).toBeNull();
  });

  it('disables Confirm and shows the spinner while the service call is in flight', async () => {
    let resolveCall: (v: any) => void = () => undefined;
    (governanceService.markReadinessCheckVerified as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    await renderDialog();

    const confirm = screen.getByTestId(
      'mark-verified-confirm',
    ) as HTMLButtonElement;
    expect(confirm).not.toBeDisabled();

    await act(async () => {
      confirm.click();
    });

    // Now in flight — confirm + cancel disabled, spinner visible.
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(
      screen.getByTestId('mark-verified-cancel') as HTMLButtonElement,
    ).toBeDisabled();

    // Settle the promise.
    await act(async () => {
      resolveCall({
        ok: true,
        checkId: 'tel-1',
        verifiedAt: '2026-05-19T08:00:00.000Z',
        expiresAt: '2026-05-26T08:00:00.000Z',
        verifiedBy: 'sub-1',
      });
    });
  });

  it('renders an inline error and keeps the dialog open when service throws', async () => {
    (governanceService.markReadinessCheckVerified as jest.Mock).mockRejectedValue(
      new Error('Check ID not in manual-verification allowlist: data-1'),
    );
    const onOpenChange = jest.fn();

    await renderDialog({ onOpenChange });

    await act(async () => {
      (
        screen.getByTestId('mark-verified-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('mark-verified-error')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('mark-verified-error'),
    ).toHaveTextContent('not in manual-verification allowlist');
    // onOpenChange MUST NOT have been called with false — the dialog stays open
    // so the operator can retry without losing typed values.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('on success, calls onVerified with the result and closes the dialog', async () => {
    const onVerified = jest.fn();
    const onOpenChange = jest.fn();
    const result = {
      ok: true,
      checkId: 'tel-1',
      verifiedAt: '2026-05-19T08:00:00.000Z',
      expiresAt: '2026-05-26T08:00:00.000Z',
      verifiedBy: 'sub-1',
    };
    (governanceService.markReadinessCheckVerified as jest.Mock).mockResolvedValue(result);

    await renderDialog({ onVerified, onOpenChange });

    await act(async () => {
      (
        screen.getByTestId('mark-verified-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    expect(onVerified).toHaveBeenCalledWith(result);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
