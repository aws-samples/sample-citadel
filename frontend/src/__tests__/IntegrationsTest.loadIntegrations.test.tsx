/**
 * Bug Condition Exploration Test - IntegrationsTest Page
 *
 * Property 1: Fault Condition - Hardcoded Mocks Displayed Instead of Backend Integrations
 *
 * This test encodes the EXPECTED (correct) behavior. On UNFIXED code it MUST FAIL,
 * confirming the bug exists. After the fix is applied, it should PASS.
 *
 * Bug condition (isBugCondition):
 *   page == "IntegrationsTest" AND (
 *     backendStatusFilterNotApplied
 *     OR onlyConfluenceMappedFromBackend
 *     OR hardcodedMocksIncludedInResult
 *   )
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */

import React from 'react';
import * as fc from 'fast-check';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { Integration as BackendIntegration } from '@/services/integrationServiceBackend';

// ---- Hardcoded mock names that should NEVER appear when showing real backend data ----
const HARDCODED_MOCK_NAMES = [
  'Slack',
  'Google Workspace',
  'Salesforce',
  'AWS S3',
  'PostgreSQL',
  'GitHub',
  'Anthropic Claude',
  'OAuth 2.0',
];

// ---- Mock the backend service ----
const mockListIntegrations = jest.fn<Promise<BackendIntegration[]>, any[]>();

jest.mock('@/services/integrationServiceBackend', () => ({
  integrationServiceBackend: {
    listIntegrations: (...args: any[]) => mockListIntegrations(...args),
    createIntegration: jest.fn(),
    updateIntegration: jest.fn(),
    connectIntegration: jest.fn(),
    disconnectIntegration: jest.fn(),
    deleteIntegration: jest.fn(),
    testIntegration: jest.fn(),
  },
}));

// ---- Mock UI component dependencies to avoid versioned import issues ----
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
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

jest.mock('@/components/IntegrationCard', () => ({
  IntegrationCard: ({ integration }: any) =>
    React.createElement('div', {
      'data-testid': 'integration-card',
      'data-name': integration.name,
    }, integration.name),
}));

jest.mock('@/components/ConnectorTypeSelector', () => ({
  ConnectorTypeSelector: () => React.createElement('div', { 'data-testid': 'connector-type-selector' }),
}));

