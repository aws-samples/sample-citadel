/**
 * ImportAgentWizard — tag capture + policy violation tests.
 *
 * Reuses the same mock patterns as ImportAgentWizard.test.tsx (Select
 * flattened, Checkbox flattened, agentImportService mocked).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn() },
}));

jest.mock('../../services/agentImportService', () => ({
  agentImportService: {
    discoverAgents: jest.fn(),
    describeAgentCandidate: jest.fn(),
    importAgent: jest.fn(),
    attestAgentImport: jest.fn(),
    testImportedAgent: jest.fn(),
    proposeAgentManifestTier3: jest.fn(),
    acceptProposedManifestTier3: jest.fn(),
    getImportRecord: jest.fn(),
  },
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
  useOrganization: () => ({
    currentUser: { role: 'architect', organization: 'acme-org' },
  }),
}));

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

jest.mock('../ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: any) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: !!checked,
      onChange: (e: any) => onCheckedChange?.(e.target.checked),
      ...rest,
    }),
}));

import { ImportAgentWizard } from '../ImportAgentWizard';
import { agentImportService } from '../../services/agentImportService';
import { toast } from 'sonner';

const svc = agentImportService as unknown as {
  discoverAgents: jest.Mock;
  describeAgentCandidate: jest.Mock;
  importAgent: jest.Mock;
  testImportedAgent: jest.Mock;
};

const candidate = {
  displayName: 'Orders Agent',
  reference: 'ref-orders-1',
  substrate: 'AGENTCORE',
  sourceArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orders',
  region: 'us-east-1',
  account: '111122223333',
  ownership: 'external',
  discoveredAt: '2026-06-28T00:00:00Z',
};

const descriptor = {
  name: 'Orders Agent',
  description: 'Handles the order lifecycle',
  version: '1.2.0',
  skills: ['create_order'],
  categories: ['commerce'],
  inputSchema: {},
  outputSchema: {},
  invocation: {
    protocol: 'HTTP_ENDPOINT',
    target: 'https://api.example.com/agent',
    auth: { mode: 'NONE' },
    mode: 'sync',
  },
  origin: {
    sourceArn: 'arn:x',
    account: '111122223333',
    region: 'us-east-1',
    substrate: 'AGENTCORE',
    discoveredAt: '2026-06-28T00:00:00Z',
    ownership: 'external',
  },
  fieldConfidence: {},
};

describe('ImportAgentWizard — tags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders TagEditor in the review step and includes tags in import', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([candidate]);
    svc.describeAgentCandidate.mockResolvedValue(descriptor);
    svc.testImportedAgent.mockResolvedValue({ ok: true, latencyMs: 42 });
    svc.importAgent.mockResolvedValue({
      agent: { agentId: 'a1', name: 'Orders Agent', config: {}, state: 'inactive' },
      conflict: false,
    });

    render(<ImportAgentWizard onBack={jest.fn()} onComplete={jest.fn()} />);

    // Step 1: Source — select PASTE and enter a reference
    await user.click(screen.getByText('Paste a reference'));
    await user.type(screen.getByPlaceholderText(/arn:aws/), 'ref-orders-1');
    await user.click(screen.getByText('Next'));

    // Step 2: Candidates
    await waitFor(() => expect(screen.getByText('Orders Agent')).toBeInTheDocument());
    await user.click(screen.getByText('Orders Agent'));
    await user.click(screen.getByText('Next'));

    // Step 3: Review — TagEditor should be present
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());

    // Set the env tag value
    const envSelect = screen.getByTestId('tag-value-select-env');
    await user.selectOptions(envSelect, 'prod');

    await user.click(screen.getByText('Next'));

    // Step 4: Configure — set target and pass test
    await waitFor(() => expect(screen.getByLabelText('Invocation target')).toBeInTheDocument());
    await user.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('Connection verified')).toBeInTheDocument());
    await user.click(screen.getByText('Next'));

    // Step 5: Register
    await waitFor(() => expect(screen.getByText('Register agent')).toBeInTheDocument());
    await user.click(screen.getByText('Register agent'));

    await waitFor(() => expect(svc.importAgent).toHaveBeenCalledTimes(1));
    const callInput = svc.importAgent.mock.calls[0][0];
    expect(callInput.tags).toEqual({ env: 'prod' });
  });

  it('renders inline errors on tag policy violation during import', async () => {
    const user = userEvent.setup();
    svc.discoverAgents.mockResolvedValue([candidate]);
    svc.describeAgentCandidate.mockResolvedValue(descriptor);
    svc.testImportedAgent.mockResolvedValue({ ok: true, latencyMs: 10 });
    svc.importAgent.mockRejectedValue(
      new Error('tag_policy_violation: missing required keys: env'),
    );

    render(<ImportAgentWizard onBack={jest.fn()} onComplete={jest.fn()} />);

    // Navigate to step 5 quickly
    await user.click(screen.getByText('Paste a reference'));
    await user.type(screen.getByPlaceholderText(/arn:aws/), 'ref-orders-1');
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Orders Agent')).toBeInTheDocument());
    await user.click(screen.getByText('Orders Agent'));
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByTestId('tag-editor')).toBeInTheDocument());
    await user.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByLabelText('Invocation target')).toBeInTheDocument());
    await user.click(screen.getByText('Test connection'));
    await waitFor(() => expect(screen.getByText('Connection verified')).toBeInTheDocument());
    await user.click(screen.getByText('Next'));

    await waitFor(() => expect(screen.getByText('Register agent')).toBeInTheDocument());
    await user.click(screen.getByText('Register agent'));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Tags do not meet the organisation policy'),
    );
  });
});
