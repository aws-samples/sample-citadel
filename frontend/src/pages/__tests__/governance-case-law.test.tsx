/**
 * GovernanceCaseLaw tests.
 *
 * Mocks the governance service, OrganizationContext, and the shadcn
 * primitives used by the page (Switch, Select, Tooltip, Badge, Button,
 * Skeleton) so the assertions stay focused on composition logic without
 * dragging Radix portal mechanics into the test surface.
 *
 * Tests cover:
 *   - Non-admin renders empty state, no fetch
 *   - Admin fetches listCaseLaw on mount
 *   - Renders cards in precedence-descending order (server already
 *     sorts; the page just renders)
 *   - Resolution Select filters out non-matching entries
 *   - Include-revoked toggle re-fetches with the flag
 *   - Pattern + scope-of-applicability JSON expand/collapse
 * - Revoke + Edit-precedence buttons disabled with tooltips
 *   - Empty state renders when no entries
 *   - localStorage persists the include-revoked toggle
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../components/PageContainer', () => ({
  PageContainer: ({ children, className, ...rest }: any) =>
    React.createElement(
      'div',
      { className, 'data-testid': 'page-container', ...rest },
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

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, className, variant, ...rest }: any) =>
    React.createElement(
      'span',
      { 'data-variant': variant, className, ...rest },
      children,
    ),
}));

jest.mock('../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children, asChild }: any) =>
    asChild ? children : React.createElement('span', null, children),
  TooltipContent: ({ children, ...rest }: any) =>
    React.createElement('span', rest, children),
}));

// Switch maps onto a checkbox so fireEvent.click works without dragging
// Radix into the test surface.
jest.mock('../../components/ui/switch', () => {
  const React = require('react');
  return {
    Switch: ({ checked, onCheckedChange, ...rest }: any) =>
      React.createElement('input', {
        type: 'checkbox',
        checked: !!checked,
        onChange: (e: any) => onCheckedChange?.(e.target.checked),
        ...rest,
      }),
  };
});

jest.mock('../../components/ui/select', () => {
  const React = require('react');
  return {
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
  };
});

const mockUseOrganization = jest.fn();
jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

jest.mock('../../services/governanceService', () => ({
  governanceService: {
    listCaseLaw: jest.fn(),
    revokeCaseLaw: jest.fn(),
    unrevokeCaseLaw: jest.fn(),
    updateCaseLawPrecedence: jest.fn(),
  },
  CASELAW_ACKNOWLEDGEMENT_TEXT:
    'I understand this changes the case-law precedent used at engine step 1',
}));

// Stub the new dialog so we can assert open/mode props without dragging
// its internal mocks of the shadcn primitives into this page-level test.
jest.mock('../../components/CaseLawActionDialog', () => ({
  CaseLawActionDialog: ({ open, mode, entry, onCommitted, onOpenChange }: any) =>
    open
      ? require('react').createElement(
          'div',
          {
            'data-testid': 'case-law-action-dialog-stub',
            'data-mode': mode,
            'data-case-id': entry.caseId,
          },
          [
            require('react').createElement(
              'button',
              {
                key: 'commit',
                'data-testid': 'case-law-action-dialog-commit',
                onClick: () =>
                  onCommitted({
                    ok: true,
                    caseId: entry.caseId,
                    action: mode,
                    entry,
                    emittedEventDetailType: 'governance.caselaw.changed',
                  }),
              },
              'commit',
            ),
            require('react').createElement(
              'button',
              {
                key: 'close',
                'data-testid': 'case-law-action-dialog-close',
                onClick: () => onOpenChange(false),
              },
              'close',
            ),
          ],
        )
      : null,
}));

// Stub sonner so the toast call doesn't drag DOM portal mechanics in.
jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

import { governanceService } from '../../services/governanceService';
import { GovernanceCaseLaw } from '../../pages/governance/CaseLaw';

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

function makeEntry(overrides: Partial<any> = {}): any {
  return {
    caseId: 'case-1',
    pattern: JSON.stringify({ agent: 'a', target: 'b' }),
    resolution: 'permit',
    encodedAt: '2026-05-01T10:00:00.000Z',
    encodedBy: 'operator@acme.com',
    scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
    precedence: 5,
    revoked: false,
    ...overrides,
  };
}

describe('GovernanceCaseLaw', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([]);
    if (typeof window !== 'undefined') {
      window.localStorage.clear();
    }
  });

  it('renders empty state with no fetch when caller is not admin', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    expect(screen.getByTestId('case-law-admin-only')).toBeInTheDocument();
    expect(governanceService.listCaseLaw).not.toHaveBeenCalled();
  });

  it('admin: fetches listCaseLaw on mount', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });
    // Default: includeRevoked false (or null in args).
    const callArgs = (governanceService.listCaseLaw as jest.Mock).mock.calls[0][0];
    expect(callArgs).toEqual({ includeRevoked: false });
  });

  it('renders cards in the order returned by the service (precedence DESC)', async () => {
    setOrg(true);
    // Service returns entries in precedence-DESC order; the page renders
    // them in that same order.
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-top', precedence: 10 }),
      makeEntry({ caseId: 'case-mid', precedence: 5 }),
      makeEntry({ caseId: 'case-low', precedence: 1 }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('case-law-card-case-top')).toBeInTheDocument();
    });

    const timeline = screen.getByTestId('case-law-timeline');
    const cards = within(timeline).getAllByTestId(/^case-law-card-/);
    const order = cards.map((c) => c.getAttribute('data-case-id'));
    expect(order).toEqual(['case-top', 'case-mid', 'case-low']);
  });

  it('Resolution Select filters out non-matching entries', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-permit', resolution: 'permit' }),
      makeEntry({ caseId: 'case-deny', resolution: 'deny' }),
      makeEntry({ caseId: 'case-escalate', resolution: 'escalate' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('case-law-card-case-permit')).toBeInTheDocument();
    });

    const selects = screen.getAllByTestId('select');
    // The page has one Select (resolution filter) — index [0].
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'deny' } });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('case-law-card-case-permit')).toBeNull();
      expect(screen.queryByTestId('case-law-card-case-escalate')).toBeNull();
      expect(screen.getByTestId('case-law-card-case-deny')).toBeInTheDocument();
    });
  });

  it('Include-revoked toggle re-fetches with includeRevoked=true', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });

    const switchEl = screen.getByTestId('include-revoked-switch');
    await act(async () => {
      fireEvent.click(switchEl);
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(2);
    });
    const lastCall = (governanceService.listCaseLaw as jest.Mock).mock.calls[1][0];
    expect(lastCall).toEqual({ includeRevoked: true });
  });

  it('localStorage persists the include-revoked toggle', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });

    const switchEl = screen.getByTestId('include-revoked-switch');
    await act(async () => {
      fireEvent.click(switchEl);
    });

    expect(
      window.localStorage.getItem('governance.caselaw.includeRevoked'),
    ).toBe('true');

    // Toggle off again.
    await act(async () => {
      fireEvent.click(switchEl);
    });
    expect(
      window.localStorage.getItem('governance.caselaw.includeRevoked'),
    ).toBe('false');
  });

  it('initial include-revoked state read from localStorage', async () => {
    setOrg(true);
    window.localStorage.setItem(
      'governance.caselaw.includeRevoked',
      'true',
    );

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });
    const callArgs = (governanceService.listCaseLaw as jest.Mock).mock.calls[0][0];
    expect(callArgs).toEqual({ includeRevoked: true });
    const switchEl = screen.getByTestId(
      'include-revoked-switch',
    ) as HTMLInputElement;
    expect(switchEl.checked).toBe(true);
  });

  it('renders empty state when no entries', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('case-law-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('case-law-empty')).toHaveTextContent(
      'No case-law entries',
    );
    expect(screen.getByTestId('case-law-empty')).toHaveTextContent(
      'case_law_admin',
    );
  });

  it('renders Pattern and Scope-of-applicability collapsibles for each card', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({
        caseId: 'case-1',
        pattern: JSON.stringify({ agent: 'a', target: 'b' }),
        scopeOfApplicability: JSON.stringify({ tenants: ['acme'] }),
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-pattern-details-case-1'),
      ).toBeInTheDocument();
    });

    const patternDetails = screen.getByTestId(
      'case-law-pattern-details-case-1',
    ) as HTMLDetailsElement;
    expect(patternDetails.tagName).toBe('DETAILS');
    // Default collapsed.
    expect(patternDetails.open).toBe(false);
    // Preview shows raw JSON (≤ 80 chars in this fixture).
    expect(
      screen.getByTestId('case-law-pattern-preview-case-1'),
    ).toBeInTheDocument();
    // Pretty-printer renders the JSON formatted with 2-space indent.
    expect(
      screen.getByTestId('case-law-pattern-pretty-case-1'),
    ).toHaveTextContent('"agent"');

    const scopeDetails = screen.getByTestId(
      'case-law-scope-details-case-1',
    ) as HTMLDetailsElement;
    expect(scopeDetails.tagName).toBe('DETAILS');
    expect(scopeDetails.open).toBe(false);
    expect(
      screen.getByTestId('case-law-scope-pretty-case-1'),
    ).toHaveTextContent('"tenants"');

    // Open the pattern collapsible — the pretty block stays in the DOM
    // (we render it always, just hidden by `details` collapse).
    await act(async () => {
      patternDetails.open = true;
      patternDetails.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
    expect(patternDetails.open).toBe(true);
  });

  it('Revoke button is enabled on a non-revoked entry and opens the dialog in revoke mode', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-x', revoked: false }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-revoke-case-x'),
      ).toBeInTheDocument();
    });

    const revokeBtn = screen.getByTestId('case-law-revoke-case-x');
    expect(revokeBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(revokeBtn);
    });

    const dialog = await screen.findByTestId('case-law-action-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'revoke');
    expect(dialog).toHaveAttribute('data-case-id', 'case-x');
  });

  it('Revoked entry renders Restore button (replaces Revoke) and opens the dialog in unrevoke mode', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-rev', revoked: true }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-restore-case-rev'),
      ).toBeInTheDocument();
    });

    // Revoke button is NOT rendered for a revoked entry.
    expect(
      screen.queryByTestId('case-law-revoke-case-rev'),
    ).toBeNull();

    const restoreBtn = screen.getByTestId('case-law-restore-case-rev');
    expect(restoreBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(restoreBtn);
    });

    const dialog = await screen.findByTestId('case-law-action-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'unrevoke');
    expect(dialog).toHaveAttribute('data-case-id', 'case-rev');
  });

  it('Edit-precedence button is enabled and opens the dialog in update-precedence mode', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-x' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-edit-precedence-case-x'),
      ).toBeInTheDocument();
    });

    const editBtn = screen.getByTestId('case-law-edit-precedence-case-x');
    expect(editBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(editBtn);
    });

    const dialog = await screen.findByTestId('case-law-action-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'update-precedence');
    expect(dialog).toHaveAttribute('data-case-id', 'case-x');
  });

  it('Successful commit refetches listCaseLaw with the current includeRevoked toggle', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-x', revoked: false }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });

    // Open the revoke dialog.
    await act(async () => {
      fireEvent.click(screen.getByTestId('case-law-revoke-case-x'));
    });

    // Simulate a successful commit via the dialog stub.
    await act(async () => {
      fireEvent.click(screen.getByTestId('case-law-action-dialog-commit'));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(2);
    });
    // Refetch uses the current includeRevoked toggle (false on first
    // load — the toggle is unchanged).
    const lastCall = (governanceService.listCaseLaw as jest.Mock).mock.calls[1][0];
    expect(lastCall).toEqual({ includeRevoked: false });
  });

  it('renders revoked badge in destructive style when revoked=true', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-rev', revoked: true }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('case-law-card-case-rev')).toBeInTheDocument();
    });

    const card = screen.getByTestId('case-law-card-case-rev');
    expect(card).toHaveAttribute('data-revoked', 'true');
    const revokedBadge = within(card).getByTestId('case-law-revoked-case-rev');
    expect(revokedBadge).toHaveAttribute('data-variant', 'destructive');
    expect(revokedBadge).toHaveTextContent('revoked');
  });

  it('Resolution badge uses the project-wide decision palette tokens', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({ caseId: 'case-permit', resolution: 'permit' }),
      makeEntry({ caseId: 'case-deny', resolution: 'deny' }),
      makeEntry({ caseId: 'case-esc', resolution: 'escalate' }),
      makeEntry({ caseId: 'case-halt', resolution: 'halt' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('case-law-resolution-case-permit'),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByTestId('case-law-resolution-case-permit').className,
    ).toContain('chart-2');
    expect(
      screen.getByTestId('case-law-resolution-case-deny').className,
    ).toContain('destructive');
    expect(
      screen.getByTestId('case-law-resolution-case-esc').className,
    ).toContain('amber-500');
    expect(
      screen.getByTestId('case-law-resolution-case-halt').className,
    ).toContain('pink-500');
  });

  it('refresh button re-fetches with current filter state', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByTestId('case-law-refresh');
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    await waitFor(() => {
      expect(governanceService.listCaseLaw).toHaveBeenCalledTimes(2);
    });
  });

  it('stats line shows count, highest precedence, and most recent encodedAt', async () => {
    setOrg(true);
    (governanceService.listCaseLaw as jest.Mock).mockResolvedValue([
      makeEntry({
        caseId: 'case-1',
        precedence: 10,
        encodedAt: '2026-05-15T10:00:00.000Z',
      }),
      makeEntry({
        caseId: 'case-2',
        precedence: 3,
        encodedAt: '2026-05-19T10:00:00.000Z',
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('case-law-stats')).toBeInTheDocument();
    });

    const stats = screen.getByTestId('case-law-stats');
    expect(stats).toHaveTextContent('2 case-law entries');
    expect(stats).toHaveTextContent('highest precedence: 10');
    expect(stats).toHaveTextContent('2026-05-19T10:00:00.000Z');
  });

  it('renders the resolution legend (footer) with all four resolutions', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceCaseLaw));
    });

    await waitFor(() => {
      expect(screen.getByTestId('resolution-legend')).toBeInTheDocument();
    });

    expect(
      screen.getByTestId('resolution-legend-badge-permit'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('resolution-legend-badge-deny'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('resolution-legend-badge-escalate'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('resolution-legend-badge-halt'),
    ).toBeInTheDocument();
  });
});
