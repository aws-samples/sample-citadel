/**
 * TDD Tests for ConnectionTesterIntegrationAdapter.
 *
 * The class is the canonical wiring between BACKEND_CONNECTOR_REGISTRY entries
 * and the existing utils/connection-tester.testConnection implementation.
 *
 * It MUST:
 *   - delegate testConnection to connection-tester.testConnection with
 *     (spec.type, credentials, config),
 *   - return the connection-tester result unchanged (no mutation, no swallow),
 *   - propagate errors thrown by connection-tester (do NOT silently succeed),
 *   - inherit the BaseIntegrationAdapter no-op connect/disconnect (integrations
 *     connect via EventBridge events).
 *
 * Backstop note: BaseIntegrationAdapter.testConnection still throws
 * NotImplementedError. That backstop is exercised by base-integration-adapter.test.ts;
 * the regression test in registry.test.ts asserts the IMPLEMENT-list keys are
 * wired through this subclass and not the bare base.
 */

import { ConnectionTesterIntegrationAdapter } from '../connection-tester-integration-adapter';
import {
  AuthenticationMethod,
  ConnectorSpec,
  ConnectionTestResult,
} from '../../base';

const mockRunConnectionTest = jest.fn();
jest.mock('../../../utils/connection-tester', () => ({
  testConnection: (...args: any[]) => mockRunConnectionTest(...args),
}));

const baseSpec: Omit<ConnectorSpec, 'category'> = {
  type: 'CONFLUENCE',
  provider: 'Atlassian',
  authentication: {
    method: AuthenticationMethod.API_KEY,
    fields: ['email', 'apiToken'],
    secretStructure: { email: 'string', apiToken: 'string' },
  },
  configuration: {
    required: ['baseUrl'],
    optional: [],
    ssmParameters: [],
  },
  testEndpoint: '/wiki/api/v2/spaces?limit=1',
};

describe('ConnectionTesterIntegrationAdapter', () => {
  beforeEach(() => {
    mockRunConnectionTest.mockReset();
  });

  describe('testConnection delegation', () => {
    it('delegates to connection-tester.testConnection with spec.type, credentials, config', async () => {
      mockRunConnectionTest.mockResolvedValueOnce({
        success: true,
        message: 'OK',
        details: {},
      });

      const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);
      const config = { baseUrl: 'https://example.atlassian.net' };
      const credentials = { email: 'a@b.com', apiToken: 'tok' };

      await adapter.testConnection(config, credentials);

      expect(mockRunConnectionTest).toHaveBeenCalledTimes(1);
      expect(mockRunConnectionTest).toHaveBeenCalledWith(
        'CONFLUENCE',
        credentials,
        config
      );
    });

    it('returns the connection-tester result unchanged', async () => {
      const expected: ConnectionTestResult = {
        success: true,
        message: 'Connection successful',
        details: { statusCode: 200, endpoint: '/wiki/api/v2/spaces?limit=1' },
      };
      mockRunConnectionTest.mockResolvedValueOnce(expected);

      const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);
      const result = await adapter.testConnection({}, {});

      expect(result).toBe(expected);
    });

    it('passes spec.type for each registered connector (e.g. JIRA)', async () => {
      mockRunConnectionTest.mockResolvedValueOnce({
        success: false,
        message: 'no',
        details: {},
      });
      const adapter = new ConnectionTesterIntegrationAdapter({
        ...baseSpec,
        type: 'JIRA',
      });

      await adapter.testConnection({}, {});

      expect(mockRunConnectionTest).toHaveBeenCalledWith('JIRA', {}, {});
    });

    it('propagates errors thrown by connection-tester (does not swallow)', async () => {
      const boom = new Error('network exploded');
      mockRunConnectionTest.mockRejectedValueOnce(boom);

      const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);

      await expect(adapter.testConnection({}, {})).rejects.toBe(boom);
    });

    it('forwards undefined credentials when caller omits them', async () => {
      mockRunConnectionTest.mockResolvedValueOnce({
        success: true,
        message: 'ok',
        details: {},
      });
      const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);

      await adapter.testConnection({ baseUrl: 'https://x' });

      expect(mockRunConnectionTest).toHaveBeenCalledWith(
        'CONFLUENCE',
        undefined,
        { baseUrl: 'https://x' }
      );
    });
  });

  describe('inherited connect/disconnect remain EventBridge no-ops', () => {
    const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);

    it('connect resolves without throwing', async () => {
      await expect(adapter.connect({}, {})).resolves.toBeUndefined();
    });

    it('disconnect resolves without throwing', async () => {
      await expect(adapter.disconnect({})).resolves.toBeUndefined();
    });

    it('does NOT call connection-tester from connect/disconnect', async () => {
      await adapter.connect({}, {});
      await adapter.disconnect({});
      expect(mockRunConnectionTest).not.toHaveBeenCalled();
    });
  });

  describe('spec wiring', () => {
    it('preserves the spec on the instance with category="integration"', () => {
      const adapter = new ConnectionTesterIntegrationAdapter(baseSpec);
      expect(adapter.spec.type).toBe('CONFLUENCE');
      expect(adapter.spec.category).toBe('integration');
      expect(adapter.category).toBe('integration');
    });
  });
});
