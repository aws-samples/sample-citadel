/**
 * RuleEditorDialog tests.
 *
 * Mocks the governance service and the shadcn primitives that wrap Radix
 * portals (Dialog / Select / Checkbox) so we can assert gate composition
 * (field validity, JSON-parseable value, acknowledgement, typed-match
 * DELETE), service args mapping, error handling, and the success path.
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

// shadcn Select is Radix-based; flatten to a native <select> so test code
// can change the value via fireEvent.change without portals.
jest.mock('../ui/select', () => {
  const React = require('react');
  return {
    Select: ({ value, onValueChange, children, disabled }: any) =>
      React.createElement(
        'select',
        {
          'data-testid': 'rule-editor-operator-mock',
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
      addConstitutionalRule: jest.fn(),
      updateConstitutionalRule: jest.fn(),
      deleteConstitutionalRule: jest.fn(),
    },
    CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT:
      actual.CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
  };
});

import {
  governanceService,
  CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
  ConstitutionalLayer,
  ConstitutionalRule,
  ConstitutionalRuleMutationResult,
} from '../../services/governanceService';
import { RuleEditorDialog } from '../RuleEditorDialog';

const layer: ConstitutionalLayer = {
  layerId: 'layer-global',
  layerType: 'global',
  appliesTo: ['*'],
  rules: [{ field: 'pii_present', operator: 'eq', value: 'false' }],
  parentLayerId: null,
};

const successAddResult: ConstitutionalRuleMutationResult = {
  ok: true,
  layerId: 'layer-global',
  action: 'add',
  layer,
  emittedEventDetailType: 'governance.constitutional.rule.changed',
};

function makeProps(
  overrides: Partial<React.ComponentProps<typeof RuleEditorDialog>> = {},
) {
  return {
    open: true,
    onOpenChange: jest.fn(),
    mode: 'add' as const,
    layer,
    onCommitted: jest.fn(),
    ...overrides,
  };
}

async function renderDialog(
  props: Partial<React.ComponentProps<typeof RuleEditorDialog>> = {},
) {
  await act(async () => {
    render(React.createElement(RuleEditorDialog, makeProps(props) as any));
  });
}

describe('RuleEditorDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (governanceService.addConstitutionalRule as jest.Mock).mockResolvedValue(
      successAddResult,
    );
    (governanceService.updateConstitutionalRule as jest.Mock).mockResolvedValue({
      ...successAddResult,
      action: 'update',
    });
    (governanceService.deleteConstitutionalRule as jest.Mock).mockResolvedValue({
      ...successAddResult,
      action: 'delete',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('add mode: Confirm starts disabled (empty form, no acknowledgement)', async () => {
    await renderDialog({ mode: 'add' });

    const confirm = screen.getByTestId(
      'rule-editor-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();
  });

  it('add mode: title references layerId', async () => {
    await renderDialog({ mode: 'add' });

    expect(screen.getByTestId('rule-editor-title')).toHaveTextContent(
      'Add rule to layer-global',
    );
  });

  it('add mode: filling field + JSON value + acknowledgement enables Confirm and calls addConstitutionalRule', async () => {
    await renderDialog({ mode: 'add' });

    const fieldInput = screen.getByTestId(
      'rule-editor-field-input',
    ) as HTMLInputElement;
    fireEvent.change(fieldInput, { target: { value: 'tier' } });

    // Operator defaults to 'eq' so the value field is required.
    const valueInput = screen.getByTestId(
      'rule-editor-value-input',
    ) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: '"gold"' } });

    const ack = screen.getByTestId(
      'rule-editor-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    const confirm = screen.getByTestId(
      'rule-editor-confirm',
    ) as HTMLButtonElement;
    expect(confirm).not.toBeDisabled();

    await act(async () => {
      confirm.click();
    });

    await waitFor(() => {
      expect(
        governanceService.addConstitutionalRule,
      ).toHaveBeenCalledTimes(1);
    });
    expect(governanceService.addConstitutionalRule).toHaveBeenCalledWith(
      'layer-global',
      { field: 'tier', operator: 'eq', value: '"gold"' },
    );
  });

  it('update mode: pre-fills field / operator / value from existingRule', async () => {
    const existing: ConstitutionalRule = {
      field: 'amount',
      operator: 'gt',
      value: '100',
    };
    await renderDialog({
      mode: 'update',
      ruleIndex: 0,
      existingRule: existing,
    });

    expect(
      (screen.getByTestId('rule-editor-field-input') as HTMLInputElement).value,
    ).toBe('amount');
    expect(
      (screen.getByTestId(
        'rule-editor-operator-mock',
      ) as HTMLSelectElement).value,
    ).toBe('gt');
    expect(
      (screen.getByTestId('rule-editor-value-input') as HTMLInputElement).value,
    ).toBe('100');
  });

  it('update mode: title references ruleIndex + layerId', async () => {
    await renderDialog({
      mode: 'update',
      ruleIndex: 2,
      existingRule: { field: 'f', operator: 'eq', value: '"x"' },
    });

    expect(screen.getByTestId('rule-editor-title')).toHaveTextContent(
      'Update rule 2 in layer-global',
    );
  });

  it('update mode: switching operator to exists hides the value field', async () => {
    await renderDialog({
      mode: 'update',
      ruleIndex: 0,
      existingRule: { field: 'f', operator: 'eq', value: '"x"' },
    });

    // Value field is initially visible.
    expect(
      screen.getByTestId('rule-editor-value-input'),
    ).toBeInTheDocument();

    const select = screen.getByTestId(
      'rule-editor-operator-mock',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'exists' } });

    // Value field is hidden after the operator change.
    await waitFor(() => {
      expect(
        screen.queryByTestId('rule-editor-value-input'),
      ).toBeNull();
    });
  });

  it('update mode: confirm sends value: null when operator is exists', async () => {
    await renderDialog({
      mode: 'update',
      ruleIndex: 0,
      existingRule: { field: 'session_id', operator: 'eq', value: '"x"' },
    });

    // Switch to exists operator.
    const select = screen.getByTestId(
      'rule-editor-operator-mock',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'exists' } });

    const ack = screen.getByTestId(
      'rule-editor-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    await act(async () => {
      (
        screen.getByTestId('rule-editor-confirm') as HTMLButtonElement
      ).click();
    });

    expect(governanceService.updateConstitutionalRule).toHaveBeenCalledWith(
      'layer-global',
      0,
      { field: 'session_id', operator: 'exists', value: null },
    );
  });

  it('add mode: invalid JSON value blocks Confirm and surfaces an error message', async () => {
    await renderDialog({ mode: 'add' });

    const fieldInput = screen.getByTestId(
      'rule-editor-field-input',
    ) as HTMLInputElement;
    fireEvent.change(fieldInput, { target: { value: 'tier' } });

    const valueInput = screen.getByTestId(
      'rule-editor-value-input',
    ) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: 'not-json' } });

    const ack = screen.getByTestId(
      'rule-editor-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    expect(screen.getByTestId('rule-editor-value-error')).toBeInTheDocument();
    expect(
      screen.getByTestId('rule-editor-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('delete mode: typed-match DELETE + acknowledgement enables Confirm and calls deleteConstitutionalRule', async () => {
    await renderDialog({
      mode: 'delete',
      ruleIndex: 1,
      existingRule: { field: 'pii_present', operator: 'eq', value: 'false' },
    });

    expect(screen.getByTestId('rule-editor-title')).toHaveTextContent(
      'Delete rule 1 from layer-global',
    );

    const confirm = screen.getByTestId(
      'rule-editor-confirm',
    ) as HTMLButtonElement;
    expect(confirm).toBeDisabled();

    const typedMatch = screen.getByTestId(
      'rule-editor-typed-match-input',
    ) as HTMLInputElement;
    fireEvent.change(typedMatch, { target: { value: 'DELETE' } });

    // Still disabled — acknowledgement not yet ticked.
    expect(confirm).toBeDisabled();

    const ack = screen.getByTestId(
      'rule-editor-ack-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(ack);

    expect(confirm).not.toBeDisabled();

    await act(async () => {
      confirm.click();
    });

    expect(governanceService.deleteConstitutionalRule).toHaveBeenCalledWith(
      'layer-global',
      1,
    );
  });

  it('delete mode: lowercase delete does not unlock Confirm', async () => {
    await renderDialog({
      mode: 'delete',
      ruleIndex: 0,
      existingRule: { field: 'f', operator: 'eq', value: '"x"' },
    });

    const typedMatch = screen.getByTestId(
      'rule-editor-typed-match-input',
    ) as HTMLInputElement;
    fireEvent.change(typedMatch, { target: { value: 'delete' } });
    fireEvent.click(
      screen.getByTestId('rule-editor-ack-checkbox') as HTMLInputElement,
    );

    expect(
      screen.getByTestId('rule-editor-confirm') as HTMLButtonElement,
    ).toBeDisabled();
  });

  it('service throws → inline error renders, dialog stays open', async () => {
    (governanceService.addConstitutionalRule as jest.Mock).mockRejectedValue(
      new Error('Layer not found: missing'),
    );
    const onOpenChange = jest.fn();

    await renderDialog({ mode: 'add', onOpenChange });

    fireEvent.change(
      screen.getByTestId('rule-editor-field-input') as HTMLInputElement,
      { target: { value: 'tier' } },
    );
    fireEvent.change(
      screen.getByTestId('rule-editor-value-input') as HTMLInputElement,
      { target: { value: '"gold"' } },
    );
    fireEvent.click(
      screen.getByTestId('rule-editor-ack-checkbox') as HTMLInputElement,
    );

    await act(async () => {
      (
        screen.getByTestId('rule-editor-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('rule-editor-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('rule-editor-error')).toHaveTextContent(
      'Layer not found',
    );
    // Dialog stays open — onOpenChange MUST NOT be called with false.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('successful commit calls onCommitted and closes the dialog', async () => {
    const onCommitted = jest.fn();
    const onOpenChange = jest.fn();

    await renderDialog({ mode: 'add', onCommitted, onOpenChange });

    fireEvent.change(
      screen.getByTestId('rule-editor-field-input') as HTMLInputElement,
      { target: { value: 'tier' } },
    );
    fireEvent.change(
      screen.getByTestId('rule-editor-value-input') as HTMLInputElement,
      { target: { value: '"gold"' } },
    );
    fireEvent.click(
      screen.getByTestId('rule-editor-ack-checkbox') as HTMLInputElement,
    );

    await act(async () => {
      (
        screen.getByTestId('rule-editor-confirm') as HTMLButtonElement
      ).click();
    });

    await waitFor(() => {
      expect(onCommitted).toHaveBeenCalledTimes(1);
    });
    expect(onCommitted).toHaveBeenCalledWith(successAddResult);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('acknowledgement label matches the exported constant verbatim', async () => {
    await renderDialog({ mode: 'add' });

    const label = screen.getByTestId('rule-editor-ack-label');
    expect(label).toHaveTextContent(CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT);
  });

  it('disables Confirm and renders spinner while service call is in flight', async () => {
    let resolveCall: (v: any) => void = () => undefined;
    (governanceService.addConstitutionalRule as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    await renderDialog({ mode: 'add' });

    fireEvent.change(
      screen.getByTestId('rule-editor-field-input') as HTMLInputElement,
      { target: { value: 'tier' } },
    );
    fireEvent.change(
      screen.getByTestId('rule-editor-value-input') as HTMLInputElement,
      { target: { value: '"gold"' } },
    );
    fireEvent.click(
      screen.getByTestId('rule-editor-ack-checkbox') as HTMLInputElement,
    );

    const confirm = screen.getByTestId(
      'rule-editor-confirm',
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });

    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();

    await act(async () => {
      resolveCall(successAddResult);
    });
  });
});
