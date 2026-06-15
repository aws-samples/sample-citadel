/**
 * Integrations page — post-create callback URL UX and 3LO Connect redirect.
 *
 * - After createIntegration returns `agentCoreCallbackUrl`, the page surfaces a
 *   one-time dialog showing the URL with a "Copy to clipboard" button.
 * - On Connect for an AUTHORIZATION_CODE integration, the page performs a
 *   full-page redirect via `window.location.assign(authorizationUrl)`.
 * - On Connect for a CLIENT_CREDENTIALS integration (no authorizationUrl), the
 *   page falls back to the polling/Connecting state without redirecting.
 *
 * Heavy UI primitives are mocked so the test focuses on the controller logic
 * in `handleAddIntegration` and `handleConnect`.
 */

import React from 'react';
import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import '@testing-library/jest-dom';

// --------------------------- UI component mocks ---------------------------

jest.mock('@/components/ui/dialog', () => {
  const ReactLib = require('react');
  return {
    Dialog: ({ children, open }: any) =>
      open
        ? ReactLib.createElement('div', { role: 'dialog' }, children)
        : null,
    DialogContent: ({ children, ...rest }: any) =>
      ReactLib.createElement('div', { ...rest }, children),
    DialogHeader: ({ children }: any) =>
      ReactLib.createElement('div', null, children),
    DialogTitle: ({ children }: any) =>
      ReactLib.createElement('h2', null, children),
    DialogDescription: ({ children }: any) =>
      ReactLib.createElement('p', null, children),
    DialogFooter: ({ children }: any) =>
      ReactLib.createElement('div', null, children),
  };
});

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, type, ...rest }: any) =>
    React.createElement(
      'button',
      { onClick, disabled, type: type ?? 'button', ...rest },
      children,
    ),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...rest }: any) =>
    React.createElement('span', { ...rest }, children),
}));

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: any) =>
    React.createElement('div', null, children),
  TabsList: ({ children }: any) =>
    React.createElement('div', null, children),
  TabsTrigger: ({ children, value, ...rest }: any) =>
    React.createElement(
      'button',
      { 'data-tab-value': value, ...rest },
      children,
    ),
  TabsContent: ({ children, value }: any) =>
    React.createElement('div', { 'data-tab-content': value }, children),
}));

jest.mock('@/components/PageContainer', () => ({
  PageContainer: ({ children }: any) =>
    React.createElement('div', null, children),
}));

jest.mock('@/components/SearchInput', () => ({
  SearchInput: () => null,
}));

jest.mock('@/components/ConnectorTypeSelector', () => ({
  ConnectorTypeSelector: ({ onSelect }: any) =>
    React.createElement(
      'button',
      {
        'data-testid': 'pick-connector-mcp',
        onClick: () =>
          onSelect({
            id: 'MCP_SERVER',
            name: 'MCP Server',
            description: 'desc',
            icon: () => null,
            authMethod: 'CONFIGURABLE',
            provider: 'External',
            category: 'integration-platform',
            isPopular: false,
          }),
      },
      'Pick MCP_SERVER',
    ),
}));

// Replace DynamicConnectorForm with a stub button that triggers onSubmit
// with a pre-baked OAuth2 MCP_SERVER form payload.
jest.mock('@/components/DynamicConnectorForm', () => ({
  DynamicConnectorForm: ({ onSubmit }: any) =>
    React.createElement(
      'button',
      {
        'data-testid': 'submit-form',
        onClick: () =>
          onSubmit({
            name: 'My MCP',
            credentials: {
              authMethod: 'OAUTH2',
              clientId: 'cid',
              clientSecret: 'cs',
              grantType: 'AUTHORIZATION_CODE',
              tokenUrl: 'https://idp.example.com/token',
              authorizationUrl: 'https://idp.example.com/authorize',
              scopes: ['read', 'write'],
              clientAuthenticationMethod: 'CLIENT_SECRET_BASIC',
            },
            config: { serverUrl: 'https://mcp.example.com' },
          }),
      },
      'Submit',
    ),
}));

jest.mock('@/components/IntegrationCard', () => ({
  IntegrationCard: ({ integration, onConnect }: any) =>
    React.createElement(
      'div',
      { 'data-testid': `integration-card-${integration.integrationId ?? integration.id}` },
      React.createElement(
        'span',
        null,
        `${integration.name} [${integration.backendStatus ?? integration.status}]`,
      ),
      React.createElement(
        'button',
        {
          'data-testid': `connect-${integration.integrationId ?? integration.id}`,
          onClick: () => onConnect?.(integration),
        },
        'Connect',
      ),
    ),
}));

// Backend integration service mock
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

// Navigation helper mock — drives the 3LO redirect assertion. The page funnels
// `window.location.assign` through this module so tests can spy on it cleanly.
jest.mock('@/utils/navigation', () => ({
  navigateExternal: jest.fn(),
}));

import { integrationServiceBackend } from '@/services/integrationServiceBackend';
import { navigateExternal } from '@/utils/navigation';
import { Integrations } from '../Integrations';

const svc = integrationServiceBackend as unknown as {
  [K in keyof typeof integrationServiceBackend]: jest.Mock;
};
const navigateExternalMock = navigateExternal as unknown as jest.Mock;

