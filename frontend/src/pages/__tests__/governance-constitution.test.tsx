/**
 * GovernanceConstitution tests.
 *
 * Mocks the governance service, OrganizationContext, and the shadcn
 * primitives used by the page (Accordion, Popover, Select, Tooltip,
 * Badge, Button, Skeleton) so the assertions stay focused on
 * composition logic without dragging Radix portal mechanics into the
 * test surface.
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

// Accordion: render every item flat so the page composition is asserted
// without driving Radix open/close mechanics. AccordionContent renders
// its children directly so RuleRow always renders.
jest.mock('../../components/ui/accordion', () => ({
  Accordion: ({ children, ...rest }: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'accordion', ...rest },
      children,
    ),
  AccordionItem: ({ children, value, ...rest }: any) =>
    React.createElement(
      'div',
      { 'data-testid': `accordion-item-${value}`, value, ...rest },
      children,
    ),
  AccordionTrigger: ({ children, ...rest }: any) =>
    React.createElement('button', rest, children),
  AccordionContent: ({ children }: any) =>
    React.createElement('div', null, children),
}));

jest.mock('../../components/ui/badge', () => ({
  Badge: ({ children, className, variant, ...rest }: any) =>
    React.createElement(
      'span',
      { 'data-variant': variant, className, ...rest },
      children,
    ),
}));

jest.mock('../../components/ui/popover', () => ({
  Popover: ({ children }: any) =>
    React.createElement(React.Fragment, null, children),
  PopoverTrigger: ({ children, asChild }: any) =>
    asChild ? children : React.createElement('span', null, children),
  PopoverContent: ({ children, ...rest }: any) =>
    React.createElement('div', rest, children),
}));

jest.mock('../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children, asChild }: any) =>
    asChild ? children : React.createElement('span', null, children),
  TooltipContent: ({ children, ...rest }: any) =>
    React.createElement('span', rest, children),
}));

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

jest.mock('../../services/governanceService', () => {
  const actual = jest.requireActual('../../services/governanceService');
  return {
    ...actual,
    governanceService: {
      listConstitutionalLayers: jest.fn(),
      getConstitutionalRuleStats: jest.fn(),
      addConstitutionalRule: jest.fn(),
      updateConstitutionalRule: jest.fn(),
      deleteConstitutionalRule: jest.fn(),
    },
    CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT:
      actual.CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
  };
});

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// Stub the rule editor dialog so we can assert on the page-level wiring
// without driving the dialog's own gate composition (which has its own
// dedicated test file).
jest.mock('../../components/RuleEditorDialog', () => {
  const React = require('react');
  return {
    RuleEditorDialog: ({
      open,
      mode,
      layer,
      ruleIndex,
      onCommitted,
      onOpenChange,
    }: any) =>
      open
        ? React.createElement(
            'div',
            {
              'data-testid': 'rule-editor-dialog-stub',
              'data-mode': mode,
              'data-layer-id': layer?.layerId,
              'data-rule-index':
                typeof ruleIndex === 'number' ? String(ruleIndex) : undefined,
            },
            React.createElement(
              'button',
              {
                'data-testid': 'rule-editor-stub-commit',
                onClick: () =>
                  onCommitted({
                    ok: true,
                    layerId: layer.layerId,
                    action: mode,
                    layer,
                    emittedEventDetailType: 'governance.constitutional.rule.changed',
                  }),
              },
              'commit',
            ),
            React.createElement(
              'button',
              {
                'data-testid': 'rule-editor-stub-cancel',
                onClick: () => onOpenChange(false),
              },
              'cancel',
            ),
          )
        : null,
  };
});

import { governanceService } from '../../services/governanceService';
import { GovernanceConstitution } from '../../pages/governance/Constitution';

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

function makeLayer(overrides: Partial<any> = {}): any {
  return {
    layerId: 'layer-a',
    layerType: 'global',
    appliesTo: ['*'],
    rules: [
      { field: 'pii_present', operator: 'eq', value: 'false' },
    ],
    parentLayerId: null,
    ...overrides,
  };
}

function makeStatsReport(overrides: Partial<any> = {}): any {
  return {
    generatedAt: 1715000000,
    sinceTs: 1714000000,
    untilTs: 1715000000,
    totalOverrides: 0,
    stats: [],
    truncated: false,
    ...overrides,
  };
}

describe('GovernanceConstitution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([]);
    (governanceService.getConstitutionalRuleStats as jest.Mock).mockResolvedValue(
      makeStatsReport(),
    );
  });

  it('renders empty state with no fetch when caller is not admin', async () => {
    setOrg(false);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    expect(screen.getByTestId('constitution-admin-only')).toBeInTheDocument();
    expect(governanceService.listConstitutionalLayers).not.toHaveBeenCalled();
    expect(governanceService.getConstitutionalRuleStats).not.toHaveBeenCalled();
  });

  it('admin: fetches layers and stats on mount', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(governanceService.listConstitutionalLayers).toHaveBeenCalledTimes(1);
      expect(governanceService.getConstitutionalRuleStats).toHaveBeenCalledTimes(1);
    });
  });

  it('admin: renders each layer as an Accordion item', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer({ layerId: 'l-pair', layerType: 'pairwise' }),
      makeLayer({ layerId: 'l-domain', layerType: 'domain' }),
      makeLayer({ layerId: 'l-global', layerType: 'global' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(screen.getByTestId('layer-item-l-pair')).toBeInTheDocument();
      expect(screen.getByTestId('layer-item-l-domain')).toBeInTheDocument();
      expect(screen.getByTestId('layer-item-l-global')).toBeInTheDocument();
    });
  });

  it('layer-type filter hides non-matching layers', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer({ layerId: 'l-pair', layerType: 'pairwise' }),
      makeLayer({ layerId: 'l-domain', layerType: 'domain' }),
      makeLayer({ layerId: 'l-global', layerType: 'global' }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(screen.getByTestId('layer-item-l-pair')).toBeInTheDocument();
    });

    // Find the layer-type select (the first <select>) and change to 'global'.
    const selects = screen.getAllByTestId('select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'global' } });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('layer-item-l-pair')).toBeNull();
      expect(screen.queryByTestId('layer-item-l-domain')).toBeNull();
      expect(screen.getByTestId('layer-item-l-global')).toBeInTheDocument();
    });
  });

  it('time-range change re-fetches stats', async () => {
    setOrg(true);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(governanceService.getConstitutionalRuleStats).toHaveBeenCalledTimes(1);
    });

    const selects = screen.getAllByTestId('select');
    // Second select is the time-range filter.
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: '24h' } });
    });

    await waitFor(() => {
      expect(governanceService.getConstitutionalRuleStats).toHaveBeenCalledTimes(2);
    });
  });

  it('renders rules with operator badge', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer({
        rules: [
          { field: 'pii_present', operator: 'eq', value: 'false' },
          { field: 'amount', operator: 'gt', value: '100' },
        ],
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-row-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    const eqRow = screen.getByTestId('rule-row-layer-a-pii_present');
    expect(eqRow).toHaveAttribute('data-rule-operator', 'eq');
    const eqBadge = within(eqRow).getByTestId('rule-operator-badge');
    expect(eqBadge).toHaveTextContent('eq');
    expect(eqBadge).toHaveAttribute('data-known-operator', 'true');

    const gtRow = screen.getByTestId('rule-row-layer-a-amount');
    expect(gtRow).toHaveAttribute('data-rule-operator', 'gt');
    const gtBadge = within(gtRow).getByTestId('rule-operator-badge');
    expect(gtBadge).toHaveTextContent('gt');
  });

  it('renders override count chip when fires <= 5', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);
    (governanceService.getConstitutionalRuleStats as jest.Mock).mockResolvedValue(
      makeStatsReport({
        totalOverrides: 3,
        stats: [
          {
            layerId: 'layer-a',
            field: 'pii_present',
            count7d: 3,
            lastFiredAt: 1714999000,
            firstFiredAt: 1714000000,
            topAffectedAgents: ['agent-1'],
          },
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-row-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    const row = screen.getByTestId('rule-row-layer-a-pii_present');
    expect(within(row).getByTestId('rule-fires-chip')).toHaveTextContent(
      '3 fires',
    );
    expect(within(row).queryByTestId('rule-sparkline')).toBeNull();
  });

  it('renders sparkline when fires > 5', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);
    (governanceService.getConstitutionalRuleStats as jest.Mock).mockResolvedValue(
      makeStatsReport({
        totalOverrides: 50,
        stats: [
          {
            layerId: 'layer-a',
            field: 'pii_present',
            count7d: 50,
            lastFiredAt: 1714999000,
            firstFiredAt: 1714000000,
            topAffectedAgents: ['agent-1', 'agent-2'],
          },
        ],
      }),
    );

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-row-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    const row = screen.getByTestId('rule-row-layer-a-pii_present');
    expect(within(row).getByTestId('rule-sparkline')).toHaveAttribute(
      'data-count',
      '50',
    );
    expect(within(row).queryByTestId('rule-fires-chip')).toBeNull();
  });

  it('exists / not_exists operators do not show value', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer({
        rules: [
          { field: 'session_id', operator: 'exists', value: null },
          { field: 'override_flag', operator: 'not_exists', value: null },
        ],
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-row-layer-a-session_id'),
      ).toBeInTheDocument();
    });

    const existsRow = screen.getByTestId('rule-row-layer-a-session_id');
    expect(within(existsRow).queryByTestId('rule-value')).toBeNull();
    const notExistsRow = screen.getByTestId('rule-row-layer-a-override_flag');
    expect(within(notExistsRow).queryByTestId('rule-value')).toBeNull();
  });

  it('renders empty state when no layers', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(screen.getByTestId('constitution-empty')).toHaveTextContent(
        'No constitutional layers configured.',
      );
    });
  });

  it('Edit button is enabled (no longer disabled stub)', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-edit-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    const editButton = screen.getByTestId(
      'rule-edit-layer-a-pii_present',
    );
    expect(editButton).not.toBeDisabled();
    // The "Edit" copy must be gone.
    expect(editButton.textContent).not.toContain('Wave 4.C.2');
    // The disabled-stub testid must be gone.
    expect(
      screen.queryByTestId('rule-edit-disabled-layer-a-pii_present'),
    ).toBeNull();
  });

  it('Delete button is rendered per rule', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer({
        rules: [
          { field: 'pii_present', operator: 'eq', value: 'false' },
          { field: 'amount', operator: 'gt', value: '100' },
        ],
      }),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-delete-layer-a-pii_present'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('rule-delete-layer-a-amount'),
    ).toBeInTheDocument();
  });

  it('Add-rule button is rendered at the layer level', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('layer-add-rule-layer-a'),
      ).toBeInTheDocument();
    });
  });

  it('clicking Edit opens the rule editor dialog in update mode', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-edit-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      (
        screen.getByTestId('rule-edit-layer-a-pii_present') as HTMLButtonElement
      ).click();
    });

    const dialog = screen.getByTestId('rule-editor-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'update');
    expect(dialog).toHaveAttribute('data-layer-id', 'layer-a');
    expect(dialog).toHaveAttribute('data-rule-index', '0');
  });

  it('clicking Delete opens the rule editor dialog in delete mode', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('rule-delete-layer-a-pii_present'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      (
        screen.getByTestId('rule-delete-layer-a-pii_present') as HTMLButtonElement
      ).click();
    });

    const dialog = screen.getByTestId('rule-editor-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'delete');
  });

  it('clicking Add rule opens the dialog in add mode', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('layer-add-rule-layer-a'),
      ).toBeInTheDocument();
    });

    await act(async () => {
      (
        screen.getByTestId('layer-add-rule-layer-a') as HTMLButtonElement
      ).click();
    });

    const dialog = screen.getByTestId('rule-editor-dialog-stub');
    expect(dialog).toHaveAttribute('data-mode', 'add');
    expect(dialog).toHaveAttribute('data-layer-id', 'layer-a');
  });

  it('successful commit refetches both queries', async () => {
    setOrg(true);
    (governanceService.listConstitutionalLayers as jest.Mock).mockResolvedValue([
      makeLayer(),
    ]);

    await act(async () => {
      render(React.createElement(GovernanceConstitution));
    });

    await waitFor(() => {
      expect(
        governanceService.listConstitutionalLayers,
      ).toHaveBeenCalledTimes(1);
      expect(
        governanceService.getConstitutionalRuleStats,
      ).toHaveBeenCalledTimes(1);
    });

    // Open the editor in add mode + click the stub's commit button which
    // calls onCommitted directly.
    await act(async () => {
      (
        screen.getByTestId('layer-add-rule-layer-a') as HTMLButtonElement
      ).click();
    });

    await act(async () => {
      (
        screen.getByTestId('rule-editor-stub-commit') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(
        governanceService.listConstitutionalLayers,
      ).toHaveBeenCalledTimes(2);
      expect(
        governanceService.getConstitutionalRuleStats,
      ).toHaveBeenCalledTimes(2);
    });
  });
});
