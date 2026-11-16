/**
 * EdgeConditionSheet Component Tests
 * TDD Red Phase — tests written before implementation.
 *
 * CIT-291: Edge condition editor opened by double-clicking an edge.
 */

import { render, screen } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { EdgeConditionSheet } from '../EdgeConditionSheet';
import type { WorkflowEdge, WorkflowNode, EdgeCondition } from '../../types/workflow';

// jsdom shims required by Radix UI
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/* ---------- helpers ---------- */

function makeNode(id: string, label: string): WorkflowNode {
  return {
    id,
    type: 'agentNode',
    position: { x: 0, y: 0 },
    data: {
      agentId: id,
      agentConfig: {} as WorkflowNode['data']['agentConfig'],
      label,
      inputCount: 1,
      outputCount: 1,
    },
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  condition?: EdgeCondition,
): WorkflowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: 'output',
    targetHandle: 'input',
    type: 'smoothstep',
    data: {
      sourceHandle: 'output',
      targetHandle: 'input',
      condition,
    },
  };
}

const sourceNode = makeNode('n1', 'Router');
const targetNode = makeNode('n2', 'Branch A');

const existingCondition: EdgeCondition = {
  field: 'result.route',
  operator: 'equals',
  value: 'branch-a',
};

/* ---------- tests ---------- */

describe('EdgeConditionSheet', () => {
  describe('open with existing condition', () => {
    it('renders source → target header labels', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', existingCondition)}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByText(/Router/)).toBeInTheDocument();
      expect(screen.getByText(/Branch A/)).toBeInTheDocument();
    });

    it('pre-fills the condition fields from edge data', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', existingCondition)}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByLabelText(/field/i)).toHaveValue('result.route');
      // Value input visible and pre-filled
      expect(screen.getByLabelText(/value/i)).toHaveValue('branch-a');
    });
  });

  describe('apply valid condition', () => {
    it('calls onApply with the drafted condition when Apply is clicked', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onApply = jest.fn();
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', existingCondition)}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={onApply}
          onRemove={jest.fn()}
        />,
      );
      const applyBtn = screen.getByRole('button', { name: /apply/i });
      await user.click(applyBtn);
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          field: 'result.route',
          operator: 'equals',
          value: 'branch-a',
        }),
      );
    });
  });

  describe('apply blocked when invalid', () => {
    it('disables Apply when field is empty', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: '',
            operator: 'equals',
            value: 'x',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });

    it('disables Apply when field contains invalid characters', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: '',
            operator: 'equals',
            value: 'x',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      const fieldInput = screen.getByLabelText(/field/i);
      await user.type(fieldInput, '123invalid');
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });

    it('disables Apply when value is empty for non-exists operator', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.ok',
            operator: 'equals',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });
  });

  describe('exists hides value', () => {
    it('hides the value input when operator is exists', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.ok',
            operator: 'exists',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.queryByLabelText(/value/i)).not.toBeInTheDocument();
    });

    it('Apply is enabled for exists when field is valid (value not required)', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.ok',
            operator: 'exists',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled();
    });
  });

  describe('numeric coercion for greaterThan / lessThan', () => {
    it('coerces value to number for greaterThan when input is numeric', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onApply = jest.fn();
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.score',
            operator: 'greaterThan',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={onApply}
          onRemove={jest.fn()}
        />,
      );
      const valueInput = screen.getByLabelText(/value/i);
      await user.type(valueInput, '42');
      await user.click(screen.getByRole('button', { name: /apply/i }));
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ value: 42 }),
      );
    });

    it('keeps value as string for greaterThan when input is not numeric', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onApply = jest.fn();
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.score',
            operator: 'greaterThan',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={onApply}
          onRemove={jest.fn()}
        />,
      );
      const valueInput = screen.getByLabelText(/value/i);
      await user.type(valueInput, 'high');
      await user.click(screen.getByRole('button', { name: /apply/i }));
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'high' }),
      );
    });

    it('validates that value is numeric for lessThan when input is a number string', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onApply = jest.fn();
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', {
            field: 'result.count',
            operator: 'lessThan',
            value: '',
          })}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={onApply}
          onRemove={jest.fn()}
        />,
      );
      const valueInput = screen.getByLabelText(/value/i);
      await user.type(valueInput, '3.14');
      await user.click(screen.getByRole('button', { name: /apply/i }));
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ value: 3.14 }),
      );
    });
  });

  describe('remove clears everything', () => {
    it('calls onRemove when Remove Condition is clicked', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      const onRemove = jest.fn();
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2', existingCondition)}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={onRemove}
        />,
      );
      await user.click(screen.getByRole('button', { name: /remove/i }));
      expect(onRemove).toHaveBeenCalled();
    });
  });

  describe('empty state (no condition)', () => {
    it('shows empty state text when edge has no condition', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2')}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByText(/no condition/i)).toBeInTheDocument();
    });

    it('shows Add button in empty state', () => {
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2')}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
    });

    it('clicking Add reveals the editor panel', async () => {
      const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
      render(
        <EdgeConditionSheet
          edge={makeEdge('e1', 'n1', 'n2')}
          nodes={[sourceNode, targetNode]}
          isOpen
          onClose={jest.fn()}
          onApply={jest.fn()}
          onRemove={jest.fn()}
        />,
      );
      await user.click(screen.getByRole('button', { name: /add/i }));
      expect(screen.getByLabelText(/field/i)).toBeInTheDocument();
    });
  });
});
