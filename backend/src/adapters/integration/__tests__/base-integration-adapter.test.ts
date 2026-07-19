/**
 * TDD Tests for BaseIntegrationAdapter.
 *
 * The default `testConnection` MUST throw NotImplementedError so that
 * unimplemented connector types fail loudly instead of pretending to pass.
 * Subclasses that override `testConnection` MUST continue to work.
 *
 * Backstop for the silent-success regression: the previous implementation
 * returned `{ success: true, message: '... placeholder' }` which masked
 * every integration test failure across BACKEND_CONNECTOR_REGISTRY.
 */

import { BaseIntegrationAdapter } from '../base-integration-adapter';
import {
  ConnectorSpec,
  ConnectionTestResult,
  AuthenticationMethod,
} from '../../base';
import { NotImplementedError } from '../../errors';

const baseSpec: Omit<ConnectorSpec, 'category'> = {
  type: 'TEST_INT',
  provider: 'TestProvider',
  authentication: {
    method: AuthenticationMethod.API_KEY,
    fields: ['apiToken'],
    secretStructure: { apiToken: 'string' },
  },
  configuration: {
    required: ['baseUrl'],
    optional: [],
    ssmParameters: [],
  },
};

describe('BaseIntegrationAdapter', () => {
  describe('default testConnection (un-overridden)', () => {
    const adapter = new BaseIntegrationAdapter(baseSpec);

    it('throws NotImplementedError', async () => {
      await expect(adapter.testConnection({})).rejects.toBeInstanceOf(
        NotImplementedError
      );
    });

    it('error message identifies the connector type via spec.type', async () => {
      try {
        await adapter.testConnection({});
        fail('Expected NotImplementedError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(NotImplementedError);
        expect((err as Error).message).toContain('TEST_INT');
        expect((err as Error).message).toContain('testConnection');
      }
    });

    it('error has name "NotImplementedError"', async () => {
      try {
        await adapter.testConnection({});
        fail('Expected NotImplementedError');
      } catch (err: unknown) {
        expect((err as Error).name).toBe('NotImplementedError');
      }
    });

    it('uses the actual spec.type for each registered connector', async () => {
      const confluenceAdapter = new BaseIntegrationAdapter({
        ...baseSpec,
        type: 'CONFLUENCE',
      });
      try {
        await confluenceAdapter.testConnection({});
        fail('Expected NotImplementedError');
      } catch (err: unknown) {
        expect((err as Error).message).toContain('CONFLUENCE');
      }
    });
  });

  describe('subclasses overriding testConnection still work', () => {
    class WorkingIntegrationAdapter extends BaseIntegrationAdapter {
      async testConnection(
        _config: Record<string, unknown>,
        _credentials?: Record<string, unknown>
      ): Promise<ConnectionTestResult> {
        return { success: true, message: 'overridden' };
      }
    }

    it('subclass override returns its result without throwing', async () => {
      const adapter = new WorkingIntegrationAdapter(baseSpec);
      const result = await adapter.testConnection({});
      expect(result.success).toBe(true);
      expect(result.message).toBe('overridden');
    });
  });

  describe('connect/disconnect remain intentional EventBridge no-ops', () => {
    const adapter = new BaseIntegrationAdapter(baseSpec);

    it('connect resolves without throwing', async () => {
      await expect(adapter.connect({})).resolves.toBeUndefined();
    });

    it('disconnect resolves without throwing', async () => {
      await expect(adapter.disconnect({})).resolves.toBeUndefined();
    });
  });

  describe('validate is unaffected', () => {
    const adapter = new BaseIntegrationAdapter(baseSpec);

    it('returns errors when required fields are missing', () => {
      const result = adapter.validate({}, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining(['Missing required field: apiToken']),
      );
    });

    it('passes when required fields are present', () => {
      const result = adapter.validate(
        { apiToken: 'tok' },
        { baseUrl: 'https://x.com' },
      );
      expect(result.valid).toBe(true);
    });
  });
});
