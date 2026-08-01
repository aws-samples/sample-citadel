/**
 * Replay-package sanitisation pipeline (CIT-026 design §1c/§1d).
 *
 * `sanitizeBundle` deep-walks the assembled replay bundle and redacts PII
 * (redact-pii.ts) then secrets (secret-patterns.ts) from every STRING
 * value at every nesting depth — objects, arrays, and JSON-encoded-string
 * fields (parse -> redact -> reserialize, when a field parses as JSON).
 * Object/array KEYS are left intact — they carry schema meaning, not
 * payload.
 *
 * `assertBundleSecretFree` is the FAIL-CLOSED gate: it independently
 * re-serializes and re-scans the WHOLE bundle (never trusting
 * sanitizeBundle's return value alone) and THROWS ReplaySecretLeakError on
 * any hit. Callers (replay-package-handler.ts) MUST catch this and refuse
 * to write to S3 or return a presigned URL — publication is impossible on
 * a hit. This is deliberately a second, independent scan: if a caller
 * calls the gate directly on an unsanitized bundle, it still catches the
 * leak (see replay-gate.test.ts leg (a)); if redaction itself regresses to
 * a no-op, the gate still throws (leg (b), the mutation-kill proof) because
 * it re-scans the actual serialized output rather than assuming
 * sanitizeBundle succeeded.
 */
import { redactPII } from "../../utils/redact-pii";
import { redactSecrets, scanForSecrets } from "../../utils/secret-patterns";

/** Thrown by assertBundleSecretFree when the serialized bundle still
 * contains a secret-pattern match after sanitisation. Callers must treat
 * this as fail-closed: no S3 write, no presigned URL, ever. */
export class ReplaySecretLeakError extends Error {
  public readonly patternIds: string[];

  constructor(patternIds: string[]) {
    super(
      `Replay package failed the secret-free gate — ${patternIds.length} pattern(s) fired: ${patternIds.join(", ")}`,
    );
    this.name = "ReplaySecretLeakError";
    this.patternIds = patternIds;
  }
}

/** Redacts PII then secrets from a single string. Order mirrors
 * redact-pii.ts's own internal ordering discipline (most-specific /
 * prefix-anchored patterns first) — PII first, then the broader secret
 * pattern set, so a value matching both (unlikely but possible) redacts
 * cleanly either way. */
function redactString(value: string): string {
  return redactSecrets(redactPII(value));
}

/** True iff `value` parses as a JSON object or array (not a bare
 * scalar) — used to decide whether a string field should be
 * parsed -> redacted -> reserialized rather than redacted as opaque text.
 * A string that merely looks like JSON but is a bare number/boolean/string
 * literal is treated as opaque text instead, since there is nothing
 * structural to preserve. */
function tryParseJsonContainer(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Deep-walks `node`, redacting every string value (including
 * JSON-encoded-string fields, recursively) at every depth. Object/array
 * keys are never modified. Deterministic and idempotent:
 * sanitizeBundle(sanitizeBundle(x)) deep-equals sanitizeBundle(x), because
 * redactString/redactPII/redactSecrets are each individually idempotent by
 * their `[REDACTED:<type>]` sentinel convention.
 */
export function sanitizeBundle(node: unknown): unknown {
  if (typeof node === "string") {
    const parsed = tryParseJsonContainer(node);
    if (parsed !== undefined) {
      // JSON-encoded-string field: parse, redact recursively, reserialize —
      // preserves the field's JSON-string shape for downstream consumers
      // that expect to JSON.parse() it again.
      return JSON.stringify(sanitizeBundle(parsed));
    }
    return redactString(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => sanitizeBundle(item));
  }

  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      out[key] = sanitizeBundle(value);
    }
    return out;
  }

  // number | boolean | null | undefined — pass through unchanged.
  return node;
}

/**
 * FAIL-CLOSED gate. Serializes the whole bundle and re-scans it for any
 * secret pattern. Throws ReplaySecretLeakError on any hit; the caller must
 * treat that as "do not publish" (no S3 write, no presigned URL — see
 * replay-package-handler.ts). Never mutates or redacts — this function's
 * only job is to detect and refuse, not to fix.
 */
export function assertBundleSecretFree(bundle: unknown): void {
  const serialized = JSON.stringify(bundle);
  const hits = scanForSecrets(serialized);
  if (hits.length > 0) {
    throw new ReplaySecretLeakError(hits);
  }
}
