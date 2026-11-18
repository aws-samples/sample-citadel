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
 * H4: non-forgeable provenance marker for platform-minted scoped
 * credentials. A WeakSet membership check cannot be satisfied by a
 * caller-supplied object — `input.credentials` arrives over the wire as a
 * JSON string and is `JSON.parse`'d into a fresh plain object that was
 * never (and can never be) registered here, regardless of its field
 * values. Only `markScopedCredentials` can add an object to this set, and
 * it is called from exactly one production site:
 * `PolicyManager.assumeScopedRole`.
 */
const SCOPED = new WeakSet<object>();

/**
 * Mark an object as platform-minted scoped credentials. Called ONLY by the
 * PolicyManager STS path (`assumeScopedRole`). Returns the same reference
 * so it can be used inline in a `return markScopedCredentials({...})`.
 */
export function markScopedCredentials<T extends object>(credentials: T): T {
  SCOPED.add(credentials);
  return credentials;
}

/** True if `value` is an object previously marked by `markScopedCredentials`. */
export function isScopedCredentials(value: unknown): boolean {
  return typeof value === "object" && value !== null && SCOPED.has(value);
}

/**
 * Validates that scoped STS credentials are present and returns them in the
 * shape expected by AWS SDK v3 client constructors.
 *
 * H4: in addition to the field-presence check, the credentials object MUST
 * carry the non-forgeable provenance marker set by
 * `PolicyManager.assumeScopedRole` — a well-formed-but-unmarked object
 * (e.g. the caller-supplied `input.credentials`, JSON.parse'd from the
 * wire) is rejected even though it has the right fields.
 *
 * @throws CredentialMissingError when credentials are absent, incomplete,
 *   or unmarked. The error emits a structured CloudWatch metric line with
 *   the adapter name and operation for operational alerting.
 */
export function requireScopedCredentials(
  creds: Record<string, unknown> | undefined,
  context: { adapter: string; op: string },
): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  const c = creds as AwsCredentialFields | undefined;
  if (
    c?.accessKeyId &&
    c?.secretAccessKey &&
    c?.sessionToken &&
    isScopedCredentials(creds)
  ) {
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    };
  }
  throw new CredentialMissingError(context.adapter, context.op);
}
