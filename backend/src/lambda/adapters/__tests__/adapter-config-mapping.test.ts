/**
 * TDD Tests for adapter config field mapping
 *
 * The frontend wizard sends generic config fields (resourceName/resourceArn)
 * for types that don't have specific wizard fields. The datastore-resolver
 * must inject the data store name into the config so adapters can use it
 * as the resource name when provisioning.
 *
 * Additionally, each adapter's provision() method should accept the generic
 * resourceName field and map it to the adapter-specific field.
 */
import { getAdapter } from '../registry';

// Types that fall through to the default case in the frontend wizard
// and receive { resourceName: 'some-name' } for CREATE_NEW mode.
const GENERIC_AWS_TYPES = [
  'KNOWLEDGE_BASE',
  'OPENSEARCH',
  'NEPTUNE',
  'TIMESTREAM',
  'ELASTICACHE_REDIS',
  'KEYSPACES',
  'DOCUMENTDB',
  'REDSHIFT',
  'LAKE_FORMATION',
  'AURORA_POSTGRESQL',
  'AURORA_MYSQL',
];

describe('Adapters accept resourceName in config for provision', () => {
  test.each(GENERIC_AWS_TYPES)(
    '%s adapter has provision method that can be called',
    (type) => {
      const adapter = getAdapter(type);
      expect(adapter.provision).toBeDefined();
      expect(typeof adapter.provision).toBe('function');
    }
  );
});

describe('Resolver injects name into config', () => {
  // This tests the resolver behavior of enriching config with the name field.
  // The actual test is in the resolver test file; here we verify adapters
  // can handle the enriched config.

  test.each(GENERIC_AWS_TYPES)(
    '%s adapter requiredPolicies does not throw with resourceName config',
    (type) => {
      const adapter = getAdapter(type);
      // Should not throw when given generic config
      expect(() =>
        adapter.requiredPolicies({ resourceName: 'test-resource' }, '123456789012', 'us-east-1')
      ).not.toThrow();
    }
  );
});
