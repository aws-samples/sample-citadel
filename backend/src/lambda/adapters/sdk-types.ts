/**
 * Shared structural types for adapter implementations.
 *
 * Type-only module: these interfaces narrow `unknown` values (caught SDK
 * errors, credential records) for type-safe access. No runtime behavior.
 */

/** Structural shape of errors thrown by AWS SDK v3 clients and driver SDKs. */
export interface SdkError extends Error {
  /** Driver-specific error code (e.g. Snowflake auth failure codes). */
  code?: string;
  /** AWS SDK v3 response metadata. */
  $metadata?: { httpStatusCode?: number };
}

/** Optional STS credential fields carried in adapter `credentials` records. */
export interface AwsCredentialFields {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}
