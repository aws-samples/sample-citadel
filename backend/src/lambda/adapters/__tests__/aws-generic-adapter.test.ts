import { AwsGenericAdapter } from '../aws-generic-adapter';

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
    it('returns a ProvisionResult with a non-empty resourceArn', async () => {
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBeTruthy();
      expect(result.resourceArn).toContain('opensearch');
    });
  });

  describe('connect', () => {
    it('resolves without error', async () => {
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('resolves without error', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success true', async () => {
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
    });
  });

  describe('getMetrics', () => {
    it('returns placeholder metrics', async () => {
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0 bytes');
      expect(result.records).toBe(0);
    });
  });
});
