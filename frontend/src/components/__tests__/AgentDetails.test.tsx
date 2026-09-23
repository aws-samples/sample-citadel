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
  AgentConfigTab: () => React.createElement('div', { 'data-testid': 'agent-config-tab' }),
}));
jest.mock('../AgentCode', () => ({
  AgentCodeTab: () => null,
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
