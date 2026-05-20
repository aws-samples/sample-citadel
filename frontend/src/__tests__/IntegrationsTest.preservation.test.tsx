/**
 * Preservation Property Tests - IntegrationsTest Page
 *
 * Property 2: Preservation - Integration Actions and UI Behavior Unchanged
 *
 * These tests capture the CURRENT (baseline) behavior of action handlers,
 * dialog interactions, error handling, and status mapping on the UNFIXED code.
 * They MUST PASS on unfixed code and continue to pass after the fix is applied,
 * ensuring no regressions in non-buggy code paths.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */

import React from 'react';
import * as fc from 'fast-check';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { Integration as BackendIntegration } from '@/services/integrationServiceBackend';

// ---- Mock the backend service ----
const mockListIntegrations = jest.fn<Promise<BackendIntegration[]>, any[]>();
const mockCreateIntegration = jest.fn();
const mockUpdateIntegration = jest.fn();
const mockConnectIntegration = jest.fn();
const mockDisconnectIntegration = jest.fn();
const mockDeleteIntegration = jest.fn();
const mockTestIntegration = jest.fn();

jest.mock('@/services/integrationServiceBackend', () => ({
  integrationServiceBackend: {
    listIntegrations: (...args: any[]) => mockListIntegrations(...args),
    createIntegration: (...args: any[]) => mockCreateIntegration(...args),
    updateIntegration: (...args: any[]) => mockUpdateIntegration(...args),
    connectIntegration: (...args: any[]) => mockConnectIntegration(...args),
    disconnectIntegration: (...args: any[]) => mockDisconnectIntegration(...args),
    deleteIntegration: (...args: any[]) => mockDeleteIntegration(...args),
    testIntegration: (...args: any[]) => mockTestIntegration(...args),
  },
}));

// ---- Mock UI component dependencies ----
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: any) => React.createElement('div', null, children),
  DialogDescription: ({ children }: any) => React.createElement('div', null, children),
  DialogHeader: ({ children }: any) => React.createElement('div', null, children),
  DialogTitle: ({ children }: any) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: any) => React.createElement('span', null, children),
}));

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }: any) =>
    React.createElement('div', { 'data-testid': 'tabs', 'data-value': value }, children),
  TabsContent: ({ children, value }: any) =>
    React.createElement('div', { 'data-testid': `tab-${value}` }, children),
  TabsList: ({ children }: any) => React.createElement('div', null, children),
  TabsTrigger: ({ children, value }: any) =>
    React.createElement('button', { 'data-testid': `trigger-${value}` }, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) =>
    React.createElement('button', { onClick, ...props }, children),
}));

// Track action handler calls from IntegrationCard
let capturedCardProps: Record<string, any>[] = [];

jest.mock('@/components/IntegrationCard', () => ({
  IntegrationCard: (props: any) => {
    capturedCardProps.push(props);
    return React.createElement('div', {
      'data-testid': 'integration-card',
      'data-name': props.integration.name,
      'data-integration-id': props.integration.integrationId || '',
      'data-status': props.integration.status,
    },
      // Expose action buttons for testing
      React.createElement('button', {
        'data-testid': `test-btn-${props.integration.integrationId || props.integration.id}`,
        onClick: () => props.onTest(props.integration),
      }, 'Test'),
      React.createElement('button', {
        'data-testid': `connect-btn-${props.integration.integrationId || props.integration.id}`,
        onClick: () => props.onConnect(props.integration),
      }, 'Connect'),
      React.createElement('button', {
        'data-testid': `disconnect-btn-${props.integration.integrationId || props.integration.id}`,
        onClick: () => props.onDisconnect(props.integration),
      }, 'Disconnect'),
      React.createElement('button', {
        'data-testid': `delete-btn-${props.integration.integrationId || props.integration.id}`,
        onClick: () => props.onDelete(props.integration),
      }, 'Delete'),
    );
  },
}));

let capturedConnectorSelectorProps: any = null;

jest.mock('@/components/ConnectorTypeSelector', () => ({
  ConnectorTypeSelector: (props: any) => {
    capturedConnectorSelectorProps = props;
    return React.createElement('div', { 'data-testid': 'connector-type-selector' }, 'ConnectorTypeSelector');
  },
}));

