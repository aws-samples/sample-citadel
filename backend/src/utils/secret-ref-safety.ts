/**
 * Secret-reference safety helper for validating that a caller-supplied
 * Secrets Manager reference stays within the caller's own org namespace.
 *
 * Design: CIT-254 SH-3. Accepts the naming convention used by
 * {@link storeAgentInvocationSecret} (`/citadel/agents/{orgId}/{secretId}`)
 * and {@link storeCredentials} (`/citadel/integrations/{orgId}/…`), as well
 * as full Secrets Manager ARNs whose name segment follows those conventions.
 *
 * Every refusal throws an identical opaque error — no oracle.
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

const OPAQUE_MESSAGE = "Access denied";

export class SecretRefRejectedError extends Error {
  constructor() {
    super(OPAQUE_MESSAGE);
    this.name = "SecretRefRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional type constraint for the secret reference. */
export interface SecretRefOptions {
  /** If provided, the second path segment must match (e.g. `'agents'`, `'integrations'`). */
  type?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CITADEL_PREFIX = "/citadel/";

/**
 * Secrets Manager ARN prefix. The name is after the last colon in the resource
 * segment: `arn:aws:secretsmanager:{region}:{account}:secret:{name}[-random]`.
 */
const SM_ARN_PREFIX = "arn:aws:secretsmanager:";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assert that a secret reference belongs to the caller's own org namespace.
 *
 * Accepted shapes:
 *   - Path-style: `/citadel/{type}/{orgId}/{resourceId}`
 *   - ARN-style:  `arn:aws:secretsmanager:…:secret:/citadel/{type}/{orgId}/{resourceId}-RandomSuffix`
 *
 * @throws {SecretRefRejectedError} if the reference does not match the caller's org.
 */
export function assertSecretRefInOrgNamespace(
  ref: string,
  callerOrg: string,
  opts: SecretRefOptions = {},
): void {
  if (typeof ref !== "string" || !ref) throw new SecretRefRejectedError();
  if (typeof callerOrg !== "string" || !callerOrg)
    throw new SecretRefRejectedError();

  // Reject refs with whitespace or control characters — no trimming, just refuse.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(ref)) throw new SecretRefRejectedError();

  // Reject path traversal: ".." anywhere in the ref.
  if (ref.includes("..")) throw new SecretRefRejectedError();

  if (ref.startsWith(CITADEL_PREFIX)) {
    assertPathStyleRef(ref, callerOrg, opts);
  } else if (ref.startsWith(SM_ARN_PREFIX)) {
    assertArnStyleRef(ref, callerOrg, opts);
  } else {
    throw new SecretRefRejectedError();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse `/citadel/{type}/{orgId}/{resourceId}` and assert org ownership.
 */
function assertPathStyleRef(
  ref: string,
  callerOrg: string,
  opts: SecretRefOptions,
): void {
  // After stripping the leading `/citadel/` we expect: `{type}/{orgId}/{resourceId}`
  const remainder = ref.slice(CITADEL_PREFIX.length);
  const parts = remainder.split("/");
  // Need at least 3 parts: type, orgId, resourceId (resourceId may contain slashes)
  if (parts.length < 3) throw new SecretRefRejectedError();

  const [type, orgId] = parts;
  if (!type || !orgId) throw new SecretRefRejectedError();

  // Type constraint
  if (opts.type && type !== opts.type) throw new SecretRefRejectedError();

  // Org ownership
  if (orgId !== callerOrg) throw new SecretRefRejectedError();
}

/**
 * Parse the name segment out of a Secrets Manager ARN and delegate to the
 * path-style check.
 *
 * ARN format: `arn:aws:secretsmanager:{region}:{account}:secret:{name}[-random]`
 * The name always starts with `/citadel/…`; the `-random` suffix (6 chars
 * appended by Secrets Manager) must be stripped first.
 */
function assertArnStyleRef(
  ref: string,
  callerOrg: string,
  opts: SecretRefOptions,
): void {
  // Split by ':' — standard ARN has 6 colon-delimited fields:
  // arn:partition:service:region:account:resource
  // For Secrets Manager: resource = `secret:{name}[-random]`
  // But `name` can contain colons, so we split and reassemble.
  const colonParts = ref.split(":");
  if (colonParts.length < 7) throw new SecretRefRejectedError();

  // colonParts[5] should be 'secret', colonParts[6..] is the name (may contain colons)
  if (colonParts[5] !== "secret") throw new SecretRefRejectedError();

  const nameWithRandom = colonParts.slice(6).join(":");
  if (!nameWithRandom) throw new SecretRefRejectedError();

  // The name may include a random suffix appended by Secrets Manager: `-AbCdEf`
  // (6 alphanum chars after the last hyphen). We accept BOTH the full ARN name
  // (with suffix) and the bare name. The /citadel/ check is on the name prefix,
  // so the suffix doesn't affect the org check — we just need to confirm the
  // name starts with `/citadel/`.
  if (!nameWithRandom.startsWith("/citadel/"))
    throw new SecretRefRejectedError();

  // Delegate to path-style check (the random suffix after the last `/` segment
  // is harmless — it becomes part of the resourceId).
  assertPathStyleRef(nameWithRandom, callerOrg, opts);
}
