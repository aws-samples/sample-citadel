import React from 'react';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    currentUser: { role: 'admin' },
    selectedOrganization: 'org-1',
  }),
}));

jest.mock('@/services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn(),
    updateAgentConfig: jest.fn(),
  },
}));

jest.mock('@/hooks/useFabricatorQueue', () => ({
  useFabricatorQueue: () => ({
    queueItems: [],
    reload: jest.fn(),
    addPendingItem: jest.fn(),
  }),
}));

jest.mock('@/components/TaskRunner', () => ({
  TaskRunner: () => React.createElement('div', { 'data-testid': 'task-runner' }),
}));

import { AgentCatalog } from '../AgentCatalog';
import { agentConfigService } from '../../services/agentConfigService';

describe('AgentCatalog — regression: renders then vanishes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('survives multiple state updates after agents load (search, filter, search again)', async () => {
    (agentConfigService.listAgentConfigs as jest.Mock).mockResolvedValue([
      {
        agentId: 'agent-1',
        state: 'active',
        categories: ['analytics', 'built-in', 'worker'],
        config: { name: 'Test Agent', description: 'desc', version: 'v1.0.0' },
      },
      {
        agentId: 'agent-2',
        state: 'inactive',
        categories: ['nlp'],
        config: { name: 'NLP Agent', description: 'desc2', version: 'v0.1.0' },
      },
    ]);
    const { container } = render(<AgentCatalog />);
    await waitFor(() =>
      expect(agentConfigService.listAgentConfigs).toHaveBeenCalled(),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(container.textContent).toContain('Test Agent');

    // Type in search box
    const searchInput = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    fireEvent.change(searchInput, { target: { value: 'NLP' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('NLP Agent');

    // Clear search
    fireEvent.change(searchInput, { target: { value: '' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('Test Agent');
    expect(container.textContent).toContain('NLP Agent');

    // Click Analytics category
    const analyticsBtn = screen.queryByRole('button', { name: /Analytics/i });
    if (analyticsBtn) {
      fireEvent.click(analyticsBtn);
      await new Promise((r) => setTimeout(r, 50));
    }

    // Page should still be rendered and not crashed
    expect(container.textContent).toContain('AI Agents');
  });
});
