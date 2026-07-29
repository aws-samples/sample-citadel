/**
 * X-Ray Filter — pure `buildCorrelationFilter(id)` expression builder +
 * id allowlist/escape (design §3 "filterExpression builder").
 *
 * Invariant 6 (binding): the filter expression is exactly
 * `annotation.correlation_id = "<allowlisted-id>"`. Ids are UUID/`1-…`
 * (X-Ray trace-id) shaped, so a strict allowlist regex rejects anything
 * else — including a `"`-bearing id — BEFORE a filter expression string
 * is ever built, closing off X-Ray FilterExpression injection.
 *
 * Pure and I/O-free — no AWS SDK imports.
 */

/** `^[A-Za-z0-9\-:_.]+$`, non-empty — covers UUIDs, X-Ray trace ids
 * (`1-<8hex>-<24hex>`), and our own executionId/projectId shapes. Rejects
 * whitespace, quotes, and control characters outright. */
const ALLOWLIST_RE = /^[A-Za-z0-9\-:_.]+$/;

/**
 * True when `id` is safe to interpolate into an X-Ray FilterExpression
 * string. Never throws.
 */
export function isAllowlistedId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && ALLOWLIST_RE.test(id);
}

export type CorrelationFilterResult =
  { ok: true; expression: string } | { ok: false };

/**
 * Builds the exact `annotation.correlation_id = "<id>"` filter expression
 * X-Ray's `GetTraceSummaries` expects, or rejects the id outright when it
 * fails the allowlist — never falls back to a sanitized/escaped variant,
 * since escaping inside an X-Ray FilterExpression is not a documented,
 * verifiable-safe operation. Reject-first is the only defensible posture.
 */
export function buildCorrelationFilter(id: string): CorrelationFilterResult {
  if (!isAllowlistedId(id)) {
    return { ok: false };
  }
  return { ok: true, expression: `annotation.correlation_id = "${id}"` };
}
