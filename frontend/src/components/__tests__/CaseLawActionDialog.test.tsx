/**
 * CaseLawActionDialog tests.
 *
 * Mocks the governance service and the shadcn primitives that wrap Radix
 * portals so we can assert gate composition (typed-match for revoke /
 * unrevoke; integer-range + delta for update-precedence; acknowledgement
 * across all modes), service args mapping, error handling, and the
 * success path.
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
  Loader2: () => React.createElement('span', { 'data-testid': 'spinner' }),
}));

jest.mock('../../services/governanceService', () => {
  const actual = jest.requireActual('../../services/governanceService');
  return {
    ...actual,
    governanceService: {
      revokeCaseLaw: jest.fn(),
      unrevokeCaseLaw: jest.fn(),
      updateCaseLawPrecedence: jest.fn(),
    },
    CASELAW_ACKNOWLEDGEMENT_TEXT: actual.CASELAW_ACKNOWLEDGEMENT_TEXT,
  };
});

import {
  governanceService,
  CASELAW_ACKNOWLEDGEMENT_TEXT,
  CaseLawEntry,
  CaseLawMutationResult,
} from '../../services/governanceService';
import { CaseLawActionDialog } from '../CaseLawActionDialog';

const entry: CaseLawEntry = {
  caseId: 'case-1',
  pattern: JSON.stringify({ agent: 'a', target: 'b' }),
  resolution: 'permit',
  encodedAt: '2026-05-01T10:00:00.000Z',
  encodedBy: 'operator@acme.com',
  scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
  precedence: 5,
  revoked: false,
};

const successRevokeResult: CaseLawMutationResult = {
  ok: true,
  caseId: 'case-1',
  action: 'revoke',
  entry: { ...entry, revoked: true },
  emittedEventDetailType: 'governance.caselaw.changed',
};

function makeProps(
  overrides: Partial<React.ComponentProps<typeof CaseLawActionDialog>> = {},
) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    mode: 'revoke' as const,
    entry,
    onCommitted: jest.fn(),
    ...overrides,
  };
}

async function renderDialog(
  props: Partial<React.ComponentProps<typeof CaseLawActionDialog>> = {},
) {
  await act(async () => {
    render(React.createElement(CaseLawActionDialog, makeProps(props) as any));
  });
}

describe('CaseLawActionDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.revokeCaseLaw as jest.Mock).mockResolvedValue(
      successRevokeResult,
    );
    (governanceService.unrevokeCaseLaw as jest.Mock).mockResolvedValue({
      ...successRevokeResult,
      action: 'unrevoke',
      entry: { ...entry, revoked: false },
    });
    (governanceService.updateCaseLawPrecedence as jest.Mock).mockResolvedValue(
      {
        ...successRevokeResult,
        action: 'update-precedence',
        entry: { ...entry, precedence: 42 },
      },
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('revoke mode: Confirm starts disabled (no typed match, no acknowledgement)', async () => {
    await renderDialog({ mode: 'revoke' });

    const confirm = screen.getByTestId(
      'case-law-action-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();
  });

  it('revoke mode: title references caseId', async () => {
    await renderDialog({ mode: 'revoke' });

    expect(screen.getByTestId('case-law-action-title')).toHaveTextContent(
      'Revoke case-law entry case-1',
    );
  });

  it('revoke mode: typed-match REVOKE + acknowledgement enables Confirm', async () => {
    await renderDialog({ mode: 'revoke' });

    const typedMatch = screen.getByTestId(
      'case-law-action-typed-match',
    ) as HTMLInputElement;
    fireEvent.change(typedMatch, { target: { value: 'REVOKE' } });

    const confirm = screen.getByTestId(
      'case-law-action-confirm',
    ) as HTMLButtonElement;
    // Still disabled — acknowledgement not yet ticked.
    expect(confirm).toBeDisabled();

    const ack = screen.getByTestId(
      'case-law-action-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    expect(confirm).not.toBeDisabled();
  });

  it('revoke mode: lowercase revoke does not unlock Confirm', async () => {
    await renderDialog({ mode: 'revoke' });

    fireEvent.change(
      screen.getByTestId('case-law-action-typed-match') as HTMLInputElement,
      { target: { value: 'revoke' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    expect(
      screen.getByTestId('case-law-action-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('revoke mode: confirms call revokeCaseLaw with caseId + reason', async () => {
    await renderDialog({ mode: 'revoke' });

    fireEvent.change(
      screen.getByTestId('case-law-action-typed-match') as HTMLInputElement,
      { target: { value: 'REVOKE' } },
    );
    fireEvent.change(
      screen.getByTestId('case-law-action-reason') as HTMLTextAreaElement,
      { target: { value: 'precedent-superseded' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    await act(async () => {
      (
        screen.getByTestId('case-law-action-confirm') as HTMLButtonElement
      ).click();
    });

    expect(governanceService.revokeCaseLaw).toHaveBeenCalledWith(
      'case-1',
      'precedent-superseded',
    );
  });

  it('unrevoke mode: title references caseId; typed-match RESTORE + acknowledgement enables Confirm', async () => {
    await renderDialog({
      mode: 'unrevoke',
      entry: { ...entry, revoked: true },
    });

    expect(screen.getByTestId('case-law-action-title')).toHaveTextContent(
      'Restore revoked case-law entry case-1',
    );

    const confirm = screen.getByTestId(
      'case-law-action-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();

    const typedMatch = screen.getByTestId(
      'case-law-action-typed-match',
    ) as HTMLInputElement;
    fireEvent.change(typedMatch, { target: { value: 'RESTORE' } });

    expect(confirm).toBeDisabled();

    const ack = screen.getByTestId(
      'case-law-action-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    expect(confirm).not.toBeDisabled();

    await act(async () => {
      confirm.click();
    });

    expect(governanceService.unrevokeCaseLaw).toHaveBeenCalledWith(
      'case-1',
      null,
    );
  });

  it('update-precedence mode: number outside [-1000, 1000] disables Confirm', async () => {
    await renderDialog({ mode: 'update-precedence' });

    const newPrec = screen.getByTestId(
      'case-law-action-new-precedence',
    ) as HTMLInputElement;
    // Set out-of-range value first.
    fireEvent.change(newPrec, { target: { value: '5000' } });

    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    expect(
      screen.getByTestId('case-law-action-confirm') as HTMLButtonElement,
    ).toBeDisabled();
    expect(
      screen.getByTestId('case-law-action-precedence-error'),
    ).toBeInTheDocument();
  });

  it('update-precedence mode: same value as current precedence disables Confirm', async () => {
    await renderDialog({
      mode: 'update-precedence',
      entry: { ...entry, precedence: 5 },
    });

    // Number input pre-fills with the current precedence (5).
    const newPrec = screen.getByTestId(
      'case-law-action-new-precedence',
    ) as HTMLInputElement;
    expect(newPrec.value).toBe('5');

    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    // Acknowledgement on its own is not enough — value must differ.
    expect(
      screen.getByTestId('case-law-action-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('update-precedence mode: valid new precedence + acknowledgement enables Confirm and calls service', async () => {
    await renderDialog({
      mode: 'update-precedence',
      entry: { ...entry, precedence: 5 },
    });

    fireEvent.change(
      screen.getByTestId(
        'case-law-action-new-precedence',
      ) as HTMLInputElement,
      { target: { value: '42' } },
    );

    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    const confirm = screen.getByTestId(
      'case-law-action-confirm',
    ) as HTMLButtonElement;
    expect(confirm).not.toBeDisabled();

    await act(async () => {
      confirm.click();
    });

    expect(
      governanceService.updateCaseLawPrecedence,
    ).toHaveBeenCalledWith('case-1', 42, null);
  });

  it('update-precedence mode: non-integer (e.g. 3.14) disables Confirm', async () => {
    await renderDialog({ mode: 'update-precedence' });

    fireEvent.change(
      screen.getByTestId(
        'case-law-action-new-precedence',
      ) as HTMLInputElement,
      { target: { value: '3.14' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    expect(
      screen.getByTestId('case-law-action-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('service throws → inline error renders, dialog stays open', async () => {
    (governanceService.revokeCaseLaw as jest.Mock).mockRejectedValue(
      new Error('Case-law entry not found: case-1'),
    );
    const onOpenChange = jest.fn();

    await renderDialog({ mode: 'revoke', onOpenChange });

    fireEvent.change(
      screen.getByTestId('case-law-action-typed-match') as HTMLInputElement,
      { target: { value: 'REVOKE' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    await act(async () => {
      (
        screen.getByTestId('case-law-action-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-action-error'),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId('case-law-action-error')).toHaveTextContent(
      'Case-law entry not found',
    );
    // Dialog stays open — onOpenChange MUST NOT be called with false.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('successful commit calls onCommitted and closes the dialog', async () => {
    const onCommitted = jest.fn();
    const onOpenChange = jest.fn();

    await renderDialog({ mode: 'revoke', onCommitted, onOpenChange });

    fireEvent.change(
      screen.getByTestId('case-law-action-typed-match') as HTMLInputElement,
      { target: { value: 'REVOKE' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    await act(async () => {
      (
        screen.getByTestId('case-law-action-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledTimes(1);
    });
    expect(onCommitted).toHaveBeenCalledWith(successRevokeResult);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('acknowledgement label matches the exported constant verbatim', async () => {
    await renderDialog({ mode: 'revoke' });

    const label = screen.getByTestId('case-law-action-ack-label');
    expect(label).toHaveTextContent(CASELAW_ACKNOWLEDGEMENT_TEXT);
  });

  it('disables Confirm and renders spinner while service call is in flight', async () => {
    let resolveCall: (v: any) => void = () => undefined;
    (governanceService.revokeCaseLaw as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    await renderDialog({ mode: 'revoke' });

    fireEvent.change(
      screen.getByTestId('case-law-action-typed-match') as HTMLInputElement,
      { target: { value: 'REVOKE' } },
    );
    fireEvent.click(
      screen.getByTestId('case-law-action-ack-checkbox') as HTMLInputElement,
    );

    const confirm = screen.getByTestId(
      'case-law-action-confirm',
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });

    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();

    await act(async () => {
      resolveCall(successRevokeResult);
    });
  });
});
