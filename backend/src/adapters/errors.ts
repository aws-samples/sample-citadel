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

  constructor(
    message: string,
    code: string,
    retryable: boolean,
    cause?: Error,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/** Backward-compatible alias — DataStoreError IS ConnectorError */
export const DataStoreError = ConnectorError;

export class ProvisioningError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, "PROVISIONING_ERROR", false, cause);
    this.name = "ProvisioningError";
  }
}

export class ConnectionError extends ConnectorError {
  constructor(message: string, retryable = true, cause?: Error) {
    super(message, "CONNECTION_ERROR", retryable, cause);
    this.name = "ConnectionError";
  }
}

export class PermissionError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, "PERMISSION_ERROR", false, cause);
    this.name = "PermissionError";
  }
}

export class ResourceNotFoundError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, "RESOURCE_NOT_FOUND", false, cause);
    this.name = "ResourceNotFoundError";
  }
}

export class ConflictError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, "CONFLICT", true, cause);
    this.name = "ConflictError";
  }
}

export class ValidationError extends ConnectorError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", false);
    this.name = "ValidationError";
  }
}

/** Integration-specific error for gateway/external service failures */
export class IntegrationError extends ConnectorError {
  constructor(message: string, cause?: Error) {
    super(message, "INTEGRATION_ERROR", true, cause);
    this.name = "IntegrationError";
  }
}

/**
 * Thrown when a data-plane adapter operation is invoked without the scoped
 * `citadel-ds-{id}` credentials that the datastore-resolver is supposed to
 * vend.  Adapters must NEVER fall back to the Lambda execution role's
 * ambient credentials for data-plane work (connect, test, query, disconnect,
 * getMetrics).  Control-plane provisioning paths that legitimately use the
 * platform role call `platformClient()` instead, making the intent explicit.
 *
 * The error message is intentionally opaque to callers — it does not leak
 * the adapter type or operation to the GraphQL response.
 */
export class CredentialMissingError extends ConnectorError {
  constructor(adapter: string, operation: string) {
    // Opaque message for callers; adapter+op logged via structured metric below
    super(
      "Scoped credentials are required for this operation",
      "CREDENTIAL_MISSING",
      false,
    );
    this.name = "CredentialMissingError";
    // Structured log line consumed by a CloudWatch metric filter:
    // Namespace: Citadel/Adapters, Metric: CredentialMissing, Dimensions: {adapter, op}
    console.error(
      JSON.stringify({
        level: "error",
        metric: "CredentialMissing",
        adapter,
        op: operation,
      }),
    );
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
    this.name = "NotImplementedError";
  }
}
