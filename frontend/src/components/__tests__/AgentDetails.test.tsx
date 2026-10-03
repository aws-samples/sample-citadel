/**
 * AgentDetails unit tests — Deactivate -> Deprecate for registry-backed
 * agents, mirroring AgentCard's pattern (finding 414f8013).
 *
 * Registry-backed APPROVED agents no longer offer Deactivate in the header
 * actions — only the confirm-gated, irreversible Deprecate action
 * (-> DEPRECATED, wire value state:"maintenance"). DEPRECATED agents show
 * no toggle action. Legacy (non-registry) agents keep the original
 * Deactivate/Activate toggle unchanged. Also covers the registry status
 * badge (finding c5df5322).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../AgentConfig', () => ({
  AgentConfigTab: ({ onSave }: { onSave: () => void }) =>
    React.createElement('button', { onClick: onSave }, 'Save Details'),
}));
jest.mock('../AgentCode', () => ({
  AgentCodeTab: ({ onSave }: { onSave: () => void }) =>
    React.createElement('button', { onClick: onSave }, 'Save Code'),
}));
jest.mock('../ApprovalHistory', () => ({
  ApprovalHistory: ({ agent }: any) =>
    agent.registryStatus
      ? React.createElement('div', { 'data-testid': 'approval-history' }, `Status: ${agent.registryStatus}`)
      : null,
}));

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    getAgentConfig: jest.fn(),
    updateAgentConfig: jest.fn(),
    deleteAgentConfig: jest.fn(),
    getAgentCode: jest.fn(),
    updateAgentCode: jest.fn(),
  },
}));

import { AgentDetails } from '../AgentDetails';
import { agentConfigService } from '../../services/agentConfigService';

function makeRegistryAgent(state: string, registryStatus: string = 'APPROVED') {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    config: { name: 'Test Agent' },
    state,
    categories: [],
    registryStatus,
  };
}

function makeLegacyAgent(state: string) {
  return {
    agentId: 'legacy-agent-1',
    config: { name: 'Legacy Agent' },
    state,
    categories: [],
  };
}

describe('AgentDetails — registry-backed APPROVED agents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('does not show Deactivate for an active registry-backed agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Test Agent')).toBeInTheDocument());
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('shows Deprecate for an active registry-backed agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Deprecate')).toBeInTheDocument());
  });

  it('does not call updateAgentConfig until the confirm dialog is accepted', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Deprecate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Deprecate'));
    expect(agentConfigService.updateAgentConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
  });

  it('sends state "maintenance" once the confirm dialog is accepted', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Deprecate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Deprecate'));
    const deprecateButtons = screen.getAllByText('Deprecate');
    fireEvent.click(deprecateButtons[deprecateButtons.length - 1]);

    await waitFor(() =>
      expect(agentConfigService.updateAgentConfig).toHaveBeenCalledWith({
        agentId: 'agent-1',
        state: 'maintenance',
      }),
    );
  });

  it('shows the registry status badge distinct from the state badge', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active', 'APPROVED'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Approved')).toBeInTheDocument());
    expect(screen.getByText('active')).toBeInTheDocument();
  });
});

describe('AgentDetails — DEPRECATED registry-backed agents (terminal)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('shows no Deactivate/Activate/Deprecate action', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('inactive', 'DEPRECATED'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Test Agent')).toBeInTheDocument());
    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });
});

describe('AgentDetails — legacy (non-registry) agents unchanged', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('shows Deactivate (unchanged) for an active legacy agent and calls updateAgentConfig directly', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeLegacyAgent('active'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="legacy-agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Deactivate')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Deactivate'));

    await waitFor(() =>
      expect(agentConfigService.updateAgentConfig).toHaveBeenCalledWith({
        agentId: 'legacy-agent-1',
        state: 'inactive',
      }),
    );
  });

  it('renders no registry status badge for a legacy agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeLegacyAgent('active'));

    render(<AgentDetails agentId="legacy-agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Deactivate')).toBeInTheDocument());

    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
  });
});

describe('AgentDetails — confirm before saving content edits to an approved registry record', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('shows the re-approval confirmation and does not save until confirmed, for a registry-backed active agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Save Details')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Save Details'));

    expect(await screen.findByText('Saving will require re-approval')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This agent is approved. Saving changes moves it back to Draft in the registry; use Activate afterwards to resubmit it for approval.',
      ),
    ).toBeInTheDocument();
    expect(agentConfigService.updateAgentConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Cancel'));
    expect(agentConfigService.updateAgentConfig).not.toHaveBeenCalled();
  });

  it('saves and refreshes the agent after confirming, for a registry-backed active agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock)
      .mockResolvedValueOnce(makeRegistryAgent('active', 'APPROVED'))
      .mockResolvedValueOnce(makeRegistryAgent('maintenance', 'DRAFT'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Save Details')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Save Details'));
    fireEvent.click(await screen.findByText('Save'));

    await waitFor(() => expect(agentConfigService.updateAgentConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(agentConfigService.getAgentConfig).toHaveBeenCalledTimes(2));
  });

  it('saves directly without a confirmation for a non-approved (draft) registry-backed agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('maintenance', 'DRAFT'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Save Details')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Save Details'));

    await waitFor(() => expect(agentConfigService.updateAgentConfig).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Saving will require re-approval')).not.toBeInTheDocument();
  });
});

describe('AgentDetails — confirm before saving code edits to an approved registry record', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('opens the confirm on Code tab save for an active registry-backed agent and does not save until confirmed', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active'));
    (agentConfigService.updateAgentConfig as jest.Mock).mockResolvedValue({});
    (agentConfigService.updateAgentCode as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Test Agent')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Code'));
    fireEvent.click(screen.getByText('Save Code'));

    expect(await screen.findByText('Saving will require re-approval')).toBeInTheDocument();
    expect(agentConfigService.updateAgentCode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(agentConfigService.updateAgentCode).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(agentConfigService.updateAgentConfig).toHaveBeenCalledTimes(1));
  });

  it('saves code directly without a confirmation for a legacy agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeLegacyAgent('active'));
    (agentConfigService.updateAgentCode as jest.Mock).mockResolvedValue({});

    render(<AgentDetails agentId="legacy-agent-1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Code')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Code'));
    fireEvent.click(screen.getByText('Save Code'));

    await waitFor(() => expect(agentConfigService.updateAgentCode).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Saving will require re-approval')).not.toBeInTheDocument();
  });
});

describe('AgentDetails — ApprovalHistory wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agentConfigService.getAgentCode as jest.Mock).mockRejectedValue(new Error('no code'));
  });

  it('renders ApprovalHistory for a registry-backed agent in the Details tab', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeRegistryAgent('active', 'APPROVED'));

    render(<AgentDetails agentId="agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('approval-history')).toBeInTheDocument());
    expect(screen.getByTestId('approval-history')).toHaveTextContent('Status: APPROVED');
  });

  it('does not render ApprovalHistory for a legacy agent', async () => {
    (agentConfigService.getAgentConfig as jest.Mock).mockResolvedValue(makeLegacyAgent('active'));

    render(<AgentDetails agentId="legacy-agent-1" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Legacy Agent')).toBeInTheDocument());
    expect(screen.queryByTestId('approval-history')).not.toBeInTheDocument();
  });
});
