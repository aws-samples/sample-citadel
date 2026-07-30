/**
 * Secret-pattern detection utility (CIT-026 design §1a/§1b).
 *
 * HONEST GAP this module fills: `redact-pii.ts` covers PII only (email,
 * phone, AWS account id, AWS access-key id, credit card). There was no
 * general credential/secret scanner in `backend/src/utils` before this —
 * CIT-092 ("Secret-pattern preflight") lists one as ABSENT/planned, and
 * CIT-142 says it will reuse CIT-092's patterns. This module IS that
 * scanner, and becomes the single source of truth CIT-092/CIT-142 later
 * import — build once, cite thrice. Do not fork a second copy of this
 * pattern set anywhere else in the codebase.
 *
 * Mirrors the sibling `redact-pii.ts` / `sanitize-agent-output.ts`
 * conventions:
 *  - `scanForSecrets` reports stable, log-safe pattern IDENTIFIERS, never
 *    the raw matched text (so callers can log/alert on which classes fired
 *    without echoing the secret itself).
 *  - `redactSecrets` replaces each match with a `[REDACTED:<id>]` sentinel.
 *    The sentinel contains no re-triggerable token for any pattern below,
 *    so redaction is IDEMPOTENT: redactSecrets(redactSecrets(x)) ===
 *    redactSecrets(x).
 *  - Global, case-insensitive-where-appropriate regexes, applied via
 *    String.prototype.replace/matchAll (which reset lastIndex per call), so
 *    the module-level regex objects are safe to reuse across calls.
 *
 * Per the practices "Validate regex changes against RegExp.test()" lesson:
 * every pattern below has a paired positive + near-miss-negative assertion
 * in secret-patterns.test.ts — a pattern with an anchor that can never
 * actually match real input is worse than no pattern (false confidence).
 */

interface SecretPattern {
  /** Stable, log-safe identifier for this class of secret. */
  readonly id: string;
  /** Global matcher. */
  readonly re: RegExp;
}

// Order matters only for readability here — every pattern below is applied
// independently and matches are non-overlapping in practice given how
// narrowly each is scoped (private-key blocks vs single-line tokens vs
// context-anchored assignments).
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // PEM / SSH private-key blocks — the header line alone is sufficient
  // evidence; we don't need to also match the footer to redact usefully,
  // but anchoring on BEGIN...PRIVATE KEY is unambiguous and low-noise.
  {
    id: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
  },
  // AWS secret access keys are a bare 40-char base64-ish string with no
  // structural marker of their own — matching that shape alone would be a
  // false-positive machine. Context-anchor to nearby aws_secret* / Secret
  // AccessKey identifiers (case-insensitive, key can be quoted JSON or a
  // shell/env assignment) to bound false positives.
  {
    id: "aws-secret-access-key",
    re: /(?:aws_secret(?:_access_key)?|SecretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})["']?/gi,
  },
  {
    id: "bearer-token",
    re: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{8,}=*/g,
  },
  // JWT: three dot-separated base64url segments, header segment starting
  // with the standard `eyJ` ({" prefix base64-encoded).
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    id: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    id: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // Stripe LIVE keys only (sk_live_/rk_live_) — sk_test_/rk_test_ are
  // test-mode keys with no production financial exposure, deliberately
  // excluded to keep the pattern precise to what actually matters.
  {
    id: "stripe-key",
    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  },
  // Generic key=/secret=/password=/token= assignment forms (shell env,
  // YAML/JSON-ish, query-string). Requires a non-trivial value (>=8 chars,
  // no whitespace) so `token=` (empty) or placeholder angle-bracket text
  // like `<your-password-here>` do not fire.
  {
    id: "assignment-secret",
    re: /\b(?:key|secret|password|token|api_key|apikey)\s*[:=]\s*["']?([A-Za-z0-9+/_-]{8,})["']?/gi,
  },
  // DB connection URIs with embedded credentials (proto://user:pass@host).
  // Requires a non-empty user AND password segment — a URI with no
  // credentials (postgres://host:5432/db) must not fire.
  {
    id: "db-uri",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
  },
  // Bounded high-entropy base64/hex run — a STANDALONE class (design §1b),
  // distinct from `assignment-secret`: it fires on the shape alone with no
  // context anchor required, so it catches a bare high-entropy token
  // pasted without a `key=`/`token=` prefix. To avoid "nuking benign IDs"
  // (design's own caveat) it is deliberately narrow:
  //   - length-capped to 32-64 chars (below 32, too many benign identifiers
  //     collide; above 64 is already covered by the more specific classes
  //     above, e.g. private-key blocks, JWTs)
  //   - base64 variant requires BOTH an uppercase and a lowercase letter
  //     and at least one digit, so plain-word runs (all lowercase, no
  //     digits) never match
  //   - hex variant requires the run to be entirely [0-9a-f] and at least
  //     32 chars, which real English text/identifiers essentially never
  //     produce by chance
  // This is a real detection surface, not just a rename of
  // assignment-secret — the near-miss test below (`hello world...`, all
  // lowercase, no digits) proves it does NOT fire on ordinary prose.
  {
    id: "high-entropy-run",
    re: /\b(?=[A-Za-z0-9+/]{32,64}\b)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{32,64}\b|\b[0-9a-f]{32,64}\b/g,
  },
];

/**
 * Scans `text` for every secret class in SECRET_PATTERNS. Returns the
 * unique set of pattern IDs that fired — never the raw matched text, so
 * callers can log/alert without echoing the secret.
 */
export function scanForSecrets(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const { id, re } of SECRET_PATTERNS) {
    // Global regexes carry `lastIndex` state on the shared module-level
    // object between calls. `.test()` on a `g`-flagged regex resumes from
    // wherever the previous call left off, so a stale non-zero lastIndex
    // can cause a real match to be silently skipped. Reset before every
    // use — String.prototype.replace does this internally, but a bare
    // `.test()` call does not.
    re.lastIndex = 0;
    if (re.test(text)) {
      hits.add(id);
    }
  }
  return [...hits];
}

/**
 * Replaces every match of every secret class in `text` with a
 * `[REDACTED:<id>]` sentinel. Idempotent: none of the sentinels can
 * re-trigger any pattern above (no PEM header, no eyJ.eyJ shape, no
 * assignment operator inside the bracketed sentinel text).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { id, re } of SECRET_PATTERNS) {
    // String.prototype.replace on a `g`-flagged regex starts matching from
    // index 0 regardless of a stale lastIndex, but we reset explicitly here
    // anyway so this function's behavior never depends on call ordering
    // relative to scanForSecrets (defensive, matches the lesson above).
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${id}]`);
  }
  return out;
}
