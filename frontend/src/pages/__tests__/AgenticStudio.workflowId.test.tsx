/**
 * AgenticStudio — opening a specific workflow.
 *
 * When the studio is given a workflowId (deep link from an app's workflow
 * card), it opens the canvas editor tab directly and hands the id to
 * AgentBlueprints so the workflow is hydrated. Without an id it defaults to
 * the blueprint catalog listing.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../components/AgentBlueprints', () => ({
  AgentBlueprints: ({ workflowId }: { workflowId?: string }) => (
    <div data-testid="agent-blueprints">{workflowId ?? 'no-workflow-id'}</div>
  ),
}));

jest.mock('../../components/BlueprintCatalog', () => ({
  BlueprintCatalog: () => <div data-testid="blueprint-catalog" />,
}));

import { AgenticStudio } from '../AgenticStudio';

describe('AgenticStudio workflow deep link', () => {
  it('defaults to the catalog listing when no workflowId is given', () => {
    render(<AgenticStudio />);
    expect(screen.getByTestId('blueprint-catalog')).toBeInTheDocument();
  });

  it('opens the editor tab and passes the workflowId to AgentBlueprints', () => {
    render(<AgenticStudio workflowId="wf-77" />);
    expect(screen.getByTestId('agent-blueprints')).toHaveTextContent('wf-77');
  });
});
