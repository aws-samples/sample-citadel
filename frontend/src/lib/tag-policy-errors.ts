/**
 * Tag-policy error parsing utilities.
 *
 * The backend throws `TagPolicyViolationError` which surfaces as a GraphQL
 * error whose `.message` starts with `"tag_policy_violation:"`. The frontend's
 * `server.ts` joins error messages and discards `errorType`, so we detect the
 * error by matching the message prefix — the same approach used for
 * `RecordNotApprovedError` (`"approval_absent:"`).
 */

/** Mirrors backend `TagViolation` (tag-policy.ts). */
export interface TagViolation {
  type: 'MISSING_KEY' | 'INVALID_VALUE';
  key: string;
  suppliedValue?: string;
  allowedValues?: string[];
}

/** The backend `TagPolicyAction` enum values that govern enforcement mode. */
export type TagPolicyAction = 'ENFORCE' | 'WARN';

export interface TagPolicyViolationResult {
  violations: TagViolation[];
  action: TagPolicyAction;
}

const TAG_POLICY_PREFIX = 'tag_policy_violation:';

/**
 * Attempt to parse a tag-policy violation from an error thrown by a GraphQL
 * mutation.  Returns `null` when the error is unrelated to tag policy.
 *
 * Detection: the joined error message starts with (or contains)
 * `"tag_policy_violation:"` followed by a human-readable summary.  We parse
 * the structured parts out of the message text since `server.ts` discards the
 * original error extensions.
 *
 * Message format from backend:
 *   `tag_policy_violation: missing required keys: env; invalid values for keys: team`
 */
export function parseTagPolicyViolation(
  err: unknown,
): TagPolicyViolationResult | null {
  const message = extractMessage(err);
  if (!message) return null;

  // The joined message may contain multiple error messages separated by ", ".
  // Find the segment that carries the tag-policy prefix.
  const segment = findSegment(message);
  if (!segment) return null;

  const body = segment.slice(TAG_POLICY_PREFIX.length).trim();

  const violations: TagViolation[] = [];

  // Parse "missing required keys: a, b"
  const missingMatch = body.match(/missing required keys?:\s*([^;]+)/i);
  if (missingMatch) {
    const keys = missingMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
    for (const key of keys) {
      violations.push({ type: 'MISSING_KEY', key });
    }
  }

  // Parse "invalid values for keys: a, b"
  const invalidMatch = body.match(/invalid values? for keys?:\s*([^;]+)/i);
  if (invalidMatch) {
    const keys = invalidMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
    for (const key of keys) {
      violations.push({ type: 'INVALID_VALUE', key });
    }
  }

  if (violations.length === 0) {
    // The prefix matched but we couldn't extract structured violations.
    // Return a generic violation so callers know it IS a tag-policy error.
    violations.push({ type: 'MISSING_KEY', key: 'unknown' });
  }

  // Default action — the backend currently enforces; when WARN mode is
  // supported the message format will carry the action explicitly.
  const action: TagPolicyAction = body.toLowerCase().includes('warn')
    ? 'WARN'
    : 'ENFORCE';

  return { violations, action };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function extractMessage(err: unknown): string | null {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return null;
}

function findSegment(message: string): string | null {
  // Fast path: the whole message starts with the prefix.
  if (message.startsWith(TAG_POLICY_PREFIX)) return message;

  // Slow path: server.ts joins multiple error messages with ", ".
  const segments = message.split(', ');
  for (const seg of segments) {
    if (seg.startsWith(TAG_POLICY_PREFIX)) return seg;
  }

  // Fallback: substring match (the prefix might appear after other text).
  const idx = message.indexOf(TAG_POLICY_PREFIX);
  if (idx >= 0) return message.slice(idx);

  return null;
}
