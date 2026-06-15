/**
 * ConditionEditorPanel Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 16.6, 16.7, 27.4
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ConditionEditorPanel } from '../ConditionEditorPanel';
import type { EdgeCondition } from '../../types/workflow';

// jsdom shims required by Radix UI Select
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

describe('ConditionEditorPanel', () => {
  const defaultCondition: EdgeCondition = {
    field: 'result.status',
    operator: 'equals',
    value: 'success',
  };

  describe('panel rendering', () => {
    it('renders field input with current value', () => {
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
        />
      );
      const fieldInput = screen.getByLabelText(/field/i);
      expect(fieldInput).toBeInTheDocument();
      expect(fieldInput).toHaveValue('result.status');
    });

    it('renders operator dropdown with current value', () => {
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
        />
      );
      const operatorSelect = screen.getByLabelText(/operator/i);
      expect(operatorSelect).toBeInTheDocument();
      // Radix Select trigger renders the current value as text content
      expect(operatorSelect).toHaveTextContent('equals');
    });

    it('renders all operator options in dropdown', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
        />
      );
      const operatorSelect = screen.getByLabelText(/operator/i);
      await user.click(operatorSelect);
      // Radix renders options as elements with role="option" once opened
      const listbox = await screen.findByRole('listbox');
      const optionTexts = within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent);
      expect(optionTexts).toEqual(
        expect.arrayContaining([
          'equals',
          'notEquals',
          'contains',
          'greaterThan',
          'lessThan',
          'exists',
        ])
      );
    });

    it('renders value input with current value', () => {
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
        />
      );
      const valueInput = screen.getByLabelText(/value/i);
      expect(valueInput).toBeInTheDocument();
      expect(valueInput).toHaveValue('success');
    });

    it('calls onChange when field is updated', async () => {
      const user = userEvent.setup();
      const onChange = jest.fn();

      // Use a wrapper that re-renders with updated condition (controlled component)
      function Wrapper() {
        const [cond, setCond] = React.useState<EdgeCondition>({
          field: '',
          operator: 'equals',
          value: 'success',
        });
        return (
          <ConditionEditorPanel
            condition={cond}
            onChange={(updated) => {
              setCond(updated);
              onChange(updated);
            }}
          />
        );
      }

      render(<Wrapper />);
      const fieldInput = screen.getByLabelText(/field/i);
      await user.type(fieldInput, 'output.code');

      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ field: 'output.code' })
      );
    });

    it('calls onChange when operator is changed', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onChange = jest.fn();

      function Wrapper() {
        const [cond, setCond] = React.useState<EdgeCondition>({
          field: 'result.status',
          operator: 'equals',
          value: 'success',
        });
        return (
          <ConditionEditorPanel
            condition={cond}
            onChange={(updated) => {
              setCond(updated);
              onChange(updated);
            }}
          />
        );
      }

      render(<Wrapper />);
      const operatorSelect = screen.getByLabelText(/operator/i);
      await user.click(operatorSelect);
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: 'contains' }));

      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ operator: 'contains' })
      );
    });
  });

  describe('conditional edge display', () => {
    it('renders dashed style class for conditional edge', () => {
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
          edgePreview
        />
      );
      const edgePreview = screen.getByTestId('conditional-edge-preview');
      expect(edgePreview).toHaveClass('border-dashed');
    });

    it('displays condition label on edge preview', () => {
      render(
        <ConditionEditorPanel
          condition={defaultCondition}
          onChange={jest.fn()}
          edgePreview
        />
      );
      const edgeLabel = screen.getByTestId('conditional-edge-label');
      expect(edgeLabel).toHaveTextContent('result.status equals success');
    });
  });
});
