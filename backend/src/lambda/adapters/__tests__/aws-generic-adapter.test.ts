/**
 * TDD Tests for AwsGenericAdapter.
 *
 * The AwsGenericAdapter is a fallback wrapper for AWS services that lack a real
 * adapter. It MUST refuse to operate (throw NotImplementedError) rather than
 * pretend to succeed. The previous implementation returned hardcoded
 * `{ success: true }` and a fake ARN, masking every integration failure.
 *
 * Backstop: every method except `requiredPolicies` (intentionally returns empty
 * policies) must throw NotImplementedError with a message containing the
 * serviceName so callers can identify which fallback failed.
 */

import { AwsGenericAdapter } from '../aws-generic-adapter';
import { NotImplementedError } from '../../../adapters/errors';

describe('AwsGenericAdapter', () => {
  let adapter: AwsGenericAdapter;
  const config = { name: 'test-resource' };

  beforeEach(() => {
    adapter = new AwsGenericAdapter('opensearch');
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('requiredPolicies', () => {
    it('returns empty arrays for both provision and connect', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toEqual([]);
      expect(policies.connect).toEqual([]);
    });
  });

  describe('provision', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.provision(config)).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('error message contains the serviceName and method name', async () => {
      try {
        await adapter.provision(config);
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err.message).toContain('opensearch');
        expect(err.message).toContain('provision');
      }
    });

    it('still logs the attempt before throwing', async () => {
      const logSpy = jest.spyOn(console, 'log');
      await adapter.provision(config).catch(() => {});
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AwsGenericAdapter:opensearch] provision called'),
        config,
      );
    });
  });

  describe('connect', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.connect(config)).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('error message contains the serviceName', async () => {
      try {
        await adapter.connect(config);
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err.message).toContain('opensearch');
        expect(err.message).toContain('connect');
      }
    });
  });

  describe('disconnect', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.disconnect(config)).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('error message contains the serviceName', async () => {
      try {
        await adapter.disconnect(config);
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err.message).toContain('opensearch');
        expect(err.message).toContain('disconnect');
      }
    });
  });

  describe('testConnection', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.testConnection(config)).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('error message contains the serviceName', async () => {
      try {
        await adapter.testConnection(config);
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err.message).toContain('opensearch');
        expect(err.message).toContain('testConnection');
      }
    });
  });

  describe('getMetrics', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.getMetrics(config)).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('error message contains the serviceName', async () => {
      try {
        await adapter.getMetrics(config);
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err.message).toContain('opensearch');
        expect(err.message).toContain('getMetrics');
      }
    });
  });

  describe('serviceName propagates through different instances', () => {
    const services = ['qldb', 'aurora-postgresql', 'redshift'];

    test.each(services)('serviceName "%s" appears in NotImplementedError messages', async (svc) => {
      const a = new AwsGenericAdapter(svc);
      try {
        await a.testConnection({});
        fail('Expected NotImplementedError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NotImplementedError);
        expect(err.message).toContain(svc);
      }
    });
  });
});
