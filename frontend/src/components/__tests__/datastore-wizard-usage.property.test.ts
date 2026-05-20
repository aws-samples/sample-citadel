// Feature: datastore-integration-pipeline, Property 7: DataStoreToolWizard Operation Filtering by Usage
// **Validates: Requirements 1.12, 1.13**

import * as fc from 'fast-check';
import {
  getAvailableOperationsForUsage,
  getDataStoreOperationsForType,
} from '../datastore-wizard-usage-utils';

/**
 * Property 7: DataStoreToolWizard Operation Filtering by Usage
 *
 * For any data store type and usage value, when a data store with usage
 * `knowledge` is selected in the DataStoreToolWizard, the default available
 * operations should be exactly the read-only subset for that data store type.
 * When a data store with usage `operational` or `both` is selected, the
 * available operations should be the full CRUD set for that data store type
 * with no restrictions.
 */

// --- Known data store types with explicit operation mappings ---
const KNOWN_TYPES = [
  'S3',
  'DYNAMODB',
  'RDS_POSTGRESQL',
  'RDS_MYSQL',
  'AURORA_POSTGRESQL',
  'AURORA_MYSQL',
  'KNOWLEDGE_BASE',
  'REDSHIFT',
  'OPENSEARCH',
  'NEPTUNE',
  'TIMESTREAM',
  'DOCUMENTDB',
  'ELASTICACHE_REDIS',
] as const;

// --- Arbitraries ---

/** Generates a known data store type */
const arbKnownType = fc.constantFrom(...KNOWN_TYPES);

/** Generates an unknown data store type (for fallback/generic behavior) */
const arbUnknownType = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{2,20}$/)
  .filter((s) => !KNOWN_TYPES.includes(s as any));

/** Generates any data store type (known or unknown) */
const arbDataStoreType = fc.oneof(arbKnownType, arbUnknownType);

// --- Expected read-only operations per type (from design doc) ---
const EXPECTED_READ_ONLY: Record<string, string[]> = {
  S3: ['read_object', 'list_objects'],
  DYNAMODB: ['get_item', 'query', 'scan'],
  RDS_POSTGRESQL: ['execute_query', 'list_tables'],
  RDS_MYSQL: ['execute_query', 'list_tables'],
  AURORA_POSTGRESQL: ['execute_query', 'list_tables'],
  AURORA_MYSQL: ['execute_query', 'list_tables'],
  KNOWLEDGE_BASE: ['query_knowledge_base', 'retrieve_documents'],
  REDSHIFT: ['execute_query', 'list_tables'],
  OPENSEARCH: ['search'],
  NEPTUNE: ['execute_query', 'list_graphs'],
  TIMESTREAM: ['query'],
  DOCUMENTDB: ['find'],
  ELASTICACHE_REDIS: ['get', 'scan'],
};

// --- Tests ---

describe('Property 7: DataStoreToolWizard Operation Filtering by Usage', () => {
  // Feature: datastore-integration-pipeline, Property 7: Operation Filtering by Usage

  it('knowledge usage returns exactly the read-only subset for known data store types', () => {
    fc.assert(
      fc.property(arbKnownType, (dataStoreType) => {
        const result = getAvailableOperationsForUsage(dataStoreType, 'knowledge');
        const expectedReadOnly = EXPECTED_READ_ONLY[dataStoreType];

        // Result must be exactly the read-only subset
        expect(result.sort()).toEqual(expectedReadOnly.sort());

        // Result must be a strict subset of (or equal to) the full operations
        const fullOps = getDataStoreOperationsForType(dataStoreType);
        for (const op of result) {
          expect(fullOps).toContain(op);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('knowledge usage returns read-only fallback for unknown data store types', () => {
    fc.assert(
      fc.property(arbUnknownType, (dataStoreType) => {
        const result = getAvailableOperationsForUsage(dataStoreType, 'knowledge');

        // Unknown types should fall back to generic read-only: ['read']
        expect(result).toEqual(['read']);
      }),
      { numRuns: 100 },
    );
  });

  it('operational usage returns the full CRUD set with no restrictions', () => {
    fc.assert(
      fc.property(arbDataStoreType, (dataStoreType) => {
        const result = getAvailableOperationsForUsage(dataStoreType, 'operational');
        const fullOps = getDataStoreOperationsForType(dataStoreType);

        // Result must be exactly the full operations set
        expect(result.sort()).toEqual([...fullOps].sort());
      }),
      { numRuns: 100 },
    );
  });

  it('both usage returns the full CRUD set with no restrictions', () => {
    fc.assert(
      fc.property(arbDataStoreType, (dataStoreType) => {
        const result = getAvailableOperationsForUsage(dataStoreType, 'both');
        const fullOps = getDataStoreOperationsForType(dataStoreType);

        // Result must be exactly the full operations set
        expect(result.sort()).toEqual([...fullOps].sort());
      }),
      { numRuns: 100 },
    );
  });

  it('knowledge read-only ops are always a subset of the full ops for any type', () => {
    fc.assert(
      fc.property(arbDataStoreType, (dataStoreType) => {
        const readOnlyOps = getAvailableOperationsForUsage(dataStoreType, 'knowledge');
        const fullOps = getDataStoreOperationsForType(dataStoreType);

        // Every read-only op must exist in the full ops set
        for (const op of readOnlyOps) {
          expect(fullOps).toContain(op);
        }

        // Read-only set must be non-empty
        expect(readOnlyOps.length).toBeGreaterThan(0);

        // Read-only set must have <= full ops count
        expect(readOnlyOps.length).toBeLessThanOrEqual(fullOps.length);
      }),
      { numRuns: 100 },
    );
  });
});
