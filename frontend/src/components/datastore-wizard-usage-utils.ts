/**
 * Utility functions for usage-aware operation filtering in the DataStoreToolWizard.
 *
 * Extracts the operation filtering logic into pure, testable functions
 * that can be validated independently of React component rendering.
 *
 * @module datastore-wizard-usage-utils
 */

// --- Data Store Operations Mapping (mirrors operations-registry.ts) ---

const DATASTORE_OPERATIONS: Record<string, string[]> = {
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

const GENERIC_OPERATIONS = ['read', 'write'];

/**
 * Returns the full list of operation IDs available for a given data store type.
 * Falls back to generic read/write for unknown types.
 */
export function getDataStoreOperationsForType(dataStoreType: string): string[] {
  return DATASTORE_OPERATIONS[dataStoreType] || GENERIC_OPERATIONS;
}

/**
 * Read-only operations by data store type.
 * When a data store has usage `knowledge`, only these operations are
 * available by default (write operations are excluded).
 *
 * Types not listed here fall back to the generic `['read']` subset.
 */
export const READ_ONLY_OPERATIONS: Record<string, string[]> = {
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

const GENERIC_READ_ONLY = ['read'];

/**
 * Returns the available operations for a data store type based on its usage classification.
 *
 * - `knowledge`: returns only the read-only subset for the type
 * - `operational` or `both`: returns the full CRUD set with no restrictions
 *
 * @param dataStoreType - The data store type (e.g., 'S3', 'DYNAMODB')
 * @param usage - The usage classification ('knowledge', 'operational', 'both')
 * @returns Array of available operation IDs
 */
export function getAvailableOperationsForUsage(
  dataStoreType: string,
  usage: 'knowledge' | 'operational' | 'both',
): string[] {
  const fullOps = getDataStoreOperationsForType(dataStoreType);

  if (usage === 'knowledge') {
    return READ_ONLY_OPERATIONS[dataStoreType] ?? GENERIC_READ_ONLY;
  }

  // operational or both — full CRUD set
  return fullOps;
}

/**
 * Checks whether an operation is a write operation for a knowledge store.
 * Used to display warnings when users manually select write ops on knowledge stores.
 *
 * @param dataStoreType - The data store type
 * @param operationId - The operation to check
 * @returns true if the operation is NOT in the read-only set for this type
 */
export function isWriteOperationForKnowledgeStore(
  dataStoreType: string,
  operationId: string,
): boolean {
  const readOnlyOps = READ_ONLY_OPERATIONS[dataStoreType] ?? GENERIC_READ_ONLY;
  return !readOnlyOps.includes(operationId);
}
