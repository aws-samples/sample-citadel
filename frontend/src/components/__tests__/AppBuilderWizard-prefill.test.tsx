/**
 * AppBuilderWizard prefill and project-to-app promotion unit tests
 * Tests: "Create App from Project" button visibility, disabled state,
 * wizard prefill propagation, editability of pre-populated values
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, title, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, title, ...props }, children),
}));

jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => React.createElement('input', props),
}));

jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => React.createElement('label', props, children),
}));

jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => React.createElement('textarea', props),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => React.createElement('span', { className }, children),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => React.createElement('div', { 'data-testid': 'card', ...props }, children),
  CardContent: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardDescription: ({ children, ...props }: any) => React.createElement('p', props, children),
  CardHeader: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardTitle: ({ children, ...props }: any) => React.createElement('h3', props, children),
}));

jest.mock('@/components/ui/progress', () => ({
  Progress: ({ value }: any) => React.createElement('div', { role: 'progressbar', 'aria-valuenow': value }),
}));

jest.mock('@/components/ui/status-card', () => ({
  StatusCard: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) => React.createElement('div', null, children),
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    createApp: jest.fn().mockResolvedValue({ appId: 'new-app-1', version: 1 }),
    addAppComponent: jest.fn().mockResolvedValue({}),
    bindWorkflowToApp: jest.fn().mockResolvedValue({}),
    setAppConfigSchema: jest.fn().mockResolvedValue({}),
    setAppConfigValues: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([
      { agentId: 'agent-1', state: 'active', config: { name: 'Agent One', description: 'First agent' } },
      { agentId: 'agent-2', state: 'active', config: { name: 'Agent Two', description: 'Second agent' } },
      { agentId: 'agent-3', state: 'active', config: { name: 'Agent Three', description: 'Third agent' } },
    ]),
  },
}));

jest.mock('@/services/workflowApiService', () => ({
  workflowApiService: {
    listWorkflows: jest.fn().mockResolvedValue({ items: [] }),
  },
}));

jest.mock('@/utils/wizardValidation', () => ({
  validateAppName: jest.fn().mockReturnValue({ valid: true, errors: [] }),
  validateWizardStep: jest.fn().mockReturnValue({ valid: true, errors: [] }),
}));

// ModelOverrideSelect fetches the model catalog; stub it so expanding the
// per-agent overrides section stays network-free.
jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: (props: any) =>
    React.createElement('input', {
      'data-testid': 'model-override',
      value: props.value || '',
      onChange: (e: any) => props.onChange(e.target.value),
    }),
}));

import { ProjectCard } from '../ProjectCard';
import { AppBuilderWizard } from '../../pages/AppBuilderWizard';
import { MAX_SYSTEM_PROMPT_ADDITION_CHARS } from '@/utils/promptLimits';

const completedProject = {
  id: 'proj-done',
  projectId: 'proj-done',
  name: 'Completed Project',
  description: 'A fully implemented project',
  status: 'COMPLETED' as const,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-15T00:00:00Z',
  progress: {
    overall: 100,
    assessment: 100,
    design: 100,
    planning: 100,
    implementation: 100,
    currentPhase: 'Complete',
  },
};

const inProgressProject = {
  ...completedProject,
  id: 'proj-wip',
  projectId: 'proj-wip',
  name: 'WIP Project',
  status: 'IN_PROGRESS' as const,
  progress: {
    overall: 66,
    assessment: 100,
    design: 100,
    planning: 100,
    implementation: 50,
    currentPhase: 'Implementation',
  },
};

describe('ProjectCard — "Create App from Project" button', () => {
  it('shows "Create App from Project" button when implementation === 100%', () => {
    render(
      <ProjectCard
        project={completedProject}
        onSelectAssess={jest.fn()}
        onSelectPlan={jest.fn()}
        onSelectImplement={jest.fn()}
      />,
    );

    expect(screen.getByText('Create App from Project')).toBeInTheDocument();
  });

  it('does not show "Create App from Project" button when implementation < 100%', () => {
    render(
      <ProjectCard
        project={inProgressProject}
        onSelectAssess={jest.fn()}
        onSelectPlan={jest.fn()}
        onSelectImplement={jest.fn()}
      />,
    );

    expect(screen.queryByText('Create App from Project')).not.toBeInTheDocument();
  });

  it('button is clickable when implementation is complete', () => {
    const onCreateApp = jest.fn();
    render(
      <ProjectCard
        project={completedProject}
        onSelectAssess={jest.fn()}
        onSelectPlan={jest.fn()}
        onSelectImplement={jest.fn()}
        onCreateAppFromProject={onCreateApp}
      />,
    );

    const btn = screen.getByText('Create App from Project');
    // Button is enabled when implementation is 100%
    fireEvent.click(btn);
    expect(onCreateApp).toHaveBeenCalledWith(completedProject);
  });
});

describe('AppBuilderWizard — Prefill props', () => {
  it('pre-populates name and description from prefill props', () => {
    render(
      <AppBuilderWizard
        onComplete={jest.fn()}
        prefill={{ name: 'Prefilled App', description: 'From project', agentIds: [], integrationIds: [] }}
      />,
    );

    const nameInput = screen.getByPlaceholderText('My Agent App') as HTMLInputElement;
    expect(nameInput.value).toBe('Prefilled App');

    const descInput = screen.getByPlaceholderText('Describe what this app does...') as HTMLTextAreaElement;
    expect(descInput.value).toBe('From project');
  });

  it('pre-selects agents from prefill agentIds', async () => {
    render(
      <AppBuilderWizard
        onComplete={jest.fn()}
        prefill={{ name: 'Test', description: '', agentIds: ['agent-1', 'agent-3'], integrationIds: [] }}
      />,
    );

    // Navigate to Agents step
    const nextBtn = screen.getByText('Next');
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    // agent-1 and agent-3 should be pre-selected (shown with check marks)
    // We verify by checking the selected state visually
    const agentOneCard = screen.getByText('Agent One').closest('div[class*="border"]');
    const agentThreeCard = screen.getByText('Agent Three').closest('div[class*="border"]');

    // Selected agents have primary border styling (shadcn token)
    expect(agentOneCard?.className).toContain('border-primary');
    expect(agentThreeCard?.className).toContain('border-primary');
  });

  it('pre-populated values are editable', () => {
    render(
      <AppBuilderWizard
        onComplete={jest.fn()}
        prefill={{ name: 'Original Name', description: 'Original Desc', agentIds: [], integrationIds: [] }}
      />,
    );

    const nameInput = screen.getByPlaceholderText('My Agent App') as HTMLInputElement;
    expect(nameInput.value).toBe('Original Name');

    // Edit the name
    fireEvent.change(nameInput, { target: { value: 'Modified Name' } });
    expect(nameInput.value).toBe('Modified Name');

    // Edit the description
    const descInput = screen.getByPlaceholderText('Describe what this app does...') as HTMLTextAreaElement;
    fireEvent.change(descInput, { target: { value: 'Modified Desc' } });
    expect(descInput.value).toBe('Modified Desc');
  });
});

describe('AppBuilderWizard — systemPromptAddition cap (decision 67caf7b0)', () => {
  /** Navigate to the Agents step with agent-1 pre-selected and expand its overrides. */
  async function openAgentOverrides() {
    render(
      <AppBuilderWizard
        onComplete={jest.fn()}
        prefill={{ name: 'Test', description: '', agentIds: ['agent-1'], integrationIds: [] }}
      />,
    );

    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Overrides'));
    return screen.getByPlaceholderText('System prompt addition') as HTMLInputElement;
  }

  it('caps the override field at MAX_SYSTEM_PROMPT_ADDITION_CHARS via maxLength', async () => {
    const field = await openAgentOverrides();

    expect(field).toHaveAttribute(
      'maxlength',
      String(MAX_SYSTEM_PROMPT_ADDITION_CHARS)
    );
  });

  it('shows a live character counter that updates as the user types', async () => {
    const field = await openAgentOverrides();

    expect(screen.getByText(/0\s*\/\s*4000/)).toBeInTheDocument();

    fireEvent.change(field, { target: { value: 'Be terse.' } });

    expect(screen.getByText(/9\s*\/\s*4000/)).toBeInTheDocument();
  });
});
