/**
 * CreateToolWizard — tag capture + policy violation tests.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn() },
}));

jest.mock('../../services/fabricatorService', () => ({
  fabricatorService: {
    requestToolCreation: jest.fn(),
  },
}));

jest.mock('../../services/integrationServiceBackend', () => ({
  integrationServiceBackend: { listIntegrations: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../services/datastoreService', () => ({
  datastoreService: { listDataStores: jest.fn().mockResolvedValue([]) },
  DataStoreStatus: { CONNECTED: 'CONNECTED' },
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

// Flatten shadcn Select for jsdom — pass data-testid from SelectTrigger to the
// parent <select> rendered by Select.
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

import { CreateToolWizard } from '../CreateToolWizard';
import { fabricatorService } from '../../services/fabricatorService';
import { toast } from 'sonner';

const fab = fabricatorService as unknown as { requestToolCreation: jest.Mock };

describe('CreateToolWizard — tags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the tag editor', async () => {
    render(
      <CreateToolWizard onBack={jest.fn()} onComplete={jest.fn()} onRequestSubmitted={jest.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());
  });

  it('submits tags in the tool creation request', async () => {
    fab.requestToolCreation.mockResolvedValue({ success: true, requestId: 'r1' });

    render(
      <CreateToolWizard onBack={jest.fn()} onComplete={jest.fn()} onRequestSubmitted={jest.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/validate_email/), {
      target: { value: 'my_tool' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what this tool does/), {
      target: { value: 'It does things' },
    });

    // Set required env tag via the flattened <select>
    const envSelect = screen.getByTestId('tag-value-select-env');
    fireEvent.change(envSelect, { target: { value: 'prod' } });

    fireEvent.click(screen.getByText('Create Tool'));

    await waitFor(() =>
      expect(fab.requestToolCreation).toHaveBeenCalledWith(
        expect.objectContaining({ tags: { env: 'prod' } }),
      ),
    );
  });

  it('renders inline errors on tag policy violation', async () => {
    fab.requestToolCreation.mockRejectedValue(
      new Error('tag_policy_violation: missing required keys: env'),
    );

    render(
      <CreateToolWizard onBack={jest.fn()} onComplete={jest.fn()} onRequestSubmitted={jest.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/validate_email/), {
      target: { value: 'my_tool' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Describe what this tool does/), {
      target: { value: 'It does things' },
    });
    fireEvent.click(screen.getByText('Create Tool'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Tags do not meet the organisation policy'),
    );
  });
});
