/**
 * ToolCard unit tests — Deactivate -> Deprecate for registry-backed tools,
 * mirroring AgentCard's pattern (finding 414f8013).
 *
 * Registry-backed APPROVED tools no longer offer Deactivate — only the
 * irreversible, confirm-gated Deprecate action (-> DEPRECATED, wire value
 * state:"maintenance"). DEPRECATED tools are inert (no actions). Legacy
 * (non-registry) tools keep the original Deactivate/Activate toggle
 * unchanged. Also covers the registry status badge (finding c5df5322).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ToolCard } from '../ToolCard';
import type { ToolConfig } from '../../services/toolConfigService';

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

jest.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: any) => React.createElement('div', null, children),
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

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));

jest.mock('../ToolTestingSandbox', () => ({
  ToolTestingSandbox: () => null,
}));

/** Registry-backed fixture: carries the explicit registryStatus discriminator. */
function makeRegistryTool(state: ToolConfig['state'], registryStatus: string = 'APPROVED'): ToolConfig {
  return {
    toolId: 'tool-1',
    config: JSON.stringify({ name: 'Test Tool', description: 'desc' }),
    state,
    categories: [],
    registryStatus,
  };
}

/** Legacy fixture: no registryStatus, matching getToolConfig's shape. */
function makeLegacyTool(state: ToolConfig['state']): ToolConfig {
  return {
    toolId: 'legacy-tool-1',
    config: JSON.stringify({ name: 'Legacy Tool', description: 'desc' }),
    state,
    categories: [],
  } as ToolConfig;
}

describe('ToolCard — registry-backed APPROVED tools', () => {
  const noop = () => {};

  it('does not show Deactivate for an active registry-backed tool', () => {
    render(<ToolCard tool={makeRegistryTool('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('shows Deprecate (not Deactivate) for an active registry-backed tool', () => {
    render(<ToolCard tool={makeRegistryTool('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Deprecate')).toBeInTheDocument();
  });

  it('does not call onToggleState until the confirm dialog is accepted', () => {
    const onToggleState = jest.fn();
    render(<ToolCard tool={makeRegistryTool('active')} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    expect(onToggleState).not.toHaveBeenCalled();
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  it('states the deprecation is irreversible', () => {
    render(<ToolCard tool={makeRegistryTool('active')} onToggleState={noop} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
  });

  it('calls onToggleState with the tool once the confirm dialog is accepted', () => {
    const onToggleState = jest.fn();
    const tool = makeRegistryTool('active');
    render(<ToolCard tool={tool} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    fireEvent.click(screen.getByTestId('deprecate-confirm'));

    expect(onToggleState).toHaveBeenCalledWith(tool);
  });

  it('cancelling the confirm dialog does not call onToggleState', () => {
    const onToggleState = jest.fn();
    render(<ToolCard tool={makeRegistryTool('active')} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deprecate'));
    fireEvent.click(screen.getByTestId('deprecate-cancel'));

    expect(onToggleState).not.toHaveBeenCalled();
  });
});

describe('ToolCard — DEPRECATED registry-backed tools (terminal)', () => {
  const noop = () => {};

  it('renders the state badge as "Deprecated"', () => {
    render(<ToolCard tool={makeRegistryTool('inactive', 'DEPRECATED')} onToggleState={noop} onConfigure={noop} />);

    const badges = screen.getAllByTestId('state-badge');
    expect(badges.some((b) => b.textContent === 'Deprecated')).toBe(true);
  });

  it('shows no actions (no Activate, no Deprecate)', () => {
    render(<ToolCard tool={makeRegistryTool('inactive', 'DEPRECATED')} onToggleState={noop} onConfigure={noop} userRole="admin" />);

    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });
});

describe('ToolCard — legacy (non-registry) tools unchanged', () => {
  const noop = () => {};

  it('shows the Deactivate button (unchanged copy) for an active legacy tool', () => {
    render(<ToolCard tool={makeLegacyTool('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Deactivate')).toBeInTheDocument();
    expect(screen.queryByText('Deprecate')).not.toBeInTheDocument();
  });

  it('calls onToggleState directly (no confirm dialog) when Deactivate is clicked for a legacy tool', () => {
    const onToggleState = jest.fn();
    const tool = makeLegacyTool('active');
    render(<ToolCard tool={tool} onToggleState={onToggleState} onConfigure={noop} />);

    fireEvent.click(screen.getByText('Deactivate'));

    expect(onToggleState).toHaveBeenCalledWith(tool);
    expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
  });

  it('shows the Activate button for an inactive legacy tool, labeled "inactive"', () => {
    render(<ToolCard tool={makeLegacyTool('inactive')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Activate')).toBeInTheDocument();
    expect(screen.getByTestId('state-badge')).toHaveTextContent('inactive');
  });
});

describe('ToolCard — registry status badge (finding c5df5322)', () => {
  const noop = () => {};

  it('shows a "Draft" badge for a DRAFT registry tool', () => {
    render(<ToolCard tool={makeRegistryTool('maintenance', 'DRAFT')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows an "Approved" badge for an APPROVED registry tool', () => {
    render(<ToolCard tool={makeRegistryTool('active', 'APPROVED')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('renders no registry status badge for a legacy tool', () => {
    render(<ToolCard tool={makeLegacyTool('active')} onToggleState={noop} onConfigure={noop} />);

    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });
});
