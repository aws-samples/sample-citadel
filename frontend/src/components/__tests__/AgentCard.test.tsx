/**
 * AgentCard unit tests — Deactivate -> Deprecate for registry-backed agents
 * (decision 3d5843e9, supersedes a3fb5542)
 *
 * The AWS AgentCore Registry rejects APPROVED -> DRAFT (the old Deactivate
 * target), so registry-backed APPROVED agents no longer offer Deactivate at
 * all. Instead they offer an explicit, confirm-gated Deprecate action
 * (-> DEPRECATED, irreversible). Legacy (non-registry) agents keep the
 * original Deactivate/Activate toggle unchanged.
 *
 * A record is registry-backed iff it carries the explicit `registryStatus`
 * discriminator (finding 414f8013) — the raw Registry record status set
 * only by RegistryService.mapToAgentConfig. Legacy DynamoDB rows never set
 * it (see backend/src/lambda/agent-config-resolver.ts's getAgentConfig).
 * Fixtures below omit `registryStatus` to model legacy agents.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentCard } from '../AgentCard';
import type { AgentConfig } from '../../services/agentConfigService';

jest.mock('../ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('../ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'state-badge' }, children),
}));

jest.mock('../ui/card', () => ({
  Card: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardContent: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardDescription: ({ children, className }: any) => React.createElement('p', { className }, children),
  CardHeader: ({ children, className }: any) => React.createElement('div', { className }, children),
  CardTitle: ({ children, className }: any) => React.createElement('h3', { className }, children),
}));

jest.mock('../ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'alert-dialog' }, children) : null,
  AlertDialogContent: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogHeader: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogFooter: ({ children }: any) => React.createElement('div', null, children),
  AlertDialogTitle: ({ children }: any) => React.createElement('h2', null, children),
  AlertDialogDescription: ({ children }: any) => React.createElement('p', null, children),
  AlertDialogAction: ({ children, onClick }: any) =>
    React.createElement('button', { onClick, 'data-testid': 'deprecate-confirm' }, children),
  AlertDialogCancel: ({ children, onClick }: any) =>
    React.createElement('button', { onClick, 'data-testid': 'deprecate-cancel' }, children),
}));

/** Registry-backed fixture: always carries the explicit registryStatus discriminator. */
function makeRegistryAgent(state: AgentConfig['state'], registryStatus: string = 'APPROVED'): AgentConfig {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    config: {},
    state,
    categories: [],
    registryStatus,
  };
}

/** Legacy fixture: no registryStatus at all, matching getAgentConfig's shape. */
function makeLegacyAgent(state: AgentConfig['state']): AgentConfig {
  return {
    agentId: 'legacy-agent-1',
    config: { name: 'Legacy Agent' },
    state,
    categories: [],
  } as AgentConfig;
}

describe('AgentCard — registry-backed APPROVED agents', () => {
  const noop = () => {};

  it('does not show Deactivate for an active registry-backed agent', () => {
    render(<AgentCard agent={makeRegistryAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('shows Deprecate (not Deactivate) for an active registry-backed agent', () => {
    render(<AgentCard agent={makeRegistryAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Deprecate')).toBeInTheDocument();
  });

  it('does not call onToggleState until the confirm dialog is accepted', () => {
    const onToggleState = jest.fn();
    render(<AgentCard agent={makeRegistryAgent('active')} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    expect(onToggleState).not.toHaveBeenCalled();
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  it('states the deprecation is irreversible and the agent will not be dispatchable or releasable', () => {
    render(<AgentCard agent={makeRegistryAgent('active')} onToggleState={noop} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer be\s*\n?\s*dispatchable or releasable/i)).toBeInTheDocument();
  });

  it('calls onToggleState with the agent once the confirm dialog is accepted', () => {
    const onToggleState = jest.fn();
    const agent = makeRegistryAgent('active');
    render(<AgentCard agent={agent} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    fireEvent.click(screen.getByTestId('deprecate-confirm'));

    expect(onToggleState).toHaveBeenCalledWith(agent);
  });

  it('cancelling the confirm dialog does not call onToggleState', () => {
    const onToggleState = jest.fn();
    render(<AgentCard agent={makeRegistryAgent('active')} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    fireEvent.click(screen.getByTestId('deprecate-cancel'));

    expect(onToggleState).not.toHaveBeenCalled();
  });

  it('keeps Activate for an inactive (non-deprecated) legacy-shaped state check does not apply to registry Activate copy', () => {
    // Activate must remain available/unchanged in copy for a registry
    // record that is not currently active (e.g. freshly created DRAFT
    // surfaced as 'maintenance').
    render(<AgentCard agent={makeRegistryAgent('maintenance')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Activate')).toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });
});

describe('AgentCard — DEPRECATED registry-backed agents (terminal)', () => {
  const noop = () => {};

  it('renders the state badge as "Deprecated"', () => {
    render(<AgentCard agent={makeRegistryAgent('inactive', 'DEPRECATED')} onToggleState={noop} onConfigure={noop} />);

    const badges = screen.getAllByTestId('state-badge');
    expect(badges.some((b) => b.textContent === 'Deprecated')).toBe(true);
  });

  it('shows no actions (no Activate, no Deprecate, no Configure)', () => {
    render(
      <AgentCard
        agent={makeRegistryAgent('inactive', 'DEPRECATED')}
        onToggleState={noop}
        onConfigure={noop}
        userRole="admin"
      />,
    );

    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });
});

describe('AgentCard — legacy (non-registry) agents unchanged', () => {
  const noop = () => {};

  it('shows the Deactivate button (unchanged copy) for an active legacy agent', () => {
    render(<AgentCard agent={makeLegacyAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });

  it('calls onToggleState directly (no confirm dialog) when Deactivate is clicked for a legacy agent', () => {
    const onToggleState = jest.fn();
    const agent = makeLegacyAgent('active');
    render(<AgentCard agent={agent} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deactivate'));

    expect(onToggleState).toHaveBeenCalledWith(agent);
    expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
  });

  it('shows the Activate button for an inactive legacy agent, labeled "inactive"', () => {
    render(<AgentCard agent={makeLegacyAgent('inactive')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Activate')).toBeInTheDocument();
    expect(screen.getByTestId('state-badge')).toHaveTextContent('inactive');
  });

  it('labels a "maintenance"-state legacy agent as "maintenance" (relabel reverted)', () => {
    render(<AgentCard agent={makeLegacyAgent('maintenance')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByTestId('state-badge')).toHaveTextContent('maintenance');
  });
});

describe('AgentCard — registry status badge (finding c5df5322)', () => {
  const noop = () => {};

  it('shows a "Draft" badge distinct from the state toggle badge for a DRAFT registry agent', () => {
    render(<AgentCard agent={makeRegistryAgent('maintenance', 'DRAFT')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows a "Pending approval" badge for a PENDING_APPROVAL registry agent', () => {
    render(<AgentCard agent={makeRegistryAgent('active', 'PENDING_APPROVAL')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Pending approval')).toBeInTheDocument();
  });

  it('shows an "Approved" badge for an APPROVED registry agent', () => {
    render(<AgentCard agent={makeRegistryAgent('active', 'APPROVED')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('renders no registry status badge for a legacy agent', () => {
    render(<AgentCard agent={makeLegacyAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });
});
