/**
 * Shared credential enforcement for adapter data-plane operations.
 *
 * Every adapter's `makeClient` delegates here to guarantee that data-plane
 * paths (connect, testConnection, query, disconnect, getMetrics) never fall
 * back to the Lambda execution role's ambient credentials.
 */
import { CredentialMissingError } from "../../adapters/errors";
import type { AwsCredentialFields } from "./sdk-types";

/**
 * Validates that scoped STS credentials are present and returns them in the
 * shape expected by AWS SDK v3 client constructors.
 *
 * @throws CredentialMissingError when credentials are absent or incomplete.
 *   The error emits a structured CloudWatch metric line with the adapter
 *   name and operation for operational alerting.
 */
export function requireScopedCredentials(
  creds: Record<string, unknown> | undefined,
  context: { adapter: string; op: string },
): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  const c = creds as AwsCredentialFields | undefined;
  if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    };
  }
  throw new CredentialMissingError(context.adapter, context.op);
}
