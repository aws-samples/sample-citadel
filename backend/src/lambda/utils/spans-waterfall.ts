/**
 * Spans Waterfall — Logs Insights `aws/spans` rows -> the SAME exported
 * `TraceEntry`/`TraceSpan`/`TraceWaterfallShape` types `xray-waterfall.ts`
 * emits (design §2 "aws/spans -> TraceEntry/TraceSpan mapping"). Because
 * the output TYPE is byte-identical, the frontend cannot tell which
 * backend produced a response.
 *
 * ============================================================================
 * SCHEMA-VERIFICATION GATE (design §2, HIGH risk #1) — READ BEFORE EDITING
 * ============================================================================
 * EVERY aws/spans field name referenced in this file (`spanId`,
 * `parentSpanId`, `traceId`, `startTimeUnixNano`/`endTimeUnixNano`, the
 * `attributes.*`/`annotation.*` attribute-key shapes, `statusCode`) is an
 * ASSUMPTION carried from the design doc, not a value verified against a
 * real CloudWatch Transaction Search span. Do NOT trust these names as
 * ground truth. Before `TRACE_BACKEND=spans` is ever flipped against a
 * real account, run a real query against `aws/spans` (see
 * docs/TRACING_RUNBOOK.md cutover procedure's "verify span schema with a
 * real sample" step) and reconcile every field-name constant below (and
 * the corresponding `spans-query.ts`/`trace-span-query.ts` query text)
 * against the actual result columns. Until that verification happens,
 * treat every mapping in this file as best-effort and unverified.
 * ============================================================================
 *
 * Pure and I/O-free — no AWS SDK imports. Consumes the plain
 * `SpanQueryRow` shape `spans-query.ts` returns (a flat string-keyed
 * record per Logs Insights result row).
 *
 * Invariant-4 analog (binding, mirrors xray-waterfall.ts): malformed or
 * incomplete rows (missing spanId/traceId) are skipped, never thrown.
 * Invariant 5 (binding): response is field-allowlisted — raw
 * `metadata`/`aws`/`sql` attribute bags are dropped unless
 * `includeMetadata` is true. Annotations are NOT part of that bag — they
 * are always included (the stitch-key contract).
 */
import type {
  SpanStatus,
  TraceEntry,
  TraceSpan,
  TraceWaterfallShape,
} from "./xray-waterfall";

export type { SpanStatus, TraceEntry, TraceSpan, TraceWaterfallShape };

/** Flat string-keyed view of one Logs Insights `aws/spans` result row —
 * matches `SpanQueryRow` from spans-query.ts. Field names are the
 * UNVERIFIED assumptions flagged in the module header above. */
export type SpanQueryRowLike = Record<string, string | undefined>;

function parseUnixNanoToSeconds(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n / 1e9;
}

function statusOf(row: SpanQueryRowLike): SpanStatus {
  // UNVERIFIED field names (module header): `statusCode` (OTel
  // status.code, expected "UNSET"|"OK"|"ERROR"), the http-status
  // attribute keys below. Best-effort trichotomy (design §2): OTel is
  // binary UNSET/OK/ERROR vs X-Ray's fault/error/throttle four-state.
  const httpStatusRaw =
    row["attributes.http.response.status_code"] ?? row["http.status_code"];
  const httpStatus = httpStatusRaw ? Number(httpStatusRaw) : undefined;
  const isError = row.statusCode === "ERROR";

  if (httpStatus === 429) return "throttle";
  if (isError && typeof httpStatus === "number" && httpStatus >= 500) {
    return "fault";
  }
  if (isError) return "error";
  return "ok";
}

function httpOf(row: SpanQueryRowLike): { status: number } | null {
  const raw =
    row["attributes.http.response.status_code"] ?? row["http.status_code"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  const status = Number(raw);
  return Number.isFinite(status) ? { status } : null;
}

function errorOf(
  row: SpanQueryRowLike,
): { type: string; message: string } | null {
  // UNVERIFIED (module header): exception attribute key shape.
  const message = row["attributes.exception.message"];
  if (typeof message !== "string" || message.length === 0) return null;
  return {
    type: row["attributes.exception.type"] ?? "Error",
    message,
  };
}

function collectAnnotations(rows: SpanQueryRowLike[]): Record<string, unknown> {
  const annotations: Record<string, unknown> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      // UNVERIFIED (module header): the `annotation.` prefix is the
      // expected attribute-key shape carrying X-Ray-style annotations
      // through aws/spans; may need to become a flattened column name
      // (e.g. `annotation_correlation_id`) once verified.
      if (key.startsWith("annotation.") && typeof value === "string") {
        annotations[key.slice("annotation.".length)] = value;
      }
    }
  }
  return annotations;
}

interface SpanRowOptions {
  includeMetadata: boolean;
  minStartTime: number;
}

