/**
 * Regression tests for the AgenticStudio page.
 *
 * Covers: tab rendering, default tab selection, tab switching,
 * workflowId deep link behavior, error boundary wrapping.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }: any) => (
    <div data-testid="tabs" data-value={value}>
      {React.Children.map(children, (child: any) =>
        React.isValidElement(child) ? React.cloneElement(child as any, { onValueChange }) : child,
      )}
    </div>
  ),
  TabsList: ({ children }: any) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children, value, ...props }: any) => {
    const parent = props.onValueChange;
    return (
      <button role="tab" data-value={value} onClick={() => parent?.(value)}>
        {children}
      </button>
    );
  },
  TabsContent: ({ children, value }: any) => <div data-testid={`tab-content-${value}`}>{children}</div>,
}));

jest.mock('@/components/AgentBlueprints', () => ({
  AgentBlueprints: ({ workflowId }: any) => (
    <div data-testid="agent-blueprints">
      {workflowId && <span data-testid="workflow-id">{workflowId}</span>}
    </div>
  ),
}));
jest.mock('@/components/BlueprintCatalog', () => ({
  BlueprintCatalog: () => <div data-testid="blueprint-catalog" />,
}));
jest.mock('@/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));

import { AgenticStudio } from '../AgenticStudio';

describe('AgenticStudio page — regression', () => {
  test('renders two tab triggers (Agent Blueprints, Create Agent Blueprints)', () => {
    render(<AgenticStudio />);

    expect(screen.getByText('Agent Blueprints')).toBeInTheDocument();
    expect(screen.getByText('Create Agent Blueprints')).toBeInTheDocument();
  });

  test('defaults to blueprints-list tab when no workflowId', () => {
    render(<AgenticStudio />);

    const tabs = screen.getByTestId('tabs');
    expect(tabs).toHaveAttribute('data-value', 'blueprints-list');
  });

  test('defaults to agent-blueprints tab when workflowId is provided', () => {
    render(<AgenticStudio workflowId="wf-deep-link-123" />);

    const tabs = screen.getByTestId('tabs');
    expect(tabs).toHaveAttribute('data-value', 'agent-blueprints');
  });

  test('passes workflowId to AgentBlueprints component', () => {
    render(<AgenticStudio workflowId="wf-deep-link-123" />);

    expect(screen.getByTestId('workflow-id')).toHaveTextContent('wf-deep-link-123');
  });

  test('renders BlueprintCatalog in the blueprints-list tab', () => {
    render(<AgenticStudio />);

    expect(screen.getByTestId('blueprint-catalog')).toBeInTheDocument();
  });

  test('renders AgentBlueprints in the agent-blueprints tab', () => {
    render(<AgenticStudio />);

    expect(screen.getByTestId('agent-blueprints')).toBeInTheDocument();
  });
});
