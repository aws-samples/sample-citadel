/**
 * Unified Error Hierarchy
 *
 * Single base class ConnectorError. DataStoreError is a simple alias.
 * All subclasses extend ConnectorError directly.
 */

export class ConnectorError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly cause?: Error;

  constructor(message: string, code: string, retryable: boolean, cause?: Error) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** Backward-compatible alias — DataStoreError IS ConnectorError */
export const DataStoreError = ConnectorError;

export class ProvisioningError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'PROVISIONING_ERROR', false, cause);
    this.name = 'ProvisioningError';
  }
}

export class ConnectionError extends ConnectorError {
  constructor(message: string, retryable = true, cause?: Error) {
    super(message, 'CONNECTION_ERROR', retryable, cause);
    this.name = 'ConnectionError';
  }
}

export class PermissionError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'PERMISSION_ERROR', false, cause);
    this.name = 'PermissionError';
  }
}

export class ResourceNotFoundError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'RESOURCE_NOT_FOUND', false, cause);
    this.name = 'ResourceNotFoundError';
  }
}

export class ConflictError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFLICT', true, cause);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ConnectorError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', false);
    this.name = 'ValidationError';
  }
}

/** Integration-specific error for gateway/external service failures */
export class IntegrationError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, 'INTEGRATION_ERROR', true, cause);
    this.name = 'IntegrationError';
  }
}

/**
 * Thrown when an adapter method is invoked on a fallback or unimplemented
 * connector type. Used by `BaseIntegrationAdapter` and `AwsGenericAdapter`
 * to refuse silent-success behavior — better to fail loudly than mask
 * integration failures across BACKEND_CONNECTOR_REGISTRY.
 *
 * Migration path: subclasses (e.g. ConfluenceAdapter, S3Adapter) override
 * the relevant method with a real implementation. Unimplemented connector
 * types throw at runtime so the missing implementation is unmistakable.
 *
 * Intentionally extends Error directly (not ConnectorError) — this is a
 * programmer/configuration fault, not a runtime connector fault, and it
 * should not be retryable or carry a domain code.
 */
export class NotImplementedError extends Error {
  constructor(adapter: string, method: string) {
    super(
      `${adapter}.${method} is not implemented. ` +
        `The connector type lacks a real implementation; refusing to fake success.`,
    );
    this.name = 'NotImplementedError';
  }
}
