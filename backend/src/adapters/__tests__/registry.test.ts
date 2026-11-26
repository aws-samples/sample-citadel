/**
 * TDD Tests for Unified Connector Registry
 *
 * The registry should provide a single lookup for both datastore and integration adapters.
 */

import { UnifiedRegistry } from '../registry';
import { BaseIntegrationAdapter } from '../integration/base-integration-adapter';
import { ConnectionTesterIntegrationAdapter } from '../integration/connection-tester-integration-adapter';
import { NotImplementedError } from '../errors';
import { AuthenticationMethod, ConnectorSpec } from '../base';

describe('UnifiedRegistry', () => {
  let registry: UnifiedRegistry;

  beforeEach(() => {
    registry = new UnifiedRegistry();
  });

  test('getAdapter returns a datastore adapter for known datastore types', () => {
    const adapter = registry.getAdapter('S3');
    expect(adapter).toBeDefined();
    expect(adapter.category).toBe('datastore');
    expect(adapter.spec.type).toBe('S3');
  });

  test('getAdapter returns a datastore adapter for DynamoDB', () => {
    const adapter = registry.getAdapter('DYNAMODB');
    expect(adapter).toBeDefined();
    expect(adapter.category).toBe('datastore');
  });

  test('getAdapter returns an integration adapter for known integration types', () => {
    const adapter = registry.getAdapter('CONFLUENCE');
    expect(adapter).toBeDefined();
    expect(adapter.category).toBe('integration');
    expect(adapter.spec.type).toBe('CONFLUENCE');
  });

  test('getAdapter returns an integration adapter for AgentCore types', () => {
    const adapter = registry.getAdapter('AWS_LAMBDA');
    expect(adapter).toBeDefined();
    expect(adapter.category).toBe('integration');
    expect(adapter.spec.type).toBe('AWS_LAMBDA');
  });

  test('getAdapter throws ValidationError for unknown types', () => {
    expect(() => registry.getAdapter('UNKNOWN_TYPE')).toThrow('Unsupported connector type');
  });

  test('listTypes returns all registered type strings', () => {
    const types = registry.listTypes();
    expect(types).toContain('S3');
    expect(types).toContain('DYNAMODB');
    expect(types).toContain('CONFLUENCE');
    expect(types).toContain('AWS_LAMBDA');
    expect(types).toContain('MCP_SERVER');
  });

  test('listByCategory("datastore") returns only datastore adapters', () => {
    const datastores = registry.listByCategory('datastore');
    expect(datastores.length).toBeGreaterThan(0);
    datastores.forEach((type) => {
      const adapter = registry.getAdapter(type);
      expect(adapter.category).toBe('datastore');
    });
  });

  test('listByCategory("integration") returns only integration adapters', () => {
    const integrations = registry.listByCategory('integration');
    expect(integrations.length).toBeGreaterThan(0);
    integrations.forEach((type) => {
      const adapter = registry.getAdapter(type);
      expect(adapter.category).toBe('integration');
    });
  });

  test('all existing datastore types are registered', () => {
    const expectedDatastoreTypes = [
      'S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'RDS_MYSQL',
      'AURORA_POSTGRESQL', 'AURORA_MYSQL', 'REDSHIFT', 'OPENSEARCH',
      'NEPTUNE', 'TIMESTREAM', 'ELASTICACHE_REDIS', 'KEYSPACES',
      'DOCUMENTDB', 'LAKE_FORMATION', 'S3_TABLES', 'SAGEMAKER_LAKEHOUSE',
      'SAGEMAKER_FEATURE_STORE', 'KNOWLEDGE_BASE', 'SNOWFLAKE', 'DATABRICKS',
      'EXTERNAL_POSTGRESQL', 'EXTERNAL_MYSQL', 'EXTERNAL_MONGODB',
      'EXTERNAL_ELASTICSEARCH', 'EXTERNAL_REDIS', 'EXTERNAL_API',
    ];
    for (const type of expectedDatastoreTypes) {
      expect(() => registry.getAdapter(type)).not.toThrow();
    }
  });

  test('all existing integration types are registered', () => {
    const expectedIntegrationTypes = [
      'CONFLUENCE', 'SERVICENOW', 'JIRA', 'SLACK', 'MICROSOFT',
      'ZENDESK', 'PAGERDUTY',
      'AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER',
    ];
    for (const type of expectedIntegrationTypes) {
      expect(() => registry.getAdapter(type)).not.toThrow();
    }
  });

  test('getSpec returns the connector spec for a type', () => {
    const spec = registry.getSpec('CONFLUENCE');
    expect(spec).toBeDefined();
    expect(spec!.type).toBe('CONFLUENCE');
    expect(spec!.provider).toBe('Atlassian');
  });

  test('getSpec returns undefined for unknown types', () => {
    const spec = registry.getSpec('NONEXISTENT');
    expect(spec).toBeUndefined();
  });

  /**
   * Regression: PR2 — the unified-registry path must be structurally
   * equivalent to the integration-resolver path. Each IMPLEMENT-list
   * connector type is wrapped in ConnectionTesterIntegrationAdapter so its
   * `testConnection` delegates to `utils/connection-tester.testConnection`.
   * Wrapping any of these in the bare BaseIntegrationAdapter would silently
   * regress the registry path back to NotImplementedError-on-test (or, prior
   * to that backstop, fake `{ success: true }`).
   */
  describe('IMPLEMENT-list connectors are wired through ConnectionTesterIntegrationAdapter', () => {
    const IMPLEMENT_KEYS = [
      'CONFLUENCE',
      'SERVICENOW',
      'JIRA',
      'SLACK',
      'MICROSOFT',
      'ZENDESK',
      'PAGERDUTY',
      'AWS_LAMBDA',
      'AWS_SMITHY',
      'MCP_SERVER',
    ];

    test.each(IMPLEMENT_KEYS)(
      '%s is an instance of ConnectionTesterIntegrationAdapter',
      (type) => {
        const adapter = registry.getAdapter(type);
        expect(adapter).toBeInstanceOf(ConnectionTesterIntegrationAdapter);
        // And by inheritance still satisfies the BaseIntegrationAdapter shape:
        expect(adapter).toBeInstanceOf(BaseIntegrationAdapter);
        expect(adapter.category).toBe('integration');
        expect(adapter.spec.type).toBe(type);
      }
    );
  });

  /**
   * Backstop: the bare BaseIntegrationAdapter must keep throwing
   * NotImplementedError on testConnection. This guards against future
   * connector types being silently registered without a real implementation
   * (which is exactly the silent-success regression the NotImplementedError
   * throw was added to fix).
   */
  describe('BaseIntegrationAdapter loud-failure backstop', () => {
    const dummySpec: Omit<ConnectorSpec, 'category'> = {
      type: 'UNREGISTERED_CONNECTOR',
      provider: 'Test',
      authentication: {
        method: AuthenticationMethod.API_KEY,
        fields: ['apiToken'],
        secretStructure: { apiToken: 'string' },
      },
      configuration: { required: [], optional: [], ssmParameters: [] },
    };

    test('a manually-instantiated bare BaseIntegrationAdapter still throws NotImplementedError on testConnection', async () => {
      const bare = new BaseIntegrationAdapter(dummySpec);
      await expect(bare.testConnection({}, {})).rejects.toBeInstanceOf(
        NotImplementedError
      );
    });
  });
});
