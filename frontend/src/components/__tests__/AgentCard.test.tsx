/**
 * AgentCard unit tests — status label (decision a3fb5542)
 *
 * Catalog Deactivate now returns an APPROVED registry record to DRAFT
 * (internal state 'maintenance') instead of the terminal DEPRECATED. The
 * Catalog must label a 'maintenance'-state agent "inactive", not
 * "maintenance" (a distinct meaning used elsewhere, e.g. the workflow
 * canvas) and not "activated". The Activate button's copy/behavior is
 * unchanged.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
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

function makeAgent(state: AgentConfig['state']): AgentConfig {
  return {
    agentId: 'agent-1',
    name: 'Test Agent',
    config: {},
    state,
    categories: [],
  };
}

describe('AgentCard status label', () => {
  const noop = () => {};

  it('labels a "maintenance"-state (DRAFT) agent as "inactive"', () => {
    render(
      <AgentCard agent={makeAgent('maintenance')} onToggleState={noop} onConfigure={noop} />,
    );

    const badge = screen.getByTestId('state-badge');
    expect(badge).toHaveTextContent('inactive');
    expect(badge).not.toHaveTextContent('maintenance');
  });

  it('labels an "active"-state agent as "active"', () => {
    render(<AgentCard agent={makeAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByTestId('state-badge')).toHaveTextContent('active');
  });

  it('labels an "inactive"-state agent as "inactive"', () => {
    render(<AgentCard agent={makeAgent('inactive')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByTestId('state-badge')).toHaveTextContent('inactive');
  });

  it('shows the Activate button (unchanged copy) for a "maintenance"-state agent', () => {
    render(
      <AgentCard agent={makeAgent('maintenance')} onToggleState={noop} onConfigure={noop} />,
    );

    expect(screen.getByText('Activate')).toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('shows the Deactivate button (unchanged copy) for an "active"-state agent', () => {
    render(<AgentCard agent={makeAgent('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
  });
});
