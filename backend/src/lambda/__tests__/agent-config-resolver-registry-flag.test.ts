/**
 * Tests for feature flag check and Registry Service initialization (task 6.1)
 */
import { isRegistryEnabled, getRegistryService, _resetRegistryService } from '../agent-config-resolver';

// Mock the RegistryService module so we don't need real AWS SDK clients
jest.mock('../../services/registry-service', () => {
  return {
    RegistryService: jest.fn().mockImplementation((config: { registryId: string; region?: string }) => ({
      getRegistryId: () => config.registryId,
      _config: config,
    })),
  };
});

describe('feature flag and registry service initialization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetRegistryService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isRegistryEnabled', () => {
    test('returns false when REGISTRY_ENABLED is not set', () => {
      delete process.env.REGISTRY_ENABLED;
      expect(isRegistryEnabled()).toBe(false);
    });

    test('returns false when REGISTRY_ENABLED is "false"', () => {
      process.env.REGISTRY_ENABLED = 'false';
      expect(isRegistryEnabled()).toBe(false);
    });

    test('returns true when REGISTRY_ENABLED is "true"', () => {
      process.env.REGISTRY_ENABLED = 'true';
      expect(isRegistryEnabled()).toBe(true);
    });

    test('returns false for any value other than "true"', () => {
      process.env.REGISTRY_ENABLED = 'yes';
      expect(isRegistryEnabled()).toBe(false);

      process.env.REGISTRY_ENABLED = '1';
      expect(isRegistryEnabled()).toBe(false);

      process.env.REGISTRY_ENABLED = 'TRUE';
      expect(isRegistryEnabled()).toBe(false);
    });
  });

  describe('getRegistryService', () => {
    test('throws when REGISTRY_ID is not set', () => {
      delete process.env.REGISTRY_ID;
      expect(() => getRegistryService()).toThrow(
        'REGISTRY_ID environment variable is required when REGISTRY_ENABLED is true',
      );
    });

    test('creates RegistryService with correct config', () => {
      process.env.REGISTRY_ID = 'test-registry-123';
      process.env.AWS_REGION = 'us-west-2';

      const service = getRegistryService();
      expect(service.getRegistryId()).toBe('test-registry-123');
    });

    test('returns the same instance on subsequent calls (lazy singleton)', () => {
      process.env.REGISTRY_ID = 'test-registry-123';
      process.env.AWS_REGION = 'us-east-1';

      const first = getRegistryService();
      const second = getRegistryService();
      expect(first).toBe(second);
    });

    test('defaults region to us-east-1 when AWS_REGION is not set', () => {
      process.env.REGISTRY_ID = 'test-registry-456';
      delete process.env.AWS_REGION;

      const service = getRegistryService() as unknown as { _config: { region?: string } };
      expect(service._config.region).toBe('us-east-1');
    });

    test('_resetRegistryService clears the cached instance', () => {
      process.env.REGISTRY_ID = 'reg-1';
      process.env.AWS_REGION = 'us-east-1';

      const first = getRegistryService();
      _resetRegistryService();

      process.env.REGISTRY_ID = 'reg-2';
      const second = getRegistryService();

      expect(first).not.toBe(second);
      expect(second.getRegistryId()).toBe('reg-2');
    });
  });
});
