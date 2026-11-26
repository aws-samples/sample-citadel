// Feature: tool-integration-binding, Property 5: Operations Registry Coverage for SaaS Types
// Feature: tool-integration-binding, Property 6: Operations Registry Lookup Consistency
import * as fc from 'fast-check';
import { BACKEND_CONNECTOR_REGISTRY } from '../connector-registry';
import { getOperations, getOperation, getDataStoreOperations } from '../operations-registry';

/**
 * Property 5: Operations Registry Coverage for SaaS Types
 *
 * For all integration types in BACKEND_CONNECTOR_REGISTRY that are not AgentCore
 * types (AWS_LAMBDA, AWS_SMITHY, MCP_SERVER), getOperations(type) should return
 * a non-empty array of operation descriptors where each descriptor has non-empty
 * operationId, name, description, and method fields.
 *
 * Validates: Requirements 3.1, 3.6, 4.2, 4.3
 */

const AGENTCORE_TYPES = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];

const saasTypes = Object.keys(BACKEND_CONNECTOR_REGISTRY).filter(
  (type) => !AGENTCORE_TYPES.includes(type),
);

describe('Operations Registry - Property-Based Tests', () => {
  describe('Property 5: Operations Registry Coverage for SaaS Types', () => {
    test('every SaaS type has non-empty operations with valid descriptors', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...saasTypes),
          (saasType) => {
            const operations = getOperations(saasType);

            // Must return a non-empty array
            expect(Array.isArray(operations)).toBe(true);
            expect(operations.length).toBeGreaterThan(0);

            // Each descriptor must have non-empty required fields
            for (const op of operations) {
              expect(typeof op.operationId).toBe('string');
              expect(op.operationId.length).toBeGreaterThan(0);

              expect(typeof op.name).toBe('string');
              expect(op.name.length).toBeGreaterThan(0);

              expect(typeof op.description).toBe('string');
              expect(op.description.length).toBeGreaterThan(0);

              expect(typeof op.method).toBe('string');
              expect(op.method.length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: tool-integration-binding, Property 6: Operations Registry Lookup Consistency
  describe('Property 6: Operations Registry Lookup Consistency', () => {
    /**
     * Property 6: Operations Registry Lookup Consistency
     *
     * For any integration type and operation ID, if getOperations(type) returns
     * an array containing an operation with that ID, then getOperation(type, operationId)
     * should return that same operation descriptor. If the operation ID is not in the
     * array, getOperation should return undefined.
     *
     * Validates: Requirements 3.3, 3.4
     */

    test('getOperation returns the same descriptor found in getOperations for existing operations', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...saasTypes).chain((saasType) => {
            const operations = getOperations(saasType);
            return fc.record({
              saasType: fc.constant(saasType),
              operation: fc.constantFrom(...operations),
            });
          }),
          ({ saasType, operation }) => {
            const result = getOperation(saasType, operation.operationId);

            // getOperation must return the exact same descriptor
            expect(result).toBeDefined();
            expect(result).toEqual(operation);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('getOperation returns undefined for non-existent operation IDs', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...saasTypes),
          fc.string({ minLength: 1 }).filter((s) => !s.includes(' ')),
          (saasType, randomId) => {
            const operations = getOperations(saasType);
            const existingIds = operations.map((op) => op.operationId);

            // Only test with IDs that don't exist in the registry
            fc.pre(!existingIds.includes(randomId));

            const result = getOperation(saasType, randomId);
            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: tool-integration-binding, Property 7: Operations Registry Returns Empty for Unknown Types
  describe('Property 7: Operations Registry Returns Empty for Unknown Types', () => {
    /**
     * Property 7: Operations Registry Returns Empty for Unknown Types
     *
     * For any string that is NOT a key in BACKEND_CONNECTOR_REGISTRY (or is an
     * AgentCore type: AWS_LAMBDA, AWS_SMITHY, MCP_SERVER), getOperations(type)
     * should return an empty array without throwing.
     *
     * Validates: Requirements 4.5, 4.6
     */

    const registryKeys = new Set(Object.keys(BACKEND_CONNECTOR_REGISTRY));

    test('getOperations returns empty array for arbitrary unknown type strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }).filter(
            (s) => (!registryKeys.has(s) || AGENTCORE_TYPES.includes(s)) &&
              !Object.prototype.hasOwnProperty.call(Object.prototype, s),
          ),
          (unknownType) => {
            const result = getOperations(unknownType);

            // Must return an array
            expect(Array.isArray(result)).toBe(true);
            // Must be empty
            expect(result).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('getOperations returns empty array specifically for AgentCore types', () => {
      for (const agentCoreType of AGENTCORE_TYPES) {
        const result = getOperations(agentCoreType);

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(0);
      }
    });

    test('getOperations does not throw for any arbitrary string input', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 100 }),
          (arbitraryType) => {
            // Should never throw, regardless of input
            expect(() => getOperations(arbitraryType)).not.toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: tool-integration-binding, Property 8: DataStore Operations Filtering by Type
  describe('Property 8: DataStore Operations Filtering by Type', () => {
    /**
     * Property 8: DataStore Operations Filtering by Type
     *
     * For any data store type, the getDataStoreOperations(type) function should
     * return only operations that are valid for that type (e.g., S3 returns exactly
     * read_object, write_object, list_objects, delete_object; DynamoDB returns exactly
     * get_item, put_item, query, scan, delete_item), and the returned set should
     * never be empty.
     *
     * Validates: Requirements 5.3
     */

    const EXPECTED_OPERATIONS: Record<string, string[]> = {
      S3: ['read_object', 'write_object', 'list_objects', 'delete_object'],
      DYNAMODB: ['get_item', 'put_item', 'query', 'scan', 'delete_item'],
      RDS_POSTGRESQL: ['execute_query', 'list_tables'],
      RDS_MYSQL: ['execute_query', 'list_tables'],
      AURORA_POSTGRESQL: ['execute_query', 'list_tables'],
      AURORA_MYSQL: ['execute_query', 'list_tables'],
      KNOWLEDGE_BASE: ['query_knowledge_base', 'retrieve_documents'],
      REDSHIFT: ['execute_query', 'list_tables'],
      OPENSEARCH: ['search', 'index_document', 'delete_document'],
      NEPTUNE: ['execute_query', 'list_graphs'],
      TIMESTREAM: ['query', 'write_records'],
      DOCUMENTDB: ['find', 'insert', 'update', 'delete'],
      ELASTICACHE_REDIS: ['get', 'set', 'delete', 'scan'],
    };

    const ALL_KNOWN_TYPES = Object.keys(EXPECTED_OPERATIONS);

    test('every known data store type returns non-empty operations matching the expected set', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...ALL_KNOWN_TYPES),
          (dataStoreType: string) => {
            const operations = getDataStoreOperations(dataStoreType);

            // Must return a non-empty array
            expect(Array.isArray(operations)).toBe(true);
            expect(operations.length).toBeGreaterThan(0);

            // Operations must match the expected set exactly (order-independent)
            const expected = EXPECTED_OPERATIONS[dataStoreType];
            expect(operations.slice().sort()).toEqual(expected.slice().sort());
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
