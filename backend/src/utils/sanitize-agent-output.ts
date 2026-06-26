/**
 * Untrusted-output sanitizer for FOREIGN (imported) agent responses.
 *
 * When Citadel orchestrates an *imported* agent (a third-party substrate
 * reached via the agent-source adapter registry), that agent's response is
 * untrusted data: it can carry prompt-injection / instruction-like content
 * crafted to hijack the orchestrator once the text re-enters our flow. This
 * utility neutralizes the most common hijack markers by replacing each match
 * with a neutral `[sanitized]` sentinel — it does NOT delete surrounding
 * legitimate content.
 *
 * Mirrors the sibling `redact-pii.ts` convention: module-level global regexes
 * applied with String.prototype.replace (which resets lastIndex per call, so
 * the shared regex objects are safe to reuse).
 *
 * IDEMPOTENT by construction: the replacement marker `[sanitized]` contains
 * none of the trigger words ("ignore", "disregard", "you are now", "override
 * your", "new instructions", "system" role prefixes) and no opening marker
 * delimiter that any pattern can match, so a second pass over an already
 * sanitized string makes no further change:
 *   sanitize(sanitize(x)).sanitized === sanitize(x).sanitized
 *
 * The pattern list is intentionally SMALL and CONSERVATIVE — it targets
 * directive/role-hijack constructs, not normal prose, to avoid over-stripping
 * benign answers.
 *
 * `matches` reports stable pattern IDENTIFIERS (not the raw matched text), so
 * callers can log which classes of injection fired WITHOUT echoing the
 * untrusted payload.
 */

/** Neutral sentinel substituted for each neutralized injection construct. */
export const SANITIZED_MARKER = '[sanitized]';

export interface SanitizeResult {
  /** The input with every injection construct replaced by the marker. */
  sanitized: string;
  /** True iff at least one replacement was made. */
  modified: boolean;
  /** Unique IDs of the patterns that fired (never the raw matched text). */
  matches: string[];
}

interface InjectionPattern {
  /** Stable, log-safe identifier for this class of injection. */
  readonly id: string;
  /** Global, case-insensitive matcher. */
  readonly re: RegExp;
}

// Order is not significant for correctness (the marker is inert against every
// pattern) but is kept readable: directive phrases, then role markers.
const PATTERNS: readonly InjectionPattern[] = [
  // "ignore previous instructions", "ignore all prior instructions",
  // "ignore the above instructions", ...
  {
    id: 'ignore-previous-instructions',
    re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions?/gi,
  },
  // "disregard the above", "disregard previous", optionally "... instructions".
  {
    id: 'disregard-above',
    re: /disregard\s+(?:the\s+)?(?:above|previous|prior|earlier|preceding)(?:\s+instructions?)?/gi,
  },
  // Role-reassignment lead-in, e.g. "you are now an admin".
  {
    id: 'role-reassignment',
    re: /you\s+are\s+now\b/gi,
  },
  // Directive header injecting a fresh instruction block.
  {
    id: 'new-instructions',
    re: /new\s+instructions\s*:/gi,
  },
  // Attempt to override the orchestrator's own directives, e.g.
  // "override your system prompt".
  {
    id: 'override-your',
    re: /override\s+your\b/gi,
  },
  // Role-injection prefix at the START of a line, e.g. "system:", "assistant:",
  // "developer:". The `m` flag anchors ^ to each line. Plain "user:" is
  // intentionally excluded — it appears too often in benign transcripts.
  {
    id: 'role-injection-prefix',
    re: /^[ \t]*(?:system|assistant|developer)\s*:/gim,
  },
  // Chat-template / system directive markers: <system> .. </system>,
  // <|system|> / <|im_start|> / <|im_end|>, <<SYS>> / <</SYS>>, [INST] / [/INST].
  {
    id: 'system-directive-marker',
    re: /<\/?\s*system\s*>|<\|\s*(?:system|im_start|im_end)\s*\|>|<<\s*\/?\s*sys\s*>>|\[\s*\/?\s*inst\s*\]/gi,
  },
];

/**
 * Neutralize prompt-injection / instruction-like content in an untrusted
 * agent output. Benign text is returned unchanged with `modified: false`.
 */
export function sanitizeUntrustedAgentOutput(text: string): SanitizeResult {
  if (!text) {
    return { sanitized: text ?? '', modified: false, matches: [] };
  }

  const matched = new Set<string>();
  let out = text;

  for (const { id, re } of PATTERNS) {
    // String.prototype.replace resets the regex lastIndex, so reusing the
    // module-level objects across calls is safe. The callback only runs on a
    // real match, so the id is recorded only when the pattern actually fires.
    out = out.replace(re, () => {
      matched.add(id);
      return SANITIZED_MARKER;
    });
  }

  return {
    sanitized: out,
    modified: out !== text,
    matches: [...matched],
  };
}
