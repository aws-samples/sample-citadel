/**
 * Pure tag-policy types and validators — no I/O, no side effects.
 *
 * CIT-042 PR1: data model + shape validation for organisation tag policies.
 * Enforcement (enforceTagPolicy, governance-mode gating) lives in PR2.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface TagPolicyRule {
  key: string;
  allowedValues?: string[];
}

export interface TagPolicy {
  requiredKeys: TagPolicyRule[];
  version: number;
  updatedBy: string;
  updatedAt: string;
}

// ─── Shape validation (input sanitisation, unconditional) ───────────────

/** Maximum number of required keys in a tag policy. */
const MAX_REQUIRED_KEYS = 10;
/** Maximum length of a tag key. */
const MAX_KEY_LENGTH = 64;
/** Maximum length of each allowed value. */
const MAX_VALUE_LENGTH = 256;

export interface TagPolicyShapeError {
  message: string;
}

/**
 * Validates the structural constraints of a tag policy input:
 *  - ≤10 required keys
 *  - each key 1–64 chars
 *  - each allowedValues entry ≤256 chars
 *  - no duplicate keys
 *
 * Returns null when valid, or a TagPolicyShapeError describing the first
 * violation found.
 */
export function validateTagPolicyShape(
  requiredKeys: TagPolicyRule[],
): TagPolicyShapeError | null {
  if (requiredKeys.length > MAX_REQUIRED_KEYS) {
    return {
      message: `Tag policy must have at most ${MAX_REQUIRED_KEYS} required keys, got ${requiredKeys.length}`,
    };
  }

  const seenKeys = new Set<string>();
  for (const rule of requiredKeys) {
    if (!rule.key || rule.key.length > MAX_KEY_LENGTH) {
      return {
        message: `Tag key must be 1–${MAX_KEY_LENGTH} characters, got length ${rule.key?.length ?? 0}`,
      };
    }
    if (seenKeys.has(rule.key)) {
      return { message: `Duplicate tag key: "${rule.key}"` };
    }
    seenKeys.add(rule.key);

    if (rule.allowedValues) {
      for (const v of rule.allowedValues) {
        if (v.length > MAX_VALUE_LENGTH) {
          return {
            message: `Allowed value for key "${rule.key}" must be at most ${MAX_VALUE_LENGTH} characters, got length ${v.length}`,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Normalises a tag policy input into the canonical storage form:
 *  - Trims whitespace from keys
 *  - Deduplicates allowedValues per rule (preserving order, first occurrence wins)
 *  - Removes undefined/null allowedValues entries
 */
export function normaliseTagPolicy(
  requiredKeys: TagPolicyRule[],
): TagPolicyRule[] {
  return requiredKeys.map((rule) => {
    const trimmedKey = rule.key.trim();
    if (!rule.allowedValues || rule.allowedValues.length === 0) {
      return { key: trimmedKey };
    }
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const v of rule.allowedValues) {
      if (!seen.has(v)) {
        seen.add(v);
        deduped.push(v);
      }
    }
    return { key: trimmedKey, allowedValues: deduped };
  });
}
