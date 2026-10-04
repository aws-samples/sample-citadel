/**
 * AgentDetails — tag capture + policy violation tests.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../AgentConfig', () => ({
  AgentConfigTab: ({ onSave, tags, tagPolicy, tagErrors, onTagsChange }: any) =>
    React.createElement('div', null,
      React.createElement('button', { onClick: onSave }, 'Save Details'),
      tags && React.createElement('span', { 'data-testid': 'tags-json' }, JSON.stringify(tags)),
      tagPolicy && React.createElement('span', { 'data-testid': 'policy-loaded' }, 'policy'),
      tagErrors?.length > 0 && React.createElement('span', { 'data-testid': 'tag-errors' }, tagErrors[0].key),
      onTagsChange && React.createElement('button', {
        'data-testid': 'set-tags',
        onClick: () => onTagsChange({ env: 'prod' }),
      }, 'Set Tags'),
    ),
}));
jest.mock('../AgentCode', () => ({
  AgentCodeTab: () => React.createElement('div'),
}));
jest.mock('../ApprovalHistory', () => ({
  ApprovalHistory: () => null,
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), info: jest.fn(), success: jest.fn() },
}));

jest.mock('../../services/agentConfigService', () => ({
  agentConfigService: {
    getAgentConfig: jest.fn(),
    createAgentConfig: jest.fn(),
    updateAgentConfig: jest.fn(),
    deleteAgentConfig: jest.fn(),
    getAgentCode: jest.fn(),
    updateAgentCode: jest.fn(),
  },
}));

jest.mock('../../services/tagPolicyService', () => ({
  tagPolicyService: {
    getTagPolicy: jest.fn(),
  },
}));

jest.mock('../../contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    currentUser: { organization: 'acme-org', role: 'admin' },
  }),
}));

import { AgentDetails } from '../AgentDetails';
import { agentConfigService } from '../../services/agentConfigService';
import { tagPolicyService } from '../../services/tagPolicyService';
import { toast } from 'sonner';

const policyMock = tagPolicyService as unknown as { getTagPolicy: jest.Mock };
const svc = agentConfigService as unknown as {
  getAgentConfig: jest.Mock;
  createAgentConfig: jest.Mock;
  updateAgentConfig: jest.Mock;
  getAgentCode: jest.Mock;
};

describe('AgentDetails — tag policy integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    svc.getAgentCode.mockRejectedValue(new Error('no code'));
    policyMock.getTagPolicy.mockResolvedValue({
      requiredKeys: [{ key: 'env', allowedValues: ['prod', 'staging'] }],
      version: 1,
      updatedBy: 'admin',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('loads the tag policy for the caller org on mount', async () => {
    svc.getAgentConfig.mockResolvedValue({
      agentId: 'a1', config: {}, state: 'active', categories: [],
    });

    render(<AgentDetails agentId="a1" onBack={jest.fn()} />);
    await waitFor(() => expect(policyMock.getTagPolicy).toHaveBeenCalledWith('acme-org'));
    await waitFor(() => expect(screen.getByTestId('policy-loaded')).toBeInTheDocument());
  });

  it('sends tags in createAgentConfig on create', async () => {
    svc.createAgentConfig.mockResolvedValue({});

    render(<AgentDetails isCreating onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('set-tags')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('set-tags'));
    fireEvent.click(screen.getByText('Save Details'));

    await waitFor(() =>
      expect(svc.createAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({ tags: { env: 'prod' } }),
      ),
    );
  });

  it('renders inline tag errors on tag policy violation', async () => {
    svc.createAgentConfig.mockRejectedValue(
      new Error('tag_policy_violation: missing required keys: env'),
    );

    render(<AgentDetails isCreating onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('set-tags')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('set-tags'));
    fireEvent.click(screen.getByText('Save Details'));

    await waitFor(() => expect(screen.getByTestId('tag-errors')).toHaveTextContent('env'));
    expect(toast.error).toHaveBeenCalledWith('Tags do not meet the organisation policy');
  });

  it('sends tags on update only when changed', async () => {
    svc.getAgentConfig.mockResolvedValue({
      agentId: 'a1', config: { version: '1' }, state: 'active', categories: [],
      tags: { team: 'alpha' },
    });
    svc.updateAgentConfig.mockResolvedValue({});

    render(<AgentDetails agentId="a1" onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('tags-json')).toBeInTheDocument());

    // Save without changing tags — tags should NOT be in the call.
    fireEvent.click(screen.getByText('Save Details'));
    await waitFor(() => expect(svc.updateAgentConfig).toHaveBeenCalledTimes(1));
    const call = svc.updateAgentConfig.mock.calls[0][0];
    expect(call).not.toHaveProperty('tags');
  });
});