jest.mock('@/components/DynamicConnectorForm', () => ({
  DynamicConnectorForm: (props: any) => {
    return React.createElement('div', { 'data-testid': 'dynamic-connector-form' },
      React.createElement('button', {
        'data-testid': 'submit-form',
        onClick: () => props.onSubmit({
          name: 'Test Integration',
          config: { baseUrl: 'https://test.example.com' },
          credentials: { apiToken: 'test-token' },
        }),
      }, 'Submit'),
    );
  },
}));

// ---- Import the component AFTER all mocks are set up ----
import Integrations from '@/pages/Integrations';

// ---- Helper: create a backend integration object ----
function makeBackendIntegration(
  overrides: Partial<BackendIntegration> & { integrationType: string },
): BackendIntegration {
  const id = overrides.integrationId ?? `int-${overrides.integrationType.toLowerCase()}-001`;
  return {
    integrationId: id,
    name: overrides.name ?? `${overrides.integrationType} Integration`,
    integrationType: overrides.integrationType,
    orgId: overrides.orgId ?? 'default',
    status: overrides.status ?? 'CONNECTED',
    config: overrides.config ?? '{}',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    errorMessage: overrides.errorMessage,
  };
}

describe('Property 2: Preservation – Integration Actions and UI Behavior Unchanged', () => {
  beforeEach(() => {
    capturedCardProps = [];
    capturedConnectorSelectorProps = null;
    jest.clearAllMocks();
    // Default: return a Confluence integration so the page has something to render
    mockListIntegrations.mockResolvedValue([
      makeBackendIntegration({
        integrationType: 'CONFLUENCE',
        name: 'Confluence',
        integrationId: 'int-confluence-001',
        status: 'CONNECTED',
      }),
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // 3.1: Empty state message when backend returns zero connected integrations
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirement 3.1
   *
   * When the backend returns zero connected integrations, the graph view
   * should display "No integrations connected yet".
   */
  it('shows empty state message when no integrations are connected', async () => {
    mockListIntegrations.mockResolvedValue([]);

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.getByText('No integrations connected yet')).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 3.2: "Add Connectors" button opens connector type selector dialog
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirement 3.2
   *
   * Clicking "Add Connectors" should open the ConnectorTypeSelector dialog.
   */
  it('clicking "Add Connectors" opens the ConnectorTypeSelector dialog', async () => {
    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(mockListIntegrations).toHaveBeenCalled();
    });

    // The ConnectorTypeSelector should NOT be visible initially
    expect(screen.queryByTestId('connector-type-selector')).toBeNull();

    // Click "Add Connectors" button
    const addButton = screen.getByText('Add Connectors');
    fireEvent.click(addButton);

    // The dialog with ConnectorTypeSelector should now be visible
    await waitFor(() => {
      expect(screen.getByTestId('connector-type-selector')).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 3.3: Action handlers call correct backend methods
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirement 3.3
   *
   * handleTest calls integrationServiceBackend.testIntegration(integrationId)
   * and refreshes the list on success.
   */
  it('handleTest calls testIntegration and refreshes list on success', async () => {
    mockTestIntegration.mockResolvedValue({ success: true, message: 'OK' });

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    // Find the test button for the Confluence integration
    const testBtn = screen.getByTestId('test-btn-int-confluence-001');
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(mockTestIntegration).toHaveBeenCalledWith('int-confluence-001');
    });

    // After success, loadIntegrations should be called again (initial + refresh)
    await waitFor(() => {
      expect(mockListIntegrations.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  /**
   * Validates: Requirement 3.3
   *
   * handleConnect calls integrationServiceBackend.connectIntegration(integrationId)
   * and polls for status.
   */
  it('handleConnect calls connectIntegration and polls for status', async () => {
    mockConnectIntegration.mockResolvedValue({
      integrationId: 'int-confluence-001',
      status: 'CONNECTING',
      updatedAt: new Date().toISOString(),
    });

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    const connectBtn = screen.getByTestId('connect-btn-int-confluence-001');
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(mockConnectIntegration).toHaveBeenCalledWith('int-confluence-001');
    });
  });

  /**
   * Validates: Requirement 3.3
   *
   * handleDisconnect calls integrationServiceBackend.disconnectIntegration(integrationId)
   * and refreshes the list.
   */
  it('handleDisconnect calls disconnectIntegration and refreshes list', async () => {
    mockDisconnectIntegration.mockResolvedValue({
      integrationId: 'int-confluence-001',
      status: 'DISCONNECTED',
      updatedAt: new Date().toISOString(),
    });

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    const disconnectBtn = screen.getByTestId('disconnect-btn-int-confluence-001');
    fireEvent.click(disconnectBtn);

    await waitFor(() => {
      expect(mockDisconnectIntegration).toHaveBeenCalledWith('int-confluence-001');
    });

    // After success, loadIntegrations should be called again
    await waitFor(() => {
      expect(mockListIntegrations.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  /**
   * Validates: Requirement 3.3
   *
   * handleDelete calls integrationServiceBackend.deleteIntegration(integrationId)
   * and refreshes the list.
   */
  it('handleDelete calls deleteIntegration and refreshes list', async () => {
    mockDeleteIntegration.mockResolvedValue({ success: true, message: 'Deleted' });
    // Mock window.confirm to return true
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    const deleteBtn = screen.getByTestId('delete-btn-int-confluence-001');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(mockDeleteIntegration).toHaveBeenCalledWith('int-confluence-001');
    });

    // After success, loadIntegrations should be called again
    await waitFor(() => {
      expect(mockListIntegrations.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    confirmSpy.mockRestore();
  });

  /**
   * Validates: Requirement 3.3
   *
   * handleAddIntegration calls integrationServiceBackend.createIntegration(input)
   * with the correct connector type.
   */
  it('handleAddIntegration calls createIntegration with correct connector type', async () => {
    mockCreateIntegration.mockResolvedValue({
      integrationId: 'int-new-001',
      name: 'Test Integration',
      integrationType: 'CONFLUENCE',
      orgId: 'default',
      status: 'CREATED',
      config: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(mockListIntegrations).toHaveBeenCalled();
    });

    // Open the Add Connectors dialog
    const addButton = screen.getByText('Add Connectors');
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(screen.getByTestId('connector-type-selector')).toBeTruthy();
    });

    // Simulate selecting a connector type via the captured props
    const confluenceConnectorType = {
      id: 'CONFLUENCE',
      name: 'Confluence',
      description: 'Atlassian Confluence',
      icon: () => React.createElement('span', null, 'icon'),
      authMethod: 'API_KEY',
      provider: 'Atlassian',
      category: 'productivity',
    };

    // Call the onSelect callback to simulate selecting a connector type
    capturedConnectorSelectorProps.onSelect(confluenceConnectorType);

    // Now the DynamicConnectorForm should appear
    await waitFor(() => {
      expect(screen.getByTestId('dynamic-connector-form')).toBeTruthy();
    });

    // Submit the form
    const submitBtn = screen.getByTestId('submit-form');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateIntegration).toHaveBeenCalledWith(
        expect.objectContaining({
          integrationType: 'CONFLUENCE',
          orgId: 'default',
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3.4: Backend API failure handled gracefully (no crash)
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirement 3.4
   *
   * When the backend API call fails, the page should handle the error
   * gracefully and not crash.
   */
  it('handles backend API failure gracefully without crashing', async () => {
    mockListIntegrations.mockRejectedValue(new Error('Network error'));

    // Should not throw
    render(React.createElement(Integrations));

    // Wait for loading to finish — page should still render
    await waitFor(() => {
      // The page should render without crashing; it falls back to showing
      // integrations (mocks in unfixed code, empty in fixed code)
      const heading = screen.getByText('Integrations Test');
      expect(heading).toBeTruthy();
    });
  });

  /**
   * Validates: Requirement 3.4
   *
   * When testIntegration fails, the error is handled gracefully.
   */
  it('handles testIntegration failure gracefully', async () => {
    mockTestIntegration.mockRejectedValue(new Error('Test connection failed'));

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    const testBtn = screen.getByTestId('test-btn-int-confluence-001');
    fireEvent.click(testBtn);

    // Should not crash — error message should appear
    await waitFor(() => {
      expect(screen.getByText('Test connection failed')).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 3.5: mapBackendStatus() normalizes backend status strings correctly
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirement 3.5
   *
   * Property-based test: mapBackendStatus continues to normalize backend
   * status strings correctly. We verify this indirectly by rendering
   * integrations with various backend statuses and checking the normalized
   * status passed to IntegrationCard.
   */
  it('mapBackendStatus normalizes backend status strings correctly', async () => {
    const statusMappings: Array<{ backend: string; expectedUI: string }> = [
      { backend: 'CONNECTED', expectedUI: 'connected' },
      { backend: 'DISCONNECTED', expectedUI: 'disconnected' },
      { backend: 'CREATED', expectedUI: 'configuring' },
      { backend: 'TESTED', expectedUI: 'configuring' },
      { backend: 'CONNECTING', expectedUI: 'configuring' },
      { backend: 'CONNECTION_FAILED', expectedUI: 'error' },
    ];

    for (const { backend, expectedUI } of statusMappings) {
      cleanup();
      jest.clearAllMocks();
      capturedCardProps = [];

      mockListIntegrations.mockResolvedValue([
        makeBackendIntegration({
          integrationType: 'CONFLUENCE',
          name: 'Confluence',
          integrationId: 'int-confluence-001',
          status: backend,
        }),
      ]);

      render(React.createElement(Integrations));

      await waitFor(() => {
        expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
      });

      // Find the Confluence card and check its status
      // The card with data-name="Confluence" should have the mapped status
      // In the unfixed code, Confluence is always the first card (id="1")
      const confluenceCards = capturedCardProps.filter(
        (p) => p.integration.name === 'Confluence',
      );
      expect(confluenceCards.length).toBeGreaterThanOrEqual(1);

      const confluenceCard = confluenceCards[0];
      expect(confluenceCard.integration.status).toBe(expectedUI);
    }
  });

  // -----------------------------------------------------------------------
  // PBT: Action handlers call correct backend methods for arbitrary IDs
  // -----------------------------------------------------------------------

  /**
   * Validates: Requirements 3.3, 3.5
   *
   * Property-based test: For any valid integration ID, the action handlers
   * call the correct backend service methods with that ID.
   */
  it('action handlers call correct backend methods for arbitrary integration IDs', async () => {
    const integrationIdArb = fc.stringMatching(/^int-[a-z]+-[0-9]{3}$/);

    await fc.assert(
      fc.asyncProperty(integrationIdArb, async (integrationId) => {
        cleanup();
        jest.clearAllMocks();
        capturedCardProps = [];

        mockListIntegrations.mockResolvedValue([
          makeBackendIntegration({
            integrationType: 'CONFLUENCE',
            name: 'Confluence',
            integrationId,
            status: 'CONNECTED',
          }),
        ]);
        mockTestIntegration.mockResolvedValue({ success: true, message: 'OK' });
        mockDisconnectIntegration.mockResolvedValue({
          integrationId,
          status: 'DISCONNECTED',
          updatedAt: new Date().toISOString(),
        });

        render(React.createElement(Integrations));

        await waitFor(() => {
          expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
        });

        // Test: handleTest calls testIntegration with the correct ID
        const testBtn = screen.getByTestId(`test-btn-${integrationId}`);
        fireEvent.click(testBtn);

        await waitFor(() => {
          expect(mockTestIntegration).toHaveBeenCalledWith(integrationId);
        });

        // Reset for next action
        jest.clearAllMocks();
        mockListIntegrations.mockResolvedValue([
          makeBackendIntegration({
            integrationType: 'CONFLUENCE',
            name: 'Confluence',
            integrationId,
            status: 'CONNECTED',
          }),
        ]);

        // Test: handleDisconnect calls disconnectIntegration with the correct ID
        const disconnectBtn = screen.getByTestId(`disconnect-btn-${integrationId}`);
        fireEvent.click(disconnectBtn);

        await waitFor(() => {
          expect(mockDisconnectIntegration).toHaveBeenCalledWith(integrationId);
        });

        cleanup();
      }),
      { numRuns: 3 }, // Keep low since each run renders a React component
    );
  });
});
