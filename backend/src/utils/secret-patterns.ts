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
  // evidence of a secret. We redact from the BEGIN marker through the
  // matching END marker if present, OR through the rest of the input if
  // the footer is missing (a truncated key block is still a secret that
  // must be redacted — H27). The alternation tries the full BEGIN...END
  // span first (greedy-safe because the END marker is unambiguous), then
  // falls back to BEGIN-to-end-of-input.
  {
    id: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----|[\s\S]*$)/g,
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
  // Generic key=/secret=/password=/token=/api_key=/apikey= assignment forms.
  // H26 fix: the original pattern required `[:=]\s*` directly after a bare
  // identifier, which missed JSON `"api_key": "value"` (quoted key, colon
  // after closing quote). The revised pattern accepts:
  //   - Bare identifier:   key=value, key = "value", key: value (YAML)
  //   - Quoted identifier: "key": "value", 'key': 'value' (JSON, YAML)
  // Requires a non-trivial value (>=8 chars, no whitespace) so `token=`
  // (empty) or placeholder angle-bracket text like `<your-password-here>`
  // do not fire. UUIDs (8-4-4-4-12 with dashes) are excluded via a
  // negative lookahead to avoid false positives on config IDs.
  {
    id: "assignment-secret",
    re: /(?:["']?(?:key|secret|password|token|api_key|apikey)["']?)\s*[:=]\s*["']?(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)([A-Za-z0-9+/_\-.]{8,})["']?/gi,
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
  // pasted without a `key=`/`token=` prefix.
  //
  // TWO-PHASE APPROACH (performance fix):
  // The old implementation used three consecutive lookaheads
  // (`(?=[A-Za-z0-9+/]*[A-Z])(?=...[a-z])(?=...[0-9])`) which caused
  // catastrophic backtracking on dense base64 input (~3800 ms on 1 MB).
  // The fix replaces this with a simple linear tokenizer regex (no
  // lookaheads) followed by a JS diversity check function — the regex
  // stays O(n) and the diversity check is O(n) per token.
  //
  // The tokenizer `HIGH_ENTROPY_TOKENIZER` extracts candidate tokens:
  //   \b[A-Za-z0-9+/_\-]{32,512}\b
  // Then `hasHighEntropy()` checks class diversity: a token qualifies if
  // it has at least one uppercase, one lowercase, AND one digit character.
  //
  // HEX EXCLUSIONS (false-positive fix):
  // Bare lowercase hex tokens of exactly 64, 40, or 32 chars are excluded
  // from standalone detection because they are overwhelmingly git commit
  // hashes (SHA-256 = 64, SHA-1 = 40) or MD5 hashes (32), not secrets.
  // These lengths are already covered by the `assignment-secret` pattern
  // when they appear in a secret-like assignment context (e.g.
  // `secret_key: <32-hex>`). The bare hex branch only fires on
  // non-standard lengths or mixed-case hex.
  //
  // UUIDs (8-4-4-4-12 with dashes) cannot match (dashes and the
  // word-boundary break the token).
  {
    id: "high-entropy-run",
    // Placeholder regex — actual matching is done in scanForSecrets/
    // redactSecrets via the two-phase HIGH_ENTROPY_TOKENIZER + hasHighEntropy.
    // This entry exists so the pattern id is registered and iterable.
    re: /(?!)/g, // never matches — handled specially below
  },
];

// ---------------------------------------------------------------------------
// Two-phase high-entropy detection (linear-time replacement for the old
// lookahead-based regex that caused catastrophic backtracking on dense
// base64 — measured 3824 ms on 1 MB; the new approach is O(n)).
// ---------------------------------------------------------------------------

/** Linear tokenizer: extracts candidate runs of base64/hex-ish chars,
 *  32–512 chars long, word-bounded. No lookaheads — guaranteed linear. */
const HIGH_ENTROPY_TOKENIZER = /\b[A-Za-z0-9+/_-]{32,512}\b/g;

/** Standard hex lengths that are almost always hashes, not secrets:
 *  64 = SHA-256 / git commit hash, 40 = SHA-1, 32 = MD5.
 *  These are excluded from BARE detection (no assignment context).
 *  When a secret-like assignment anchor is present, the `assignment-secret`
 *  pattern already covers them. */
const EXCLUDED_HEX_LENGTHS = new Set([32, 40, 64]);

/** Returns true when `token` has enough character-class diversity to be
 *  plausibly a secret rather than a benign identifier/word run.
 *  For base64-ish tokens: requires at least one uppercase, one lowercase,
 *  and one digit. For pure hex tokens: only fires if the length is NOT a
 *  standard hash length (see EXCLUDED_HEX_LENGTHS above). */
function hasHighEntropy(token: string): boolean {
  // Check if it's pure lowercase hex
  const isLowerHex = /^[0-9a-f]+$/.test(token);
  if (isLowerHex) {
    // Exclude standard hash lengths (SHA-256=64, SHA-1=40, MD5=32) —
    // these are overwhelmingly commit hashes or content digests, not secrets.
    // Non-standard lengths or mixed-case hex still fire.
    return !EXCLUDED_HEX_LENGTHS.has(token.length);
  }

  // For mixed tokens: require class diversity (upper + lower + digit)
  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c >= 65 && c <= 90)
      hasUpper = true; // A-Z
    else if (c >= 97 && c <= 122)
      hasLower = true; // a-z
    else if (c >= 48 && c <= 57) hasDigit = true; // 0-9
    if (hasUpper && hasLower && hasDigit) return true;
  }
  return false;
}

/**
 * Scans `text` for every secret class in SECRET_PATTERNS. Returns the
 * unique set of pattern IDs that fired — never the raw matched text, so
 * callers can log/alert without echoing the secret.
 */
export function scanForSecrets(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const { id, re } of SECRET_PATTERNS) {
    if (id === "high-entropy-run") {
      // Two-phase: linear tokenizer + JS diversity check
      HIGH_ENTROPY_TOKENIZER.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HIGH_ENTROPY_TOKENIZER.exec(text)) !== null) {
        if (hasHighEntropy(m[0])) {
          hits.add(id);
          break; // only need to know it fired once
        }
      }
      continue;
    }
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
    if (id === "high-entropy-run") {
      // Two-phase: linear tokenizer + JS diversity check for replacement
      HIGH_ENTROPY_TOKENIZER.lastIndex = 0;
      out = out.replace(HIGH_ENTROPY_TOKENIZER, (match) =>
        hasHighEntropy(match) ? `[REDACTED:${id}]` : match,
      );
      continue;
    }
    // String.prototype.replace on a `g`-flagged regex starts matching from
    // index 0 regardless of a stale lastIndex, but we reset explicitly here
    // anyway so this function's behavior never depends on call ordering
    // relative to scanForSecrets (defensive, matches the lesson above).
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${id}]`);
  }
  return out;
}
