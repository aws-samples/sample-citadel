/**
 * AgentApps status filter tab tests
 * Tests: PUBLISHED tab is present and filters the app grid to only
 * PUBLISHED apps. Uses the real appFilters implementation (not mocked)
 * so filtering semantics are exercised end to end.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock UI components
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, className }: any) =>
    React.createElement('span', { className, 'data-testid': 'badge' }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...props }: any) =>
    React.createElement('button', { onClick, disabled, className, ...props }, children),
}));

jest.mock('@/components/ui/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/SearchInput', () => ({
  SearchInput: (props: any) => React.createElement('input', { ...props, 'data-testid': 'search' }),
}));

jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));

jest.mock('@/services/appApiService', () => ({
  appApiService: {
    listApps: jest.fn(),
  },
}));

// NOTE: '@/utils/appFilters' is deliberately NOT mocked here.

import { AgentApps } from '../AgentApps';
import { appApiService } from '../../services/appApiService';

const makeApp = (overrides: Record<string, any>) => ({
  appId: 'app-1',
  orgId: 'org-1',
  name: 'Test App',
  description: 'desc',
  status: 'DRAFT',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('AgentApps status filter tabs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a Published status tab alongside the existing tabs', async () => {
    (appApiService.listApps as jest.Mock).mockResolvedValue({ items: [] });

    render(React.createElement(AgentApps, { onNavigate: jest.fn() }));
    await waitFor(() => expect(appApiService.listApps).toHaveBeenCalled());

    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
  });

  it('clicking Published shows only PUBLISHED apps', async () => {
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [
        makeApp({ appId: 'app-d', name: 'Draft App', status: 'DRAFT' }),
        makeApp({ appId: 'app-p', name: 'Pub App', status: 'PUBLISHED' }),
        makeApp({ appId: 'app-a', name: 'Approved App', status: 'APPROVED' }),
      ],
    });

    render(React.createElement(AgentApps, { onNavigate: jest.fn() }));
    await waitFor(() => expect(screen.getByText('Pub App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Published'));

    await waitFor(() => {
      expect(screen.queryByText('Draft App')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Approved App')).not.toBeInTheDocument();
    expect(screen.getByText('Pub App')).toBeInTheDocument();
  });

  it('clicking All after Published restores the full list', async () => {
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [
        makeApp({ appId: 'app-d', name: 'Draft App', status: 'DRAFT' }),
        makeApp({ appId: 'app-p', name: 'Pub App', status: 'PUBLISHED' }),
      ],
    });

    render(React.createElement(AgentApps, { onNavigate: jest.fn() }));
    await waitFor(() => expect(screen.getByText('Pub App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Published'));
    await waitFor(() => expect(screen.queryByText('Draft App')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText('All'));
    await waitFor(() => expect(screen.getByText('Draft App')).toBeInTheDocument());
    expect(screen.getByText('Pub App')).toBeInTheDocument();
  });
});