jest.mock('@/components/DynamicConnectorForm', () => ({
  DynamicConnectorForm: () => React.createElement('div', { 'data-testid': 'dynamic-connector-form' }),
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

// ---- Tests ----

describe('Property 1: Fault Condition – Hardcoded Mocks Displayed Instead of Backend Integrations', () => {
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  /**
   * Scoped PBT case 1:
   * Mock backend returning CONFLUENCE + JIRA + SERVICENOW with status CONNECTED
   * → assert all 3 appear, no hardcoded mock names present.
   *
   * On UNFIXED code this WILL FAIL because:
   *  - Only Confluence is extracted from backend results (JIRA & SERVICENOW are discarded)
   *  - 8 hardcoded mocks are always merged in
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  it('should display all backend integrations and no hardcoded mocks (CONFLUENCE + JIRA + SERVICENOW)', async () => {
    const backendIntegrations: BackendIntegration[] = [
      makeBackendIntegration({ integrationType: 'CONFLUENCE', name: 'Confluence' }),
      makeBackendIntegration({ integrationType: 'JIRA', name: 'Jira' }),
      makeBackendIntegration({ integrationType: 'SERVICENOW', name: 'ServiceNow' }),
    ];

    mockListIntegrations.mockResolvedValue(backendIntegrations);

    render(React.createElement(Integrations));

    // Wait for loading to finish and cards to appear
    await waitFor(() => {
      expect(screen.queryAllByTestId('integration-card').length).toBeGreaterThan(0);
    });

    const cards = screen.getAllByTestId('integration-card');
    const renderedNames = cards.map((card) => card.getAttribute('data-name'));

    // Property: exactly 3 integrations should be rendered (one per backend integration)
    expect(cards).toHaveLength(3);

    // Property: all 3 backend integration names should be present
    expect(renderedNames).toContain('Confluence');
    expect(renderedNames).toContain('Jira');
    expect(renderedNames).toContain('ServiceNow');

    // Property: none of the 8 hardcoded mock names should appear
    for (const mockName of HARDCODED_MOCK_NAMES) {
      expect(renderedNames).not.toContain(mockName);
    }
  });

  /**
   * Scoped PBT case 2:
   * Mock backend returning zero integrations
   * → assert page shows 0 integration cards (not 9 mocks).
   *
   * On UNFIXED code this WILL FAIL because:
   *  - loadIntegrations always merges 8 mocks + 1 Confluence fallback = 9 items
   *
   * **Validates: Requirements 1.4**
   */
  it('should display 0 integrations when backend returns empty list', async () => {
    mockListIntegrations.mockResolvedValue([]);

    render(React.createElement(Integrations));

    // Wait for loading to finish
    await waitFor(() => {
      expect(mockListIntegrations).toHaveBeenCalled();
    });

    // Small delay to let state settle after async loadIntegrations
    await waitFor(() => {
      // Property: no integration cards should be rendered
      const cards = screen.queryAllByTestId('integration-card');
      expect(cards).toHaveLength(0);
    });
  });

  /**
   * Scoped PBT case 3:
   * Assert `listIntegrations` is called with status `CONNECTED`.
   *
   * On UNFIXED code this WILL FAIL because:
   *  - listIntegrations is called without a status parameter
   *
   * **Validates: Requirements 1.3**
   */
  it('should call listIntegrations with status CONNECTED', async () => {
    mockListIntegrations.mockResolvedValue([]);

    render(React.createElement(Integrations));

    await waitFor(() => {
      expect(mockListIntegrations).toHaveBeenCalled();
    });

    // Property: listIntegrations must be called with orgId and status 'CONNECTED'
    expect(mockListIntegrations).toHaveBeenCalledWith('default', 'CONNECTED');
  });

  /**
   * Property-based test using fast-check:
   * For any arbitrary set of backend integrations, the rendered count must equal
   * the backend count, and no hardcoded mock names should appear.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
   */
  it('for any set of backend integrations, rendered count equals backend count and no mocks appear', async () => {
    // Exclude SLACK because its registry name ("Slack") overlaps with HARDCODED_MOCK_NAMES.
    // We only generate types whose display names are NOT in the mock list.
    const integrationTypeArb = fc.constantFrom(
      'CONFLUENCE',
      'JIRA',
      'SERVICENOW',
      'PAGERDUTY',
      'ZENDESK',
    );

    // Generate 1-6 unique integration types
    const backendSetArb = fc
      .uniqueArray(integrationTypeArb, { minLength: 1, maxLength: 6 })
      .map((types) =>
        types.map((t) =>
          makeBackendIntegration({
            integrationType: t,
            name: `${t.charAt(0)}${t.slice(1).toLowerCase()}`,
          }),
        ),
      );

    await fc.assert(
      fc.asyncProperty(backendSetArb, async (backendIntegrations) => {
        cleanup();
        jest.clearAllMocks();
        mockListIntegrations.mockResolvedValue(backendIntegrations);

        render(React.createElement(Integrations));

        await waitFor(() => {
          const cards = screen.queryAllByTestId('integration-card');
          // Property: rendered count must equal backend count
          expect(cards).toHaveLength(backendIntegrations.length);
        });

        const cards = screen.getAllByTestId('integration-card');
        const renderedNames = cards.map((c) => c.getAttribute('data-name'));

        // Property: no hardcoded mock names should appear
        for (const mockName of HARDCODED_MOCK_NAMES) {
          expect(renderedNames).not.toContain(mockName);
        }

        cleanup();
      }),
      { numRuns: 5 }, // Keep low since each run renders a React component
    );
  });
});