// Helper used by Connect tests: exercise the 3LO mock and snapshot/restore
// the navigateExternal jest mock state across runs.

describe('Integrations page — Connect 3LO redirect behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('AUTHORIZATION_CODE integration: navigateExternal called with authorizationUrl', async () => {
    svc.listIntegrations.mockResolvedValue([
      {
        integrationId: 'int-auth-code',
        name: 'My Auth Code MCP',
        integrationType: 'MCP_SERVER',
        orgId: 'default',
        status: 'TESTED',
        config: '{}',
        createdAt: 't',
        updatedAt: 't',
      },
    ]);
    svc.connectIntegration.mockResolvedValueOnce({
      integrationId: 'int-auth-code',
      status: 'CREATED',
      updatedAt: 't',
      authorizationUrl:
        'https://idp.example.com/authorize?client_id=cid&redirect_uri=...&state=abc',
      targetStatus: 'CREATE_PENDING_AUTH',
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });

    const connectBtn = await screen.findByTestId('connect-int-auth-code');
    await act(async () => {
      fireEvent.click(connectBtn);
    });

    await waitFor(() => {
      expect(svc.connectIntegration).toHaveBeenCalledWith('int-auth-code');
    });
    await waitFor(() => {
      expect(navigateExternalMock).toHaveBeenCalledWith(
        'https://idp.example.com/authorize?client_id=cid&redirect_uri=...&state=abc',
      );
    });
  });

  it('CLIENT_CREDENTIALS integration: no redirect; state moves to Connecting', async () => {
    svc.listIntegrations.mockResolvedValue([
      {
        integrationId: 'int-cc',
        name: 'My CC MCP',
        integrationType: 'MCP_SERVER',
        orgId: 'default',
        status: 'TESTED',
        config: '{}',
        createdAt: 't',
        updatedAt: 't',
      },
    ]);
    svc.connectIntegration.mockResolvedValueOnce({
      integrationId: 'int-cc',
      status: 'CONNECTING',
      updatedAt: 't',
      // No authorizationUrl
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });

    const connectBtn = await screen.findByTestId('connect-int-cc');
    await act(async () => {
      fireEvent.click(connectBtn);
    });

    await waitFor(() => {
      expect(svc.connectIntegration).toHaveBeenCalledWith('int-cc');
    });
    // No external redirect was triggered.
    expect(navigateExternalMock).not.toHaveBeenCalled();
    // "Connecting..." surface message is shown.
    expect(screen.getByText(/Connecting\.\.\./i)).toBeInTheDocument();
  });
});

describe('Integrations page — post-create AgentCore callback URL UX', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    svc.listIntegrations.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it('renders agentCoreCallbackUrl with a Copy to clipboard button after createIntegration', async () => {
    svc.createIntegration.mockResolvedValueOnce({
      integrationId: 'int-1',
      name: 'My MCP',
      integrationType: 'MCP_SERVER',
      orgId: 'default',
      status: 'CREATED',
      config: '{}',
      createdAt: 't',
      updatedAt: 't',
      agentCoreCallbackUrl:
        'https://agentcore.example.com/oauth2/callback?providerArn=arn:aws:agentcore:cred-1',
      credentialProviderArn: 'arn:aws:agentcore:cred-1',
      targetStatus: 'CREATED',
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });
    // initial loadIntegrations
    await waitFor(() => expect(svc.listIntegrations).toHaveBeenCalled());

    // Open Add dialog
    fireEvent.click(screen.getByRole('button', { name: /Add Connectors/i }));
    // Pick MCP_SERVER connector via the mocked selector
    fireEvent.click(screen.getByTestId('pick-connector-mcp'));
    // Submit the form via the mocked form button
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });

    await waitFor(() => {
      expect(svc.createIntegration).toHaveBeenCalledTimes(1);
    });

    // The post-create callback URL dialog appears with the URL and copy button.
    const callbackDialog = await screen.findByTestId('callback-url-dialog');
    expect(callbackDialog).toBeInTheDocument();
    expect(screen.getByTestId('callback-url-value')).toHaveTextContent(
      'https://agentcore.example.com/oauth2/callback?providerArn=arn:aws:agentcore:cred-1',
    );
    expect(screen.getByTestId('copy-callback-url')).toBeInTheDocument();
    expect(screen.getByTestId('continue-callback-url')).toBeInTheDocument();
  });

  it('does not show callback dialog when agentCoreCallbackUrl is absent', async () => {
    svc.createIntegration.mockResolvedValueOnce({
      integrationId: 'int-2',
      name: 'My MCP',
      integrationType: 'MCP_SERVER',
      orgId: 'default',
      status: 'CREATED',
      config: '{}',
      createdAt: 't',
      updatedAt: 't',
      // No agentCoreCallbackUrl (e.g., API_KEY MCP_SERVER)
    });

    await act(async () => {
      render(React.createElement(Integrations));
    });
    await waitFor(() => expect(svc.listIntegrations).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Add Connectors/i }));
    fireEvent.click(screen.getByTestId('pick-connector-mcp'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });

    await waitFor(() => expect(svc.createIntegration).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('callback-url-dialog')).not.toBeInTheDocument();
  });
});
