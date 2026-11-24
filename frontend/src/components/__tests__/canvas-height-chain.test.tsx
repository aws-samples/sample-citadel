/**
 * Canvas height-chain test — documents the CSS class contract that keeps the
 * blueprint / workflow canvas page bounded to the viewport.
 *
 * Without min-h-0 on flex children in the layout chain, the agent tray's list
 * drives the page height past the viewport and the canvas becomes very tall.
 *
 * Intent: the page = viewport height; the tray scrolls internally; the canvas
 * fills the remaining width/height.
 */

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../WorkflowCanvas', () => ({
  WorkflowCanvas: () => <div data-testid="mock-canvas" />,
}));
jest.mock('../WorkflowToolbar', () => ({ WorkflowToolbar: () => <div data-testid="toolbar" /> }));
jest.mock('../NodeConfigurationPanel', () => ({ NodeConfigurationPanel: () => null }));

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../AgentNode', () => ({ AgentNode: () => null }));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1', currentUser: { organization: 'org-1' } }),
}));

jest.mock('../../services/workflowApiService', () => ({
  workflowApiService: {
    saveWorkflow: jest.fn(),
    loadWorkflow: jest.fn(),
    listWorkflows: jest.fn().mockResolvedValue([]),
    createWorkflow: jest.fn(),
    updateWorkflow: jest.fn(),
    getWorkflow: jest.fn(),
    publishWorkflow: jest.fn(),
  },
}));
jest.mock('../../services/executionApiService', () => ({
  executionApiService: {
    startExecution: jest.fn(),
    cancelExecution: jest.fn(),
  },
}));
jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../services/server', () => ({
  __esModule: true,
  default: { subscribe: jest.fn() },
}));
jest.mock('../../hooks/useScreenReader', () => ({
  useScreenReader: () => ({ announce: jest.fn() }),
}));
jest.mock('../../utils/resolveToolBindings', () => ({
  resolveToolBindings: () => Promise.resolve([]),
}));

import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentBlueprints } from '../AgentBlueprints';
import { MemoryRouter } from 'react-router-dom';

function renderBlueprints() {
  return render(
    <MemoryRouter>
      <AgentBlueprints />
    </MemoryRouter>,
  );
}

describe('canvas height-chain classes', () => {
  it('agent tray scroll container has overflow-y-auto and min-h-0', () => {
    const { container } = renderBlueprints();
    // The ScrollArea inside the agent tray nav is the internal scroll container.
    const scrollArea = container.querySelector('.agent-tray-scroll');
    expect(scrollArea).toBeInTheDocument();
    expect(scrollArea!.className).toMatch(/\boverflow-y-auto\b/);
    expect(scrollArea!.className).toMatch(/\bmin-h-0\b/);
  });

  it('canvas host main element has min-h-0 and min-w-0', () => {
    const { container } = renderBlueprints();
    const canvasMain = container.querySelector('main#workflow-canvas');
    expect(canvasMain).toBeInTheDocument();
    expect(canvasMain!.className).toMatch(/\bmin-h-0\b/);
    expect(canvasMain!.className).toMatch(/\bmin-w-0\b/);
  });

  it('flex row container has min-h-0 to allow flex-1 to shrink', () => {
    const { container } = renderBlueprints();
    const canvasMain = container.querySelector('main#workflow-canvas');
    const flexRow = canvasMain?.parentElement;
    expect(flexRow).toBeInTheDocument();
    expect(flexRow!.className).toMatch(/\bflex\b/);
    expect(flexRow!.className).toMatch(/\bflex-1\b/);
    expect(flexRow!.className).toMatch(/\bmin-h-0\b/);
  });
});
