/**
 * CreateAgentWizard — tag capture + policy violation tests.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn() },
}));

jest.mock('../../services/fabricatorService', () => ({
  fabricatorService: {
    requestAgentCreation: jest.fn(),
  },
}));

jest.mock('../../services/toolConfigService', () => ({
  toolConfigService: { listToolConfigs: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../services/integrationServiceBackend', () => ({
  integrationServiceBackend: { listIntegrations: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../services/datastoreService', () => ({
  datastoreService: { listDataStores: jest.fn().mockResolvedValue([]) },
  DataStoreStatus: { CONNECTED: 'CONNECTED' },
  DataStoreCategory: {},
  DataStoreUsage: {},
}));

jest.mock('../../config/connectorRegistry', () => ({
  getConnectorDefinition: jest.fn(),
}));

jest.mock('../../services/tagPolicyService', () => ({
  tagPolicyService: {
    getTagPolicy: jest.fn().mockResolvedValue({
      requiredKeys: [{ key: 'env', allowedValues: ['prod', 'staging'] }],
      version: 1, updatedBy: 'admin', updatedAt: '2026-01-01T00:00:00Z',
    }),
  },
}));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'acme-org' }),
}));

// Flatten shadcn Select for jsdom — pass data-testid from SelectTrigger to parent <select>.
jest.mock('../ui/select', () => {
  const R = require('react');
  const ctx = R.createContext({});
  return {
    Select: ({ value, onValueChange, children }: any) => {
      const [testId, setTestId] = R.useState(undefined);
      return R.createElement(ctx.Provider, { value: { setTestId } },
        R.createElement('select', {
          value: value ?? '',
          'data-testid': testId,
          onChange: (e: any) => onValueChange?.(e.target.value),
        }, children),
      );
    },
    SelectTrigger: ({ children, ...rest }: any) => {
      const { setTestId } = R.useContext(ctx);
      R.useEffect(() => { if (rest['data-testid'] && setTestId) setTestId(rest['data-testid']); }, []);
      return R.createElement(R.Fragment, null, children);
    },
    SelectValue: () => null,
    SelectContent: ({ children }: any) => R.createElement(R.Fragment, null, children),
    SelectItem: ({ children, value }: any) => R.createElement('option', { value }, children),
  };
});

import { CreateAgentWizard } from '../CreateAgentWizard';
import { fabricatorService } from '../../services/fabricatorService';
import { toast } from 'sonner';

const fab = fabricatorService as unknown as { requestAgentCreation: jest.Mock };

describe('CreateAgentWizard — tags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the tag editor on the details step', async () => {
    render(<CreateAgentWizard onBack={jest.fn()} onComplete={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());
  });

  it('submits tags in the fabrication request', async () => {
    fab.requestAgentCreation.mockResolvedValue({ success: true, requestId: 'r1' });

    render(<CreateAgentWizard onBack={jest.fn()} onComplete={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    // Fill required fields
    fireEvent.change(screen.getByPlaceholderText('e.g., Customer Support Agent'), {
      target: { value: 'My Agent' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what this agent/), {
      target: { value: 'Does stuff' },
    });

    // Set the required tag value via the select
    const envSelect = screen.getByTestId('tag-value-select-env');
    fireEvent.change(envSelect, { target: { value: 'prod' } });

    // Navigate through wizard steps to review
    const nextBtn = () => screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn()); // -> tools
    fireEvent.click(nextBtn()); // -> datastores
    fireEvent.click(nextBtn()); // -> review
    await waitFor(() => expect(screen.getByText('Create Agent')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Create Agent'));

    await waitFor(() =>
      expect(fab.requestAgentCreation).toHaveBeenCalledWith(
        expect.objectContaining({ tags: { env: 'prod' } }),
      ),
    );
  });

  it('renders inline errors on tag policy violation', async () => {
    fab.requestAgentCreation.mockRejectedValue(
      new Error('tag_policy_violation: missing required keys: env'),
    );

    render(<CreateAgentWizard onBack={jest.fn()} onComplete={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g., Customer Support Agent'), {
      target: { value: 'My Agent' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what this agent/), {
      target: { value: 'Does stuff' },
    });

    // Navigate through wizard steps to review
    const nextBtn = () => screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn());
    fireEvent.click(nextBtn());
    fireEvent.click(nextBtn());
    await waitFor(() => expect(screen.getByText('Create Agent')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Create Agent'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Tags do not meet the organisation policy'),
    );
  });
});
