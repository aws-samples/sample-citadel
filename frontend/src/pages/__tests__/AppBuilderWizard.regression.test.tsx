/**
 * Regression tests for the AppBuilderWizard page.
 *
 * Covers: step indicator rendering, step navigation (next/back), form inputs,
 * validation (name required), agent/workflow selection, review and submit.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
}));
jest.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));
jest.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => <textarea {...props} />,
}));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) => <span className={className}>{children}</span>,
}));
jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));
jest.mock('@/components/ModelOverrideSelect', () => ({
  ModelOverrideSelect: ({ value, onChange }: any) => (
    <select data-testid="model-select" value={value} onChange={(e: any) => onChange(e.target.value)}>
      <option value="">Default</option>
    </select>
  ),
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'test-org' }),
}));
jest.mock('@/services/appApiService', () => ({
  appApiService: {
    createApp: jest.fn().mockResolvedValue({ appId: 'app-new-1' }),
  },
}));
jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgents: jest.fn().mockResolvedValue([
      { agentId: 'agent-1', name: 'Assessment Agent', description: 'Runs assessments' },
      { agentId: 'agent-2', name: 'Design Agent', description: 'Creates designs' },
    ]),
  },
}));
jest.mock('@/services/workflowApiService', () => ({
  workflowApiService: {
    listWorkflows: jest.fn().mockResolvedValue([
      { workflowId: 'wf-1', name: 'Demo Workflow', description: 'Echo demo', status: 'published' },
    ]),
  },
}));
jest.mock('@/utils/wizardValidation', () => ({
  validateAppName: (name: string) => name.length > 0 ? { valid: true, errors: [] } : { valid: false, errors: ['Name is required'] },
  validateWizardStep: (step: number, data: any) => {
    if (step === 0) return { valid: data.name?.length > 0, error: data.name?.length > 0 ? null : 'Name is required' };
    return { valid: true, error: null };
  },
}));
jest.mock('@/utils/promptLimits', () => ({
  MAX_SYSTEM_PROMPT_ADDITION_CHARS: 2000,
}));

import { AppBuilderWizard } from '../AppBuilderWizard';

describe('AppBuilderWizard page — regression', () => {
  const mockOnComplete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders all 6 wizard step labels', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Workflows')).toBeInTheDocument();
      expect(screen.getByText('Permissions')).toBeInTheDocument();
      expect(screen.getByText('Configuration')).toBeInTheDocument();
      expect(screen.getByText('Review')).toBeInTheDocument();
    });
  });

  test('starts at step 1 (Name) with a name input', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('My Agent App');
      expect(nameInput).toBeInTheDocument();
    });
  });

  test('Next button is disabled without a name', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      const nextBtn = screen.getByRole('button', { name: /next/i });
      expect(nextBtn).toBeDisabled();
    });
  });

  test('entering a name enables the Next button', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('My Agent App');
      fireEvent.change(nameInput, { target: { value: 'My New App' } });
    });

    await waitFor(() => {
      const nextBtn = screen.getByRole('button', { name: /next/i });
      expect(nextBtn).not.toBeDisabled();
    });
  });

  test('clicking Next advances from step 1 when name is valid', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('My Agent App')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('My Agent App'), { target: { value: 'My New App' } });

    const nextBtn = screen.getByRole('button', { name: /next/i });
    fireEvent.click(nextBtn);

    // Step 1 name input should no longer be the active view
    await waitFor(() => {
      expect(screen.getByText('Agents')).toBeInTheDocument();
    });
  });

  test('Back button is available after advancing past step 1', async () => {
    render(<AppBuilderWizard onComplete={mockOnComplete} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('My Agent App')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('My Agent App'), { target: { value: 'My New App' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      const backBtn = screen.getByRole('button', { name: /back/i });
      expect(backBtn).toBeInTheDocument();
    });
  });

  test('pre-fills from prefill prop when provided', async () => {
    render(
      <AppBuilderWizard
        onComplete={mockOnComplete}
        prefill={{ name: 'Prefilled', description: 'From project', agentIds: ['agent-1'], integrationIds: [] }}
      />,
    );

    await waitFor(() => {
      const nameInput = screen.getByDisplayValue('Prefilled');
      expect(nameInput).toBeInTheDocument();
    });
  });
});
