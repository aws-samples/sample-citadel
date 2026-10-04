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

// ─── Tag format validation (per-record, unconditional) ──────────────────

/**
 * Distinct error codes for tag format violations.
 * Consumers can switch on `code` for programmatic handling.
 */
export type TagFormatErrorCode =
  "TOO_MANY_KEYS" | "KEY_TOO_LONG" | "VALUE_TOO_LONG" | "INVALID_TYPE";

export class TagFormatError extends Error {
  readonly code: TagFormatErrorCode;
  constructor(code: TagFormatErrorCode, message: string) {
    super(message);
    this.name = "TagFormatError";
    this.code = code;
  }
}

/** Maximum number of tags on a single record. */
const MAX_TAG_KEYS = 10;
/** Maximum length of a tag key. */
const MAX_TAG_KEY_LENGTH = 64;
/** Maximum length of a tag value. */
const MAX_TAG_VALUE_LENGTH = 256;

/**
 * Validates and normalises a raw `tags` input (typically parsed from AWSJSON)
 * into a typed `Record<string, string>`.
 *
 * FORMAT limits enforced unconditionally (decision ad393b11):
 *  - ≤10 keys
 *  - each key ≤64 chars
 *  - each value ≤256 chars
 *  - all values must be strings
 *
 * Throws {@link TagFormatError} with a distinct code on any violation.
 */
export function normaliseTags(input: unknown): Record<string, string> {
  if (input === null || input === undefined) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TagFormatError(
      "INVALID_TYPE",
      "Tags must be a JSON object (Record<string, string>)",
    );
  }

  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);

  if (keys.length > MAX_TAG_KEYS) {
    throw new TagFormatError(
      "TOO_MANY_KEYS",
      `Tags must have at most ${MAX_TAG_KEYS} keys, got ${keys.length}`,
    );
  }

  const result: Record<string, string> = {};
  for (const key of keys) {
    if (key.length > MAX_TAG_KEY_LENGTH) {
      throw new TagFormatError(
        "KEY_TOO_LONG",
        `Tag key must be at most ${MAX_TAG_KEY_LENGTH} characters, got length ${key.length}`,
      );
    }
    const value = raw[key];
    if (typeof value !== "string") {
      throw new TagFormatError(
        "INVALID_TYPE",
        `Tag value for key "${key}" must be a string, got ${typeof value}`,
      );
    }
    if (value.length > MAX_TAG_VALUE_LENGTH) {
      throw new TagFormatError(
        "VALUE_TOO_LONG",
        `Tag value for key "${key}" must be at most ${MAX_TAG_VALUE_LENGTH} characters, got length ${value.length}`,
      );
    }
    result[key] = value;
  }

  return result;
}

// ─── Policy enforcement validation (pure, no I/O) ──────────────────────

export type TagViolationType = "MISSING_KEY" | "INVALID_VALUE";

export interface TagViolation {
  type: TagViolationType;
  key: string;
  /** The value that was supplied (present only for INVALID_VALUE). */
  suppliedValue?: string;
  /** The allowed values for this key (present only for INVALID_VALUE). */
  allowedValues?: string[];
}

export interface TagValidationResult {
  ok: boolean;
  violations: TagViolation[];
}

/**
 * Validates a set of tags against an organisation's tag policy.
 *
 * Pure function — no I/O, no side effects.
 *
 * - `policy` is null when the organisation has no tag policy configured.
 *   A null policy always returns `{ ok: true, violations: [] }`.
 * - `tags` is undefined/null when the caller did not supply tags (e.g.
 *   an update mutation that omits the field). Treated as an empty record.
 *
 * For each rule in `policy.requiredKeys`:
 *   - MISSING_KEY: the key is absent in `tags`.
 *   - INVALID_VALUE: the key is present but its value is not in the rule's
 *     `allowedValues` (when defined; if `allowedValues` is absent or empty,
 *     any value is accepted).
 */
export function validateTagsAgainstPolicy(
  policy: TagPolicy | null,
  tags: Record<string, string> | undefined | null,
): TagValidationResult {
  if (policy === null) {
    return { ok: true, violations: [] };
  }

  const effectiveTags: Record<string, string> = tags ?? {};
  const violations: TagViolation[] = [];

  for (const rule of policy.requiredKeys) {
    const key = rule.key;

    if (!(key in effectiveTags)) {
      violations.push({ type: "MISSING_KEY", key });
      continue;
    }

    if (
      rule.allowedValues &&
      rule.allowedValues.length > 0 &&
      !rule.allowedValues.includes(effectiveTags[key])
    ) {
      violations.push({
        type: "INVALID_VALUE",
        key,
        suppliedValue: effectiveTags[key],
        allowedValues: rule.allowedValues,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
