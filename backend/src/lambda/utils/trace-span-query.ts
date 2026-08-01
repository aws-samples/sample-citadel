/**
 * Trace Span Query — pure Logs Insights filter-clause builders for the
 * Transaction Search (`aws/spans`) span-query path (design §2 "Annotation
 * contract (the crux)", §4 file list item 2).
 *
 * Reuses the SAME allowlist/reject-first discipline as
 * `xray-filter.ts`'s `ALLOWLIST_RE`/`buildCorrelationFilter` — an id must
 * pass the allowlist BEFORE it is interpolated into a Logs Insights
 * `filter` clause, closing off query-string injection. This is MORE
 * critical here than for X-Ray's FilterExpression: Logs Insights queries
 * are multi-clause pipelines (`filter ... | stats ... | sort ...`), so an
 * unescaped id could inject a pipe-delimited additional command, not just
 * a boolean-logic clause.
 *
 * Pure and I/O-free — no AWS SDK imports.
 */

/** `^[A-Za-z0-9\-:_.]+$`, non-empty — identical shape to xray-filter.ts's
 * ALLOWLIST_RE (UUIDs, X-Ray trace ids, our own executionId/projectId/
 * run-<uuid> shapes). Rejects whitespace, quotes, pipes, and control
 * characters outright — a Logs Insights query is a `|`-delimited
 * pipeline, so rejecting `|` here (already covered by the allowlist,
 * which contains no `|`) is load-bearing, not incidental. */
export const SPAN_ALLOWLIST_RE = /^[A-Za-z0-9\-:_.]+$/;

/**
 * True when `id` is safe to interpolate into a Logs Insights `filter`
 * clause. Never throws.
 */
export function isAllowlistedSpanId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && SPAN_ALLOWLIST_RE.test(id);
}

export type SpanFilterResult = { ok: true; clause: string } | { ok: false };

/**
 * Builds the Logs Insights filter clause equivalent of X-Ray's
 * `annotation.correlation_id = "<id>"`, or rejects the id outright when
 * it fails the allowlist (reject-first — never falls back to a
 * sanitized/escaped variant, matching xray-filter.ts's posture).
 *
 * Backtick-quoted field name (`` `annotation.correlation_id` ``) because
 * Logs Insights field names containing `.` must be backtick-quoted to be
 * parsed as a single field reference rather than nested-field access.
 */
export function buildSpanCorrelationFilter(id: string): SpanFilterResult {
  if (!isAllowlistedSpanId(id)) {
    return { ok: false };
  }
  return {
    ok: true,
    clause: `filter \`annotation.correlation_id\` = "${id}"`,
  };
}

/**
 * Builds the Logs Insights filter clause equivalent of X-Ray's
 * `annotation.run_id = "<id>"` — the runId-primary counterpart to
 * `buildSpanCorrelationFilter` (mirrors xray-filter.ts's
 * `buildRunIdFilter`). Same allowlist/reject-first discipline.
 */
export function buildSpanRunIdFilter(id: string): SpanFilterResult {
  if (!isAllowlistedSpanId(id)) {
    return { ok: false };
  }
  return {
    ok: true,
    clause: `filter \`annotation.run_id\` = "${id}"`,
  };
}
