/**
 * NodeConfigurationPanel tests
 * TDD Red phase — written before the implementation change.
 *
 * Covers: the always-present node-label input + onRename, the honest
 * empty-state copy for schema-less agents, the schema-driven parameter
 * rendering regression, defensive parsing of string-encoded configs,
 * and disabling Save when the label is empty.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null,
  SheetContent: ({ children, className }: any) =>
    React.createElement('div', { className }, children),
  SheetHeader: ({ children }: any) => React.createElement('div', null, children),
  SheetTitle: ({ children }: any) => React.createElement('h2', null, children),
  SheetDescription: ({ children }: any) => React.createElement('p', null, children),
  SheetFooter: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, variant, size, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => React.createElement('textarea', props),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, htmlFor }: any) => React.createElement('label', { htmlFor }, children),
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) =>
    React.createElement(
      'select',
      { value, onChange: (e: any) => onValueChange(e.target.value) },
      children
    ),
  SelectTrigger: ({ children }: any) => React.createElement(React.Fragment, null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: any) => React.createElement(React.Fragment, null, children),
  SelectItem: ({ value, children }: any) => React.createElement('option', { value }, children),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() },
}));

jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: (props: any) =>
    React.createElement('input', {
      'data-testid': 'model-override',
      value: props.value || '',
      onChange: (e: any) => props.onChange(e.target.value),
    }),
}));

import { NodeConfigurationPanel } from '../NodeConfigurationPanel';
import type { WorkflowNode } from '../../types/workflow';

function makeNode(
  overrides: { agentConfig?: any; label?: string; configuration?: Record<string, any> } = {}
): WorkflowNode {
  return {
    id: 'node-1',
    type: 'agentNode',
    position: { x: 0, y: 0 },
    data: {
      agentId: 'agent-1',
      agentConfig:
        overrides.agentConfig !== undefined
          ? overrides.agentConfig
          : { agentId: 'agent-1', name: 'Agent One', config: {}, state: 'active' },
      label: overrides.label ?? 'Agent One',
      configuration: overrides.configuration ?? {},
      inputCount: 1,
      outputCount: 1,
    },
  } as WorkflowNode;
}

function renderPanel(node: WorkflowNode, overrides: Record<string, any> = {}) {
  const props = {
    node,
    isOpen: true,
    onClose: jest.fn(),
    onSave: jest.fn(),
    onRename: jest.fn(),
    ...overrides,
  };
  return { ...render(<NodeConfigurationPanel {...(props as any)} />), props };
}

describe('NodeConfigurationPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('node label editing', () => {
    it('renders a node label input prefilled with the current label', () => {
      renderPanel(makeNode({ label: 'My Node' }));

      const labelInput = screen.getByLabelText(/node label/i);
      expect(labelInput).toBeInTheDocument();
      expect(labelInput).toHaveValue('My Node');
    });

    it('calls onRename with the edited label on save', async () => {
      const user = userEvent.setup();
      const { props } = renderPanel(makeNode({ label: 'Old Name' }));

      const labelInput = screen.getByLabelText(/node label/i);
      await user.clear(labelInput);
      await user.type(labelInput, 'New Name');
      await user.click(screen.getByRole('button', { name: /save configuration changes/i }));

      expect(props.onRename).toHaveBeenCalledWith('node-1', 'New Name');
      expect(props.onSave).toHaveBeenCalledWith('node-1', expect.any(Object));
    });

    it('disables Save when the label is empty', async () => {
      const user = userEvent.setup();
      renderPanel(makeNode());

      const labelInput = screen.getByLabelText(/node label/i);
      await user.clear(labelInput);

      expect(
        screen.getByRole('button', { name: /save configuration changes/i })
      ).toBeDisabled();
    });
  });

  describe('empty state for schema-less agents', () => {
    it('shows the parameters empty-state copy and drops the stale runtime disclaimer', () => {
      renderPanel(makeNode());

      expect(
        screen.getByText(/does not declare additional parameters/i)
      ).toBeInTheDocument();
      expect(screen.queryByText(/not yet applied at runtime/i)).not.toBeInTheDocument();
      // Agent id remains visible in the panel
      expect(screen.getByText('agent-1')).toBeInTheDocument();
    });
  });

  describe('schema-driven parameters (regression)', () => {
    it('renders parameter inputs when the agent declares schema.properties', () => {
      const agentConfig = {
        agentId: 'agent-1',
        name: 'Agent One',
        state: 'active',
        config: {
          schema: {
            properties: {
              temperature: { type: 'number', title: 'Temperature' },
              prompt: { type: 'textarea', title: 'Prompt' },
            },
            required: [],
          },
        },
      };
      renderPanel(makeNode({ agentConfig }));

      expect(screen.getByText('Temperature')).toBeInTheDocument();
      expect(screen.getByText('Prompt')).toBeInTheDocument();
      expect(
        screen.queryByText(/does not declare additional parameters/i)
      ).not.toBeInTheDocument();
    });
  });

  describe('defensive config parsing', () => {
    it('parses a string-encoded config without crashing and renders its schema params', () => {
      const agentConfig = {
        agentId: 'agent-1',
        name: 'Agent One',
        state: 'active',
        config: JSON.stringify({
          schema: { properties: { model: { type: 'string', title: 'Model' } }, required: [] },
        }),
      };
      renderPanel(makeNode({ agentConfig }));

      expect(screen.getByText('Model')).toBeInTheDocument();
    });

    it('falls back to the empty state when the string-encoded config is invalid JSON', () => {
      const agentConfig = {
        agentId: 'agent-1',
        name: 'Agent One',
        state: 'active',
        config: '{not-json',
      };
      renderPanel(makeNode({ agentConfig }));

      expect(
        screen.getByText(/does not declare additional parameters/i)
      ).toBeInTheDocument();
    });

    it('parses a string-encoded agentConfig without crashing', () => {
      const agentConfig = JSON.stringify({
        agentId: 'agent-1',
        name: 'Agent One',
        state: 'active',
        config: { schema: { properties: { region: { type: 'string', title: 'Region' } } } },
      });
      renderPanel(makeNode({ agentConfig }));

      expect(screen.getByText('Region')).toBeInTheDocument();
    });
  });

  describe('execution overrides', () => {
    it('renders override fields for every node, initialized from node.data.configuration', () => {
      renderPanel(
        makeNode({
          configuration: {
            modelOverride: 'anthropic-claude',
            systemPromptAddition: 'Be terse.',
          },
        })
      );

      expect(screen.getByText(/execution overrides/i)).toBeInTheDocument();
      expect(screen.getByTestId('model-override')).toHaveValue('anthropic-claude');
      expect(screen.getByLabelText(/system prompt addition/i)).toHaveValue('Be terse.');
      expect(
        screen.getByText(/appended to the agent's instructions for this node only/i)
      ).toBeInTheDocument();
    });

    it('saves modelOverride and systemPromptAddition through onSave with exact keys', async () => {
      const user = userEvent.setup();
      const { props } = renderPanel(makeNode());

      await user.type(screen.getByTestId('model-override'), 'model-key-1');
      await user.type(
        screen.getByLabelText(/system prompt addition/i),
        'Focus on cost.'
      );
      await user.click(screen.getByRole('button', { name: /save configuration changes/i }));

      expect(props.onSave).toHaveBeenCalledWith('node-1', {
        modelOverride: 'model-key-1',
        systemPromptAddition: 'Focus on cost.',
      });
    });

    it('deletes cleared override keys from the saved configuration instead of saving empty strings', async () => {
      const user = userEvent.setup();
      const { props } = renderPanel(
        makeNode({
          configuration: {
            modelOverride: 'model-key-1',
            systemPromptAddition: 'Old addition',
            keepMe: 'yes',
          },
        })
      );

      await user.clear(screen.getByTestId('model-override'));
      await user.clear(screen.getByLabelText(/system prompt addition/i));
      await user.click(screen.getByRole('button', { name: /save configuration changes/i }));

      expect(props.onSave).toHaveBeenCalledTimes(1);
      const saved = props.onSave.mock.calls[0][1];
      expect(saved).not.toHaveProperty('modelOverride');
      expect(saved).not.toHaveProperty('systemPromptAddition');
      expect(saved).toEqual({ keepMe: 'yes' });
    });

    it('renders schema-declared parameters alongside the overrides section', () => {
      const agentConfig = {
        agentId: 'agent-1',
        name: 'Agent One',
        state: 'active',
        config: {
          schema: {
            properties: { temperature: { type: 'number', title: 'Temperature' } },
            required: [],
          },
        },
      };
      renderPanel(makeNode({ agentConfig }));

      expect(screen.getByText('Temperature')).toBeInTheDocument();
      expect(screen.getByText(/execution overrides/i)).toBeInTheDocument();
      expect(screen.getByTestId('model-override')).toBeInTheDocument();
    });
  });
});
