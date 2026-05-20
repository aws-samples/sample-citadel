/**
 * TDD Tests for adapter deprovision methods
 *
 * Verifies that all adapters with provision() also implement deprovision()
 * so that CREATE_NEW data stores can be properly cleaned up on deletion.
 */
import { getAdapter } from '../registry';

const PROVISIONABLE_TYPES = [
  'S3',
  'DYNAMODB',
  'RDS_POSTGRESQL',
  'RDS_MYSQL',
  'AURORA_POSTGRESQL',
  'AURORA_MYSQL',
  'REDSHIFT',
  'OPENSEARCH',
  'NEPTUNE',
  'TIMESTREAM',
  'ELASTICACHE_REDIS',
  'KEYSPACES',
  'DOCUMENTDB',
  'LAKE_FORMATION',
  'KNOWLEDGE_BASE',
];

describe('All provisionable adapters implement deprovision', () => {
  test.each(PROVISIONABLE_TYPES)(
    '%s adapter has a deprovision method',
    (type) => {
      const adapter = getAdapter(type);
      expect(adapter.provision).toBeDefined();
      expect(adapter.deprovision).toBeDefined();
      expect(typeof adapter.deprovision).toBe('function');
    }
  );
});
