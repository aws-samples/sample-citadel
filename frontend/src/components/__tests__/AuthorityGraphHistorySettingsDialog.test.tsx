/**
 * AuthorityGraphHistorySettingsDialog tests.
 *
 * Mocks the governance service and the shadcn primitives that wrap
 * Radix portals so we can assert the gates (acknowledgement +
 * has-changes), capture-mode disabled-with-tooltip semantics,
 * service args mapping, error handling, and the success path.
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

jest.mock('../ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: any) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: !!checked,
      onChange: (e: any) => onCheckedChange?.(e.target.checked),
      ...rest,
    }),
}));

jest.mock('../ui/switch', () => ({
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

// Select primitive — render as a native <select> so we can drive the
// value via fireEvent.change. Each SelectItem renders as <option> with
// disabled passed through; we expose data-disabled-reason on disabled
// items so a test can assert the tooltip text.
jest.mock('../ui/select', () => ({
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
  SelectItem: ({ value, children, disabled, ...rest }: any) =>
    React.createElement(
      'option',
      { value, disabled, ...rest },
      children,
    ),
}));

// Tooltip primitives — render the trigger inline and surface the
// content as a sibling so the test can assert the reason string is in
// the DOM next to the disabled option.
jest.mock('../ui/tooltip', () => {
  const React = require('react');
  return {
    TooltipProvider: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    Tooltip: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    TooltipTrigger: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    TooltipContent: ({ children }: any) =>
      React.createElement(
        'span',
        { 'data-testid': 'tooltip-content' },
        children,
      ),
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
      updateAuthorityGraphHistorySettings: jest.fn(),
    },
    AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT:
      actual.AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
  };
});

import {
  governanceService,
  AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
  AuthorityGraphHistorySettings,
  AuthorityGraphHistorySettingsResult,
} from '../../services/governanceService';
import { AuthorityGraphHistorySettingsDialog } from '../AuthorityGraphHistorySettingsDialog';

const settings: AuthorityGraphHistorySettings = {
  enabled: false,
  retentionDays: 30,
  captureMode: 'daily',
  lastSnapshotAt: null,
  snapshotCountInWindow: 0,
  storageEstimate: '—',
};

const successResult: AuthorityGraphHistorySettingsResult = {
  ok: true,
  settings: { ...settings, enabled: true, retentionDays: 90 },
  emittedEventDetailType: 'governance.authority-graph-history.config.changed',
};

function makeProps(
  overrides: Partial<
    React.ComponentProps<typeof AuthorityGraphHistorySettingsDialog>
  > = {},
) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    currentSettings: settings,
    onSaved: jest.fn(),
    ...overrides,
  };
}

async function renderDialog(
  props: Partial<
    React.ComponentProps<typeof AuthorityGraphHistorySettingsDialog>
  > = {},
) {
  await act(async () => {
    render(
      React.createElement(
        AuthorityGraphHistorySettingsDialog,
        makeProps(props) as any,
      ),
    );
  });
}

describe('AuthorityGraphHistorySettingsDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      governanceService.updateAuthorityGraphHistorySettings as jest.Mock
    ).mockResolvedValue(successResult);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders current settings as initial values', async () => {
    await renderDialog({
      currentSettings: {
        ...settings,
        enabled: true,
        retentionDays: 90,
      },
    });

    const enabledSwitch = screen.getByTestId(
      'authority-graph-history-enabled-switch',
    ) as HTMLInputElement;
    expect(enabledSwitch.checked).toBe(true);

    // The retention <select> has value='90' as a stringified number.
    const selects = document.querySelectorAll('select');
    const retentionSelect = Array.from(selects).find(
      (s) => (s as HTMLSelectElement).value === '90',
    );
    expect(retentionSelect).toBeTruthy();
  });

  it('Confirm button stays disabled until acknowledgement AND any change', async () => {
    await renderDialog();

    const confirm = screen.getByTestId(
      'authority-graph-history-confirm',
    ) as HTMLButtonElement;
    // No change yet, no ack → disabled.
    expect(confirm).toBeDisabled();

    // Tick acknowledgement. Still no change → disabled.
    const ack = screen.getByTestId(
      'authority-graph-history-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);
    expect(confirm).toBeDisabled();

    // Flip the Enabled switch — now there's a change AND ack ticked.
    const enabledSwitch = screen.getByTestId(
      'authority-graph-history-enabled-switch',
    ) as HTMLInputElement;
    fireEvent.click(enabledSwitch);
    expect(confirm).not.toBeDisabled();
  });

  it("captureMode 'on-change' and 'both' options are rendered as enabled", async () => {
    await renderDialog();

    const onChangeOpt = screen.getByTestId(
      'authority-graph-history-capture-mode-option-on-change',
    ) as HTMLOptionElement;
    expect(onChangeOpt).not.toBeDisabled();
    expect(onChangeOpt.getAttribute('data-disabled-reason')).toBeNull();

    const bothOpt = screen.getByTestId(
      'authority-graph-history-capture-mode-option-both',
    ) as HTMLOptionElement;
    expect(bothOpt).not.toBeDisabled();
    expect(bothOpt.getAttribute('data-disabled-reason')).toBeNull();
  });

  it('retentionDays Select is limited to the allowlist (7 / 30 / 90 / 365)', async () => {
    await renderDialog();

    expect(
      screen.getByTestId('authority-graph-history-retention-option-7'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('authority-graph-history-retention-option-30'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('authority-graph-history-retention-option-90'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('authority-graph-history-retention-option-365'),
    ).toBeInTheDocument();

    // No 14-day option, no 60-day option.
    expect(
      screen.queryByTestId('authority-graph-history-retention-option-14'),
    ).toBeNull();
    expect(
      screen.queryByTestId('authority-graph-history-retention-option-60'),
    ).toBeNull();
  });

  it('Confirm calls service with correct args + auto-injected acknowledgement constant', async () => {
    const onSaved = jest.fn();
    await renderDialog({ onSaved });

    // Flip on, change retention to 90, tick ack.
    fireEvent.click(
      screen.getByTestId('authority-graph-history-enabled-switch'),
    );

    // Find the retention <select>. The capture-mode select might also
    // exist — pick the one whose options include retention values.
    const selects = Array.from(document.querySelectorAll('select'));
    const retentionSelect = selects.find((s) =>
      Array.from((s as HTMLSelectElement).options).some(
        (o) => o.value === '7',
      ),
    ) as HTMLSelectElement;
    fireEvent.change(retentionSelect, { target: { value: '90' } });

    fireEvent.click(
      screen.getByTestId('authority-graph-history-ack-checkbox'),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-confirm'),
      );
    });

    await waitFor(() => {
      expect(
        governanceService.updateAuthorityGraphHistorySettings,
      ).toHaveBeenCalledTimes(1);
    });
    const args = (
      governanceService.updateAuthorityGraphHistorySettings as jest.Mock
    ).mock.calls[0][0];
    expect(args.enabled).toBe(true);
    expect(args.retentionDays).toBe(90);
    expect(args.captureMode).toBe('daily');
    expect(args.reason).toBeNull();

    // The service auto-injects the ack — but we still verify the
    // constant export equals the verbatim string.
    expect(AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT).toBe(
      'I understand this changes governance history retention and storage costs',
    );

    // onSaved + dialog close.
    expect(onSaved).toHaveBeenCalledWith(successResult);
  });

  it("Confirm passes captureMode='on-change' through to the service", async () => {
    await renderDialog();

    // Pick the capture-mode <select>: it has the 'daily' option but
    // NOT a numeric '7' option (that's the retention select).
    const selects = Array.from(document.querySelectorAll('select'));
    const captureSelect = selects.find((s) => {
      const opts = Array.from((s as HTMLSelectElement).options);
      return (
        opts.some((o) => o.value === 'daily') &&
        !opts.some((o) => o.value === '7')
      );
    }) as HTMLSelectElement;
    fireEvent.change(captureSelect, { target: { value: 'on-change' } });

    fireEvent.click(
      screen.getByTestId('authority-graph-history-ack-checkbox'),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-confirm'),
      );
    });

    await waitFor(() => {
      expect(
        governanceService.updateAuthorityGraphHistorySettings,
      ).toHaveBeenCalledTimes(1);
    });
    const args = (
      governanceService.updateAuthorityGraphHistorySettings as jest.Mock
    ).mock.calls[0][0];
    expect(args.captureMode).toBe('on-change');
  });

  it("Confirm passes captureMode='both' through to the service", async () => {
    await renderDialog();

    const selects = Array.from(document.querySelectorAll('select'));
    const captureSelect = selects.find((s) => {
      const opts = Array.from((s as HTMLSelectElement).options);
      return (
        opts.some((o) => o.value === 'daily') &&
        !opts.some((o) => o.value === '7')
      );
    }) as HTMLSelectElement;
    fireEvent.change(captureSelect, { target: { value: 'both' } });

    fireEvent.click(
      screen.getByTestId('authority-graph-history-ack-checkbox'),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-confirm'),
      );
    });

    await waitFor(() => {
      expect(
        governanceService.updateAuthorityGraphHistorySettings,
      ).toHaveBeenCalledTimes(1);
    });
    const args = (
      governanceService.updateAuthorityGraphHistorySettings as jest.Mock
    ).mock.calls[0][0];
    expect(args.captureMode).toBe('both');
  });

  it('service throws → renders inline error and stays open', async () => {
    (
      governanceService.updateAuthorityGraphHistorySettings as jest.Mock
    ).mockRejectedValue(new Error('SSM put failed'));
    const onOpenChange = jest.fn();
    await renderDialog({ onOpenChange });

    fireEvent.click(
      screen.getByTestId('authority-graph-history-enabled-switch'),
    );
    fireEvent.click(
      screen.getByTestId('authority-graph-history-ack-checkbox'),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-confirm'),
      );
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('authority-graph-history-error'),
      ).toHaveTextContent('SSM put failed');
    });
    // Dialog did NOT close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('storage estimate updates as enabled/retention change', async () => {
    await renderDialog();
    const estimate = () =>
      screen.getByTestId('authority-graph-history-storage-estimate')
        .textContent ?? '';

    // Disabled → 0 snapshots.
    expect(estimate()).toMatch(/~0 snapshots/);

    fireEvent.click(
      screen.getByTestId('authority-graph-history-enabled-switch'),
    );
    // Default retentionDays is 30 → ~30 snapshots.
    expect(estimate()).toMatch(/~30 snapshots/);

    const selects = Array.from(document.querySelectorAll('select'));
    const retentionSelect = selects.find((s) =>
      Array.from((s as HTMLSelectElement).options).some(
        (o) => o.value === '7',
      ),
    ) as HTMLSelectElement;
    fireEvent.change(retentionSelect, { target: { value: '7' } });
    expect(estimate()).toMatch(/~7 snapshots/);
    expect(estimate()).toMatch(/~56KB/);
  });

  it('successful save closes the dialog (onOpenChange called with false)', async () => {
    const onOpenChange = jest.fn();
    await renderDialog({ onOpenChange });

    fireEvent.click(
      screen.getByTestId('authority-graph-history-enabled-switch'),
    );
    fireEvent.click(
      screen.getByTestId('authority-graph-history-ack-checkbox'),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByTestId('authority-graph-history-confirm'),
      );
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
