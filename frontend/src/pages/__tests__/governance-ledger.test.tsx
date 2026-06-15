/**
 * GovernanceLedger tests — custom-date-range picker (reviewer F1).
 *
 * Covers:
 *   1. Selecting `custom` reveals two date inputs.
 *   2. Setting from/to triggers a fetch with the correct `sinceTs`.
 *   3. from > to renders an inline error and prevents the fetch.
 *
 * The shadcn `Select` is mocked with a context-driven button so jsdom
 * (which has no pointer-event support for the Radix portal) can drive
 * the mode change.
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className }: any) =>
    React.createElement('div', { className, 'data-testid': 'page-container' }, children),
}));

jest.mock('../../components/ui/skeleton', () => ({
  Skeleton: ({ className }: any) =>
    React.createElement('div', { 'data-testid': 'skeleton', className }),
}));

jest.mock('../../components/ui/button', () => ({
  Button: ({ children, onClick, disabled, asChild, ...rest }: any) => {
    if (asChild) return children;
    return React.createElement('button', { onClick, disabled, ...rest }, children);
  },
}));

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className }, children),
}));

jest.mock('../../components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('../../components/ui/label', () => ({
  Label: ({ children, ...rest }: any) => React.createElement('label', rest, children),
}));

jest.mock('../../components/ui/sheet', () => ({
  Sheet: ({ children }: any) => React.createElement(React.Fragment, null, children),
  SheetContent: ({ children }: any) => React.createElement('div', null, children),
  SheetHeader: ({ children }: any) => React.createElement('div', null, children),
  SheetTitle: ({ children }: any) => React.createElement('div', null, children),
  SheetDescription: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('../../components/ui/table', () => ({
  Table: ({ children }: any) => React.createElement('table', null, children),
  TableBody: ({ children }: any) => React.createElement('tbody', null, children),
  TableCell: ({ children, ...rest }: any) =>
    React.createElement('td', rest, children),
  TableHead: ({ children }: any) => React.createElement('th', null, children),
  TableHeader: ({ children }: any) => React.createElement('thead', null, children),
  TableRow: ({ children, onClick }: any) =>
    React.createElement('tr', { onClick }, children),
}));

jest.mock('../../components/ui/select', () => {
  const ReactInside = require('react');
  const Ctx = ReactInside.createContext({
    value: undefined,
    onValueChange: () => {
      /* noop */
    },
  });
  return {
    Select: ({ value, onValueChange, children }: any) =>
      ReactInside.createElement(
        Ctx.Provider,
        { value: { value, onValueChange } },
        children,
      ),
    SelectTrigger: ({ children, className }: any) =>
      ReactInside.createElement('div', { className }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) =>
      ReactInside.createElement(ReactInside.Fragment, null, children),
    SelectItem: ({ value, children }: any) => {
      const ctx = ReactInside.useContext(Ctx);
      return ReactInside.createElement(
        'button',
        {
          type: 'button',
          role: 'option',
          'data-value': value,
          'data-active': ctx.value === value ? 'true' : 'false',
          onClick: () => ctx.onValueChange?.(value),
        },
        children,
      );
    },
  };
});

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listGovernanceFindings: jest.fn(),
    getGovernanceFinding: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceLedger } from '../../pages/governance/Ledger';

function pickRange(label: string) {
  // `Select` mocks render every SelectItem as a role="option" button. The
  // range options have unique labels (Last 24h / Last 7d / ... / Custom),
  // so a label match is enough.
  const all = screen.getAllByRole('option');
  const target = all.find((el) => el.textContent === label);
  if (!target) {
    throw new Error(`No SelectItem with text "${label}"`);
  }
  fireEvent.click(target);
}

describe('GovernanceLedger custom date range', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.listGovernanceFindings as jest.Mock).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it('reveals two date inputs when "Custom" is selected', async () => {
    await act(async () => {
      render(React.createElement(GovernanceLedger));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    // Default range is 24h — no date inputs yet.
    expect(screen.queryByTestId('ledger-custom-from')).toBeNull();
    expect(screen.queryByTestId('ledger-custom-to')).toBeNull();

    await act(async () => {
      pickRange('Custom');
    });

    expect(screen.getByTestId('ledger-custom-from')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-custom-to')).toBeInTheDocument();
  });

  it('refetches with sinceTs derived from the custom from-date', async () => {
    await act(async () => {
      render(React.createElement(GovernanceLedger));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    await act(async () => {
      pickRange('Custom');
    });

    // Discard the calls made up to and including the auto-seeded custom
    // range — we want to assert solely on the fetch triggered by the
    // user's explicit `from` change.
    (governanceService.listGovernanceFindings as jest.Mock).mockClear();

    const fromValue = '2026-05-01T00:00';
    const expectedSinceTs = Math.floor(new Date(fromValue).getTime() / 1000);

    await act(async () => {
      fireEvent.change(screen.getByTestId('ledger-custom-from'), {
        target: { value: fromValue },
      });
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    const calls = (governanceService.listGovernanceFindings as jest.Mock).mock.calls;
    const lastArgs = calls[calls.length - 1][0];
    expect(lastArgs.sinceTs).toBe(expectedSinceTs);
  });

  it('renders an inline error and skips the fetch when from > to', async () => {
    await act(async () => {
      render(React.createElement(GovernanceLedger));
    });

    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });

    await act(async () => {
      pickRange('Custom');
    });

    // Wait for the auto-seeded custom range to settle, then clear the
    // call log so we can prove the bad-range update yields zero new
    // service calls.
    await waitFor(() => {
      expect(governanceService.listGovernanceFindings).toHaveBeenCalled();
    });
    (governanceService.listGovernanceFindings as jest.Mock).mockClear();

    // Default `to` was seeded to "now". Push `from` forward so from > to.
    await act(async () => {
      fireEvent.change(screen.getByTestId('ledger-custom-from'), {
        target: { value: '2099-01-01T00:00' },
      });
    });

    expect(screen.getByTestId('ledger-custom-error')).toBeInTheDocument();
    expect(governanceService.listGovernanceFindings).not.toHaveBeenCalled();
  });
});
