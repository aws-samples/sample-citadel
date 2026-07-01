/**
 * Recursive sanitizer for UNTRUSTED JSON (Tier-3 agent-import).
 *
 * An LLM-proposed agent manifest is untrusted data: it can carry prompt-
 * injection / instruction-like content AND adversarial structure (deeply
 * nested objects, million-element arrays, multi-MB strings, control-char
 * keys) crafted to hijack or exhaust a downstream consumer. This module
 * neutralizes BOTH dimensions before the payload is ever stored:
 *
 *   1. CONTENT — every string VALUE is run through the existing
 *      {@link sanitizeUntrustedAgentOutput} (the single source of truth for
 *      injection-marker neutralization). Object KEYS are stripped of control
 *      characters, length-capped, and passed through the same neutralizer.
 *   2. STRUCTURE — depth / total-node / array-length / string-length caps
 *      bound the work and the output size. Exceeding a cap TRUNCATES: an
 *      over-deep or over-budget value node becomes `null`; extra array
 *      elements and extra object keys beyond budget are dropped; over-long
 *      arrays and strings are sliced. Any truncation sets the `truncated`
 *      flag on the result.
 *
 * Non-string primitives (number / boolean / null) are preserved as-is.
 * Non-finite numbers (NaN / ±Infinity — never valid JSON) are coerced to
 * `null`, matching JSON.stringify semantics. Unsupported JS values
 * (undefined / function / symbol / bigint — never present in parsed JSON) are
 * coerced to `null` defensively.
 *
 * PURE: no I/O, no global mutation, and the input graph is never mutated — a
 * fresh value graph is returned. The module-level regexes inside
 * sanitizeUntrustedAgentOutput are reused safely (String.prototype.replace
 * resets lastIndex per call).
 */
import { sanitizeUntrustedAgentOutput } from './sanitize-agent-output';

export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Max nesting depth before a branch is truncated (root = depth 0). */
export const DEFAULT_MAX_DEPTH = 12;
/** Max total nodes (every primitive/array/object counts as one). */
export const DEFAULT_MAX_NODES = 5000;
/** Max array length retained; extra elements are dropped. */
export const DEFAULT_MAX_ARRAY_LENGTH = 1000;
/** Max string length retained for any value; longer strings are sliced. */
export const DEFAULT_MAX_STRING_LENGTH = 10_000;
/** Max object-key length retained; longer keys are sliced. */
export const DEFAULT_MAX_KEY_LENGTH = 256;

export interface SanitizeUntrustedJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
  maxKeyLength?: number;
}

export interface SanitizeUntrustedJsonResult {
  /** The sanitized, structurally-bounded value graph (fresh; input untouched). */
  value: JsonValue;
  /** True iff any cap was hit (a branch/array/string/key was truncated). */
  truncated: boolean;
  /** Number of nodes visited (bounded by maxNodes + the count that tripped it). */
  nodeCount: number;
  /** Stable injection-pattern IDs that fired (never raw matched text; log-safe). */
  matches: string[];
}

// Control characters (C0 + DEL + C1) stripped from object keys. The literal
// control-character class is the explicit purpose here (defanging hostile keys),
// so the no-control-regex lint rule is intentionally disabled for this line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Recursively sanitize an untrusted JSON-like value. See module docs for the
 * full contract. Always returns a wrapper; never throws on a hostile payload.
 */
export function sanitizeUntrustedJson(
  value: unknown,
  opts: SanitizeUntrustedJsonOptions = {},
): SanitizeUntrustedJsonResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const maxArrayLength = opts.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxStringLength = opts.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxKeyLength = opts.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;

  // Per-call mutable accumulators (kept local => the function stays pure).
  const matched = new Set<string>();
  let truncated = false;
  let nodeCount = 0;

  const sanitizeStringValue = (input: string): string => {
    let str = input;
    if (str.length > maxStringLength) {
      str = str.slice(0, maxStringLength);
      truncated = true;
    }
    const res = sanitizeUntrustedAgentOutput(str);
    for (const id of res.matches) matched.add(id);
    return res.sanitized;
  };

  const sanitizeKey = (key: string): string => {
    let k = key.replace(CONTROL_CHARS, '');
    if (k.length > maxKeyLength) {
      k = k.slice(0, maxKeyLength);
      truncated = true;
    }
    const res = sanitizeUntrustedAgentOutput(k);
    for (const id of res.matches) matched.add(id);
    return res.sanitized;
  };

  const walk = (node: unknown, depth: number): JsonValue => {
    nodeCount += 1;
    // Node-budget cap: once exhausted, every further node collapses to null.
    if (nodeCount > maxNodes) {
      truncated = true;
      return null;
    }
    // Depth cap: an over-deep branch is truncated to null.
    if (depth > maxDepth) {
      truncated = true;
      return null;
    }

    if (node === null) return null;

    const t = typeof node;
    if (t === 'string') return sanitizeStringValue(node as string);
    if (t === 'number') return Number.isFinite(node as number) ? (node as number) : null;
    if (t === 'boolean') return node as boolean;

    if (Array.isArray(node)) {
      const out: JsonArray = [];
      if (node.length > maxArrayLength) truncated = true;
      const limit = Math.min(node.length, maxArrayLength);
      for (let i = 0; i < limit; i += 1) {
        if (nodeCount >= maxNodes) {
          // Remaining elements cannot be represented within budget.
          if (i < limit) truncated = true;
          break;
        }
        out.push(walk(node[i], depth + 1));
      }
      return out;
    }

    if (t === 'object') {
      const out: JsonObject = {};
      for (const [rawKey, rawVal] of Object.entries(node as Record<string, unknown>)) {
        if (nodeCount >= maxNodes) {
          truncated = true;
          break;
        }
        // JSON has no `undefined`; drop such keys rather than emitting null
        // (matches JSON.stringify, which omits undefined-valued properties).
        if (rawVal === undefined) continue;
        out[sanitizeKey(rawKey)] = walk(rawVal, depth + 1);
      }
      return out;
    }

    // undefined / function / symbol / bigint — not valid JSON; defang to null.
    truncated = true;
    return null;
  };

  const result = walk(value, 0);

  return {
    value: result,
    truncated,
    nodeCount,
    matches: [...matched],
  };
}
