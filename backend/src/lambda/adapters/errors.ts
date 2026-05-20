/**
 * Re-exports from the unified error hierarchy.
 * Kept for backward compatibility with existing imports.
 */
export {
  DataStoreError,
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
  IntegrationError,
} from '../../adapters/errors';
