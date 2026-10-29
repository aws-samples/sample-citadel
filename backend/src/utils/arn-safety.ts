/**
 * ARN safety helpers for validating caller-supplied AWS resource references.
 *
 * Design: CIT-254 SH-1. Every refusal throws {@link ArnRejectedError} with an
 * identical opaque message so callers cannot distinguish "wrong service" from
 * "wrong account" — no information oracle.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed components of a valid ARN. */
export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  resource: string;
}

/** Options for {@link assertSameAccountArn}. */
export interface SameAccountArnOptions {
  /** The platform's own AWS account id (from STS GetCallerIdentity). */
  platformAccountId: string;
  /** Services the ARN's `service` field must match (e.g. `['lambda', 'iam']`). */
  allowedServices: string[];
}

/** Options for {@link assertCrossAccountRole}. */
export interface CrossAccountRoleOptions {
  /** The platform's own AWS account id — the role MUST belong to a DIFFERENT account. */
  platformAccountId: string;
  /** Required external-id for the cross-account assumption. */
  externalId: string;
}

/** Result of a successful {@link assertCrossAccountRole} call. */
export interface CrossAccountRoleResult {
  parsed: ParsedArn;
  externalId: string;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

const OPAQUE_MESSAGE = "Invalid resource reference";

export class ArnRejectedError extends Error {
  constructor() {
    super(OPAQUE_MESSAGE);
    this.name = "ArnRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strict six-part ARN regex accepting the three commercial partitions.
 *
 * Format: `arn:<partition>:<service>:<region>:<account>:<resource>`
 * - partition: `aws`, `aws-cn`, or `aws-us-gov`
 * - service:   lowercase alpha-numeric + hyphens
 * - region:    lowercase alpha-numeric + hyphens (may be empty for global services like IAM)
 * - account:   exactly 12 digits
 * - resource:  one or more non-empty characters
 */
const ARN_RE =
  /^arn:(aws|aws-cn|aws-us-gov):([a-z0-9-]+):([a-z0-9-]*):(\d{12}):(.+)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an ARN string into its six structural parts.
 *
 * @throws {ArnRejectedError} if the string does not match the strict format.
 */
export function parseArn(arn: string): ParsedArn {
  if (typeof arn !== "string") throw new ArnRejectedError();
  const m = ARN_RE.exec(arn);
  if (!m) throw new ArnRejectedError();
  return {
    partition: m[1],
    service: m[2],
    region: m[3],
    accountId: m[4],
    resource: m[5],
  };
}

/**
 * Assert an ARN belongs to the platform's own account and an allowed service.
 *
 * @returns the parsed ARN on success.
 * @throws {ArnRejectedError} on any mismatch.
 */
export function assertSameAccountArn(
  arn: string,
  opts: SameAccountArnOptions,
): ParsedArn {
  const parsed = parseArn(arn); // throws on malformed
  if (!opts.allowedServices.includes(parsed.service))
    throw new ArnRejectedError();
  if (parsed.accountId !== opts.platformAccountId) throw new ArnRejectedError();
  return parsed;
}

/**
 * Assert an ARN is a cross-account IAM role, requiring an external-id and
 * that the account differs from the platform's own.
 *
 * @returns a typed result containing the parsed ARN and the external-id.
 * @throws {ArnRejectedError} if the ARN is malformed, belongs to the platform
 *   account, is not an IAM role, or the external-id is missing/empty.
 */
export function assertCrossAccountRole(
  arn: string,
  opts: CrossAccountRoleOptions,
): CrossAccountRoleResult {
  const parsed = parseArn(arn); // throws on malformed
  if (parsed.service !== "iam") throw new ArnRejectedError();
  if (!parsed.resource.startsWith("role/")) throw new ArnRejectedError();
  if (parsed.accountId === opts.platformAccountId) throw new ArnRejectedError();
  if (!opts.externalId) throw new ArnRejectedError();
  return { parsed, externalId: opts.externalId };
}
