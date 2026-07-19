/**
 * TDD Tests for Unified Connector Adapter Base Interface
 *
 * These tests define the contract that all connector adapters must satisfy,
 * whether they are datastore adapters or integration adapters.
 */

import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  RequiredPolicies,
  ConnectionTestResult,
  MetricsResult,
  ProvisionResult,
  AuthenticationMethod,
} from '../base';

// --- Minimal concrete adapter for testing the interface contract ---

class TestDataStoreAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = {
    type: 'TEST_DS',
    provider: 'Test',
    category: 'datastore',
    authentication: {
      method: AuthenticationMethod.IAM_ROLE,
      fields: ['roleArn'],
      secretStructure: { roleArn: 'string' },
    },
    configuration: {
      required: ['bucketName'],
      optional: [],
      ssmParameters: [],
    },
  };

  requiredPolicies(
    config: Record<string, unknown>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    return {
      provision: [{ actions: ['s3:CreateBucket'], resources: [`arn:aws:s3:::${config.bucketName}`] }],
      connect: [{ actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${config.bucketName}/*`] }],
    };
  }

  async testConnection(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    return { success: true, message: 'Connected' };
  }

  async connect(_config: Record<string, unknown>, _credentials?: Record<string, unknown>): Promise<void> {}
  async disconnect(_config: Record<string, unknown>): Promise<void> {}

  async provision(
    config: Record<string, unknown>,
    _credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    return { resourceArn: `arn:aws:s3:::${config.bucketName}` };
  }

  async getMetrics(_config: Record<string, unknown>): Promise<MetricsResult> {
    return { size: '10 MB', records: 100 };
  }

  validate(
    credentials: Record<string, unknown>,
    config: Record<string, unknown>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!config.bucketName) errors.push('Missing bucketName');
    return { valid: errors.length === 0, errors };
  }
}

class TestIntegrationAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'integration';
  readonly spec: ConnectorSpec = {
    type: 'TEST_INT',
    provider: 'TestProvider',
    category: 'integration',
    authentication: {
      method: AuthenticationMethod.API_KEY,
      fields: ['apiToken'],
      secretStructure: { apiToken: 'string' },
    },
    configuration: {
      required: ['baseUrl'],
      optional: [],
      ssmParameters: ['base-url'],
    },
    testEndpoint: '/api/test',
  };

  requiredPolicies(): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async testConnection(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    return { success: true, message: 'API reachable' };
  }

  async connect(_config: Record<string, unknown>, _credentials?: Record<string, unknown>): Promise<void> {}
  async disconnect(_config: Record<string, unknown>): Promise<void> {}

  validate(
    credentials: Record<string, unknown> | undefined,
    config: Record<string, unknown> | undefined
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!credentials?.apiToken) errors.push('Missing apiToken');
    if (!config?.baseUrl) errors.push('Missing baseUrl');
    return { valid: errors.length === 0, errors };
  }
}

describe('ConnectorAdapter Interface', () => {
  describe('DataStore adapter', () => {
    const adapter = new TestDataStoreAdapter();

    test('has category "datastore"', () => {
      expect(adapter.category).toBe('datastore');
    });

    test('has a spec with type and provider', () => {
      expect(adapter.spec.type).toBe('TEST_DS');
      expect(adapter.spec.provider).toBe('Test');
      expect(adapter.spec.category).toBe('datastore');
    });

    test('returns required policies for provision and connect', () => {
      const policies = adapter.requiredPolicies({ bucketName: 'my-bucket' }, '123456', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.connect).toHaveLength(1);
      expect(policies.provision[0].actions).toContain('s3:CreateBucket');
    });

    test('testConnection returns ConnectionTestResult', async () => {
      const result = await adapter.testConnection({ bucketName: 'my-bucket' });
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    test('connect and disconnect are callable', async () => {
      await expect(adapter.connect({ bucketName: 'my-bucket' })).resolves.toBeUndefined();
      await expect(adapter.disconnect({ bucketName: 'my-bucket' })).resolves.toBeUndefined();
    });

    test('provision returns ProvisionResult', async () => {
      const result = await adapter.provision!({ bucketName: 'my-bucket' });
      expect(result.resourceArn).toContain('my-bucket');
    });

    test('getMetrics returns MetricsResult', async () => {
      const result = await adapter.getMetrics!({ bucketName: 'my-bucket' });
      expect(result.size).toBeDefined();
      expect(result.records).toBeDefined();
    });

    test('validate checks config', () => {
      const valid = adapter.validate!({}, { bucketName: 'test' });
      expect(valid.valid).toBe(true);

      const invalid = adapter.validate!({}, {});
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toContain('Missing bucketName');
    });
  });

  describe('Integration adapter', () => {
    const adapter = new TestIntegrationAdapter();

    test('has category "integration"', () => {
      expect(adapter.category).toBe('integration');
    });

    test('has a spec with type, provider, and testEndpoint', () => {
      expect(adapter.spec.type).toBe('TEST_INT');
      expect(adapter.spec.provider).toBe('TestProvider');
      expect(adapter.spec.testEndpoint).toBe('/api/test');
    });

    test('returns empty policies for integrations that dont need IAM', () => {
      const policies = adapter.requiredPolicies({}, '', '');
      expect(policies.provision).toHaveLength(0);
      expect(policies.connect).toHaveLength(0);
    });

    test('testConnection returns ConnectionTestResult', async () => {
      const result = await adapter.testConnection({ baseUrl: 'https://example.com' });
      expect(result.success).toBe(true);
    });

    test('validate checks credentials and config', () => {
      const valid = adapter.validate!({ apiToken: 'tok' }, { baseUrl: 'https://x.com' });
      expect(valid.valid).toBe(true);

      const invalid = adapter.validate!({}, {});
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.length).toBeGreaterThan(0);
    });

    test('provision is not defined for integration adapters', () => {
      expect(adapter.provision).toBeUndefined();
    });

    test('getMetrics is not defined for integration adapters', () => {
      expect(adapter.getMetrics).toBeUndefined();
    });
  });
});
