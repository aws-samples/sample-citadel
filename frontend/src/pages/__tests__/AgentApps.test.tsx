/**
 * AgentApps unit tests
 * Tests: row click navigation, API Dashboard quick-action (PUBLISHED only),
 * quick action absent on DRAFT/ACTIVE/ARCHIVED
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

jest.mock('@/utils/appFilters', () => ({
  filterAppsBySearch: (apps: any[]) => apps,
  filterAppsByStatus: (apps: any[]) => apps,
}));

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

describe('AgentApps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('row click dispatches app-detail:{appId}', async () => {
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [makeApp({ appId: 'app-42', name: 'My App' })],
    });
    const onNavigate = jest.fn();

    render(React.createElement(AgentApps, { onNavigate }));
    await waitFor(() => expect(screen.getByText('My App')).toBeInTheDocument());

    fireEvent.click(screen.getByText('My App'));
    expect(onNavigate).toHaveBeenCalledWith('app-detail:app-42');
  });

  it('API Dashboard quick-action on PUBLISHED stops propagation and dispatches app-api-dashboard:{appId}', async () => {
    (appApiService.listApps as jest.Mock).mockResolvedValue({
      items: [makeApp({ appId: 'app-pub', name: 'Pub App', status: 'PUBLISHED' })],
    });
    const onNavigate = jest.fn();

    render(React.createElement(AgentApps, { onNavigate }));
    await waitFor(() => expect(screen.getByText('Pub App')).toBeInTheDocument());

    const dashBtn = screen.getByLabelText('Open API Dashboard');
    fireEvent.click(dashBtn);

    // Should dispatch dashboard navigation, NOT app-detail
    expect(onNavigate).toHaveBeenCalledWith('app-api-dashboard:app-pub');
    expect(onNavigate).not.toHaveBeenCalledWith('app-detail:app-pub');
  });

  it.each(['DRAFT', 'ACTIVE', 'ARCHIVED'] as const)(
    'quick action absent on %s status',
    async (status) => {
      (appApiService.listApps as jest.Mock).mockResolvedValue({
        items: [makeApp({ status, name: `${status} App` })],
      });

      render(React.createElement(AgentApps, { onNavigate: jest.fn() }));
      await waitFor(() => expect(screen.getByText(`${status} App`)).toBeInTheDocument());

      expect(screen.queryByLabelText('Open API Dashboard')).not.toBeInTheDocument();
    },
  );
});
