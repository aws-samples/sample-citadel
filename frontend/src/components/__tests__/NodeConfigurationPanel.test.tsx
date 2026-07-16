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

import { NodeConfigurationPanel } from '../NodeConfigurationPanel';
import type { WorkflowNode } from '../../types/workflow';

function makeNode(overrides: { agentConfig?: any; label?: string } = {}): WorkflowNode {
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
      configuration: {},
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
    it('shows the honest empty-state copy including agent identity', () => {
      renderPanel(makeNode());

      expect(
        screen.getByText(/does not declare configurable parameters/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/not yet applied at runtime/i)).toBeInTheDocument();
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
        screen.queryByText(/does not declare configurable parameters/i)
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
        screen.getByText(/does not declare configurable parameters/i)
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
});
