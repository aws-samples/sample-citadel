/**
 * Integrations page — caller-organization sourcing (finding 5b8638f8).
 *
 * createIntegration/listIntegrations must source orgId from
 * currentUser.organization (same pattern as finding d8fb2286 / PR #188's
 * AgentBlueprints fix), never the 'default' placeholder. When the caller
 * has no organization, the page must block server calls and disable the
 * "Add Connectors" action with an explanatory message rather than send a
 * placeholder org that the server would reject.
 */
import React from 'react';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/dialog', () => {
  const ReactLib = require('react');
  return {
    Dialog: ({ children, open }: any) =>
      open ? ReactLib.createElement('div', { role: 'dialog' }, children) : null,
    DialogContent: ({ children, ...rest }: any) => ReactLib.createElement('div', { ...rest }, children),
    DialogHeader: ({ children }: any) => ReactLib.createElement('div', null, children),
    DialogTitle: ({ children }: any) => ReactLib.createElement('h2', null, children),
    DialogDescription: ({ children }: any) => ReactLib.createElement('p', null, children),
    DialogFooter: ({ children }: any) => ReactLib.createElement('div', null, children),
  };
});

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, type, ...rest }: any) =>
    React.createElement('button', { onClick, disabled, type: type ?? 'button', ...rest }, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...rest }: any) => React.createElement('span', { ...rest }, children),
}));

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: any) => React.createElement('div', null, children),
  TabsList: ({ children }: any) => React.createElement('div', null, children),
  TabsTrigger: ({ children, value, ...rest }: any) =>
    React.createElement('button', { 'data-tab-value': value, ...rest }, children),
  TabsContent: ({ children, value }: any) => React.createElement('div', { 'data-tab-content': value }, children),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/SearchInput', () => ({
  SearchInput: () => null,
}));

jest.mock('@/components/ConnectorTypeSelector', () => ({
  ConnectorTypeSelector: () => null,
}));

jest.mock('@/components/DynamicConnectorForm', () => ({
  DynamicConnectorForm: () => null,
}));

jest.mock('@/components/IntegrationCard', () => ({
  IntegrationCard: () => null,
}));

jest.mock('@/services/integrationServiceBackend', () => ({
  integrationServiceBackend: {
    listIntegrations: jest.fn(),
    createIntegration: jest.fn(),
    connectIntegration: jest.fn(),
    disconnectIntegration: jest.fn(),
    deleteIntegration: jest.fn(),
    testIntegration: jest.fn(),
    updateIntegration: jest.fn(),
  },
}));

jest.mock('@/utils/navigation', () => ({
  navigateExternal: jest.fn(),
}));

const mockUseOrganization = jest.fn();
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => mockUseOrganization(),
}));

import { integrationServiceBackend } from '@/services/integrationServiceBackend';
import { Integrations } from '../Integrations';

const svc = integrationServiceBackend as unknown as {
  [K in keyof typeof integrationServiceBackend]: jest.Mock;
};

describe('Integrations page — caller-organization sourcing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('sources listIntegrations from currentUser.organization, not selectedOrganization or "default"', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: 'All Organizations',
      currentUser: { organization: 'caller-org' },
    });
    svc.listIntegrations.mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(Integrations));
    });

    await waitFor(() => {
      expect(svc.listIntegrations).toHaveBeenCalledWith('caller-org');
    });
  });

  it('blocks loading and shows a message when the caller has no organization', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: null,
      currentUser: { organization: null },
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });

    expect(svc.listIntegrations).not.toHaveBeenCalled();
    expect(
      screen.getByText('Your account has no organisation; ask an admin to assign one'),
    ).toBeInTheDocument();
  });

  it('disables the "Add Connectors" button when the caller has no organization', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: null,
      currentUser: { organization: null },
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });

    const addButton = screen.getByRole('button', { name: /Add Connectors/i });
    expect(addButton).toBeDisabled();
  });

  it('never sends the "default" placeholder as orgId to createIntegration or listIntegrations', async () => {
    mockUseOrganization.mockReturnValue({
      selectedOrganization: 'All Organizations',
      currentUser: { organization: 'caller-org' },
    });
    svc.listIntegrations.mockResolvedValue([]);

    await act(async () => {
      render(React.createElement(Integrations));
    });

    await waitFor(() => expect(svc.listIntegrations).toHaveBeenCalled());

    for (const call of svc.listIntegrations.mock.calls) {
      expect(call[0]).not.toBe('default');
    }
    expect(svc.createIntegration).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'default' }),
    );
  });
});
