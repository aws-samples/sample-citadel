/**
 * ResourceBadge & IntegrationBindingTab Component Tests
 * TDD Red Phase — tests written before implementation
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 19.1, 19.2, 19.3, 19.4, 19.5, 27.4
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock workflowApiService
jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    updateWorkflowConfiguration: jest.fn(),
  },
}));

import { ResourceBadge } from '../ResourceBadge';
import { IntegrationBindingTab } from '../IntegrationBindingTab';
import { workflowApiService } from '../../services/workflowApiService';

describe('ResourceBadge', () => {
  it('renders resource name', () => {
    render(
      <ResourceBadge name="S3 Bucket" type="datastore" direction="input" />
    );
    expect(screen.getByText('S3 Bucket')).toBeInTheDocument();
  });

  it('renders type icon for datastore', () => {
    render(
      <ResourceBadge name="DynamoDB" type="datastore" direction="input" />
    );
    expect(screen.getByTestId('resource-icon-datastore')).toBeInTheDocument();
  });

  it('renders type icon for integration', () => {
    render(
      <ResourceBadge name="Slack API" type="integration" direction="output" />
    );
    expect(screen.getByTestId('resource-icon-integration')).toBeInTheDocument();
  });

  it('renders ← indicator for input direction', () => {
    render(
      <ResourceBadge name="Input DB" type="datastore" direction="input" />
    );
    expect(screen.getByText('←')).toBeInTheDocument();
  });

  it('renders → indicator for output direction', () => {
    render(
      <ResourceBadge name="Output API" type="integration" direction="output" />
    );
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('renders ↔ indicator for bidirectional direction', () => {
    render(
      <ResourceBadge name="Shared DB" type="datastore" direction="bidirectional" />
    );
    expect(screen.getByText('↔')).toBeInTheDocument();
  });
});

describe('IntegrationBindingTab', () => {
  const defaultBindings = [
    { toolId: 'tool-1', toolName: 'Email Sender', status: 'bound' as const, integrationId: 'int-1' },
    { toolId: 'tool-2', toolName: 'Slack Notifier', status: 'unbound' as const, integrationId: null },
    { toolId: 'tool-3', toolName: 'DB Reader', status: 'overridden' as const, integrationId: 'int-3' },
  ];

  it('lists all tools with their names', () => {
    render(
      <IntegrationBindingTab
        bindings={defaultBindings}
        workflowId="wf-1"
        agentId="agent-1"
        version={1}
        onSaved={jest.fn()}
      />
    );
    expect(screen.getByText('Email Sender')).toBeInTheDocument();
    expect(screen.getByText('Slack Notifier')).toBeInTheDocument();
    expect(screen.getByText('DB Reader')).toBeInTheDocument();
  });

  it('displays bound status indicator', () => {
    render(
      <IntegrationBindingTab
        bindings={defaultBindings}
        workflowId="wf-1"
        agentId="agent-1"
        version={1}
        onSaved={jest.fn()}
      />
    );
    const boundBadge = screen.getByTestId('binding-status-tool-1');
    expect(boundBadge).toHaveTextContent(/bound/i);
  });

  it('displays unbound status indicator', () => {
    render(
      <IntegrationBindingTab
        bindings={defaultBindings}
        workflowId="wf-1"
        agentId="agent-1"
        version={1}
        onSaved={jest.fn()}
      />
    );
    const unboundBadge = screen.getByTestId('binding-status-tool-2');
    expect(unboundBadge).toHaveTextContent(/unbound/i);
  });

  it('displays overridden status indicator', () => {
    render(
      <IntegrationBindingTab
        bindings={defaultBindings}
        workflowId="wf-1"
        agentId="agent-1"
        version={1}
        onSaved={jest.fn()}
      />
    );
    const overriddenBadge = screen.getByTestId('binding-status-tool-3');
    expect(overriddenBadge).toHaveTextContent(/overridden/i);
  });

  it('saves binding override to WorkflowConfiguration via updateWorkflowConfiguration', async () => {
    const user = userEvent.setup();
    const onSaved = jest.fn();
    (workflowApiService.updateWorkflowConfiguration as jest.Mock).mockResolvedValue({
      workflowId: 'wf-1',
      version: 2,
    });

    render(
      <IntegrationBindingTab
        bindings={defaultBindings}
        workflowId="wf-1"
        agentId="agent-1"
        version={1}
        onSaved={onSaved}
      />
    );

    // Click override button on the unbound tool
    const overrideButton = screen.getByTestId('override-btn-tool-2');
    await user.click(overrideButton);

    // Fill in the override integration ID
    const overrideInput = screen.getByTestId('override-input-tool-2');
    await user.type(overrideInput, 'new-int-id');

    // Save
    const saveButton = screen.getByRole('button', { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(workflowApiService.updateWorkflowConfiguration).toHaveBeenCalledWith(
        'wf-1',
        expect.any(String),
        1
      );
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });
});