function buildSpan(
  row: SpanQueryRowLike,
  childrenOf: Map<string, SpanQueryRowLike[]>,
  options: SpanRowOptions,
): TraceSpan {
  const startTime = parseUnixNanoToSeconds(row.startTimeUnixNano) ?? 0;
  const endTime = parseUnixNanoToSeconds(row.endTimeUnixNano);
  const inProgress = endTime === null;
  const durationMs =
    endTime !== null ? Math.max(0, (endTime - startTime) * 1000) : 0;
  const startOffsetMs = Math.max(0, (startTime - options.minStartTime) * 1000);

  const spanId = row.spanId as string;
  const childRows = childrenOf.get(spanId) ?? [];
  const children = childRows.map((child) =>
    buildSpan(child, childrenOf, options),
  );

  const span: TraceSpan = {
    id: spanId,
    parentId: row.parentSpanId ?? null,
    name: typeof row.name === "string" ? row.name : "",
    // UNVERIFIED (module header): namespace/origin attribute-key shape.
    namespace:
      typeof row["attributes.namespace"] === "string"
        ? row["attributes.namespace"]!
        : null,
    origin:
      typeof row["resource.attributes.service.name"] === "string"
        ? row["resource.attributes.service.name"]!
        : null,
    startTime,
    endTime,
    startOffsetMs,
    durationMs,
    status: statusOf(row),
    http: httpOf(row),
    error: errorOf(row),
    inProgress,
    children,
  };

  if (options.includeMetadata) {
    const metaEntries = Object.entries(row).filter(
      ([k]) =>
        k.startsWith("attributes.") &&
        !k.startsWith("attributes.http.") &&
        !k.startsWith("attributes.exception.") &&
        !k.startsWith("attributes.aws.") &&
        !k.startsWith("attributes.sql."),
    );
    const awsEntries = Object.entries(row).filter(([k]) =>
      k.startsWith("attributes.aws."),
    );
    const sqlEntries = Object.entries(row).filter(([k]) =>
      k.startsWith("attributes.sql."),
    );
    if (metaEntries.length > 0) span.metadata = Object.fromEntries(metaEntries);
    if (awsEntries.length > 0) span.aws = Object.fromEntries(awsEntries);
    if (sqlEntries.length > 0) span.sql = Object.fromEntries(sqlEntries);
  }

  return span;
}

function shapeSingleTrace(
  traceId: string,
  rows: SpanQueryRowLike[],
  options: { includeMetadata: boolean },
): TraceEntry {
  const validRows = rows.filter(
    (r) => typeof r.spanId === "string" && r.spanId.length > 0,
  );
  const byId = new Set(validRows.map((r) => r.spanId as string));

  const childrenOf = new Map<string, SpanQueryRowLike[]>();
  const roots: SpanQueryRowLike[] = [];
  for (const row of validRows) {
    const parentId = row.parentSpanId;
    if (
      typeof parentId === "string" &&
      parentId.length > 0 &&
      byId.has(parentId) &&
      parentId !== row.spanId
    ) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(row);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(row);
    }
  }

  const startTimes = validRows
    .map((r) => parseUnixNanoToSeconds(r.startTimeUnixNano))
    .filter((t): t is number => t !== null);
  const minStartTime = startTimes.length > 0 ? Math.min(...startTimes) : 0;
  const endTimes = validRows
    .map((r) => parseUnixNanoToSeconds(r.endTimeUnixNano))
    .filter((t): t is number => t !== null);
  const maxEndTime = endTimes.length > 0 ? Math.max(...endTimes) : minStartTime;

  const buildOptions: SpanRowOptions = {
    includeMetadata: options.includeMetadata,
    minStartTime,
  };
  const spans = roots.map((root) => buildSpan(root, childrenOf, buildOptions));

  const hasFault = validRows.some((r) => statusOf(r) === "fault");
  const hasError = validRows.some((r) => statusOf(r) === "error");
  const hasThrottle = validRows.some((r) => statusOf(r) === "throttle");

  const rootRow = roots[0];

  return {
    traceId,
    rootName: rootRow && typeof rootRow.name === "string" ? rootRow.name : null,
    startTime: minStartTime,
    endTime: endTimes.length > 0 ? maxEndTime : null,
    durationMs: Math.max(0, (maxEndTime - minStartTime) * 1000),
    hasError,
    hasFault,
    hasThrottle,
    annotations: collectAnnotations(validRows),
    spans,
  };
}

function countSpans(spans: TraceSpan[]): number {
  let count = 0;
  for (const span of spans) {
    count += 1 + countSpans(span.children);
  }
  return count;
}

/**
 * Shapes Logs Insights `aws/spans` result rows into the SAME
 * `TraceWaterfallShape` (`traces`/`truncated`/`meta`) that
 * `xray-waterfall.ts::shapeTraces` produces from `BatchGetTraces` output.
 * Groups rows by `traceId` first (a row missing `traceId` or `spanId` is
 * skipped — invariant-4 analog, never throws), then builds each trace's
 * span tree via the row's `parentSpanId` (a parent not present in the
 * same trace's row set is treated as a root — orphan-safe, mirrors
 * xray-waterfall.ts's `parent_id`-not-in-`byId` fallback).
 *
 * `truncated` is left `false` here for the same reason as
 * `xray-waterfall.ts::shapeTraces` — it depends on the query's row-limit
 * state (`spans-query.ts`'s `truncated` flag), which the caller (the
 * spans dispatch path in trace-query-handler.ts) is responsible for
 * overriding on the final response object.
 */
export function shapeSpanRows(
  rows: SpanQueryRowLike[],
  options: { includeMetadata: boolean },
): TraceWaterfallShape {
  const byTraceId = new Map<string, SpanQueryRowLike[]>();
  for (const row of rows) {
    if (typeof row.traceId !== "string" || row.traceId.length === 0) continue;
    if (typeof row.spanId !== "string" || row.spanId.length === 0) continue;
    const bucket = byTraceId.get(row.traceId) ?? [];
    bucket.push(row);
    byTraceId.set(row.traceId, bucket);
  }

  const shaped = Array.from(byTraceId.entries())
    .map(([traceId, traceRows]) =>
      shapeSingleTrace(traceId, traceRows, options),
    )
    .sort((a, b) => a.startTime - b.startTime);

  const spanCount = shaped.reduce((sum, t) => sum + countSpans(t.spans), 0);

  return {
    traces: shaped,
    truncated: false,
    meta: {
      traceCount: shaped.length,
      spanCount,
      estimate: false,
    },
  };
}
