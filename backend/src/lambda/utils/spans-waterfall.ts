/**
 * Spans Waterfall — Logs Insights `aws/spans` rows -> the SAME exported
 * `TraceEntry`/`TraceSpan`/`TraceWaterfallShape` types `xray-waterfall.ts`
 * emits (design §2 "aws/spans -> TraceEntry/TraceSpan mapping"). Because
 * the output TYPE is byte-identical, the frontend cannot tell which
 * backend produced a response.
 *
 * ============================================================================
 * SCHEMA VERIFIED (evidence report, finding a3d8a2ea, 2026-08-03 +
 * 2026-08-14 real-account samples — see docs/TRACING_RUNBOOK.md cutover
 * procedure) — READ BEFORE EDITING
 * ============================================================================
 * Every aws/spans field name below was reconciled against real
 * CloudWatch Transaction Search span/subsegment events (Lambda + AppSync
 * producers). Key corrections from the original design-doc assumptions:
 *   - Annotations are merged into `attributes.<key>` (bare key), NOT
 *     `annotation.<key>` — enumerated via
 *     `attributes["aws.xray.annotation_keys"]`.
 *   - OTel status is the flattened `status.code` field (UNSET/ERROR
 *     observed; OK never observed — untested), not `statusCode`.
 *   - Subsegment display name/namespace live at `_aws.xray.name` /
 *     `_aws.xray.namespace` — top-level `name` is `""` on subsegments.
 *   - http-status fallback key is `attributes.http.status_code`
 *     (attributes-prefixed), not bare `http.status_code`.
 *   - Exception text observed at `_aws.xray.cause.message`; OTel
 *     `attributes.exception.*` is kept as primary but unobserved.
 *   - In-progress snapshots (`attributes["aws.xray.inprogress"]===true`,
 *     no `endTimeUnixNano`) and the completed event share a `spanId` —
 *     deduped before tree-building.
 * Re-verify against a live sample if aws/spans schema changes upstream.
 * ============================================================================
 *
 * Pure and I/O-free — no AWS SDK imports. Consumes the plain
 * `SpanQueryRow` shape `spans-query.ts` returns (a flat string-keyed
 * record per Logs Insights result row, with each row's `@message` JSON
 * document flattened into dot-notation keys by spans-query.ts).
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
 * matches `SpanQueryRow` from spans-query.ts (dot-flattened `@message`
 * JSON). Field names are verified against real samples per the module
 * header above. */
export type SpanQueryRowLike = Record<string, string | undefined>;

function parseUnixNanoToSeconds(value: string | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n / 1e9;
}

function statusOf(row: SpanQueryRowLike): SpanStatus {
  // Verified (evidence report finding a3d8a2ea, probe B): the OTel status
  // is a flattened `status.code` field (values observed: UNSET, ERROR;
  // OK never observed — treat as untested). The http-status fallback key
  // is `attributes.http.status_code` (attributes-prefixed), not bare
  // `http.status_code` (probe B/D). Best-effort trichotomy (design §2):
  // OTel is binary UNSET/OK/ERROR vs X-Ray's fault/error/throttle
  // four-state.
  const httpStatusRaw =
    row["attributes.http.response.status_code"] ??
    row["attributes.http.status_code"];
  const httpStatus = httpStatusRaw ? Number(httpStatusRaw) : undefined;
  const isError = row["status.code"] === "ERROR";

  if (httpStatus === 429) return "throttle";
  if (isError && typeof httpStatus === "number" && httpStatus >= 500) {
    return "fault";
  }
  if (isError) return "error";
  return "ok";
}

function httpOf(row: SpanQueryRowLike): { status: number } | null {
  const raw =
    row["attributes.http.response.status_code"] ??
    row["attributes.http.status_code"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  const status = Number(raw);
  return Number.isFinite(status) ? { status } : null;
}

function errorOf(
  row: SpanQueryRowLike,
): { type: string; message: string } | null {
  // `attributes.exception.*` is NOT-OBSERVABLE in the evidence report
  // (no SDK-instrumented producer sampled emits it) but is kept as the
  // primary OTel-standard key for producers that do emit it. The real
  // sampled ERROR span (AppSync, 401) carried its cause text at
  // `_aws.xray.cause.message` instead — added as a fallback so real
  // X-Ray-origin error spans surface a message.
  const message =
    row["attributes.exception.message"] ?? row["_aws.xray.cause.message"];
  if (typeof message !== "string" || message.length === 0) return null;
  return {
    type: row["attributes.exception.type"] ?? "Error",
    message,
  };
}

function collectAnnotations(rows: SpanQueryRowLike[]): Record<string, unknown> {
  // Verified (evidence report finding a3d8a2ea, probe B/C + archived
  // sample): annotations are NOT under an `annotation.` prefix — X-Ray
  // annotations are merged into `attributes` under their bare key, and
  // enumerated by the `attributes["aws.xray.annotation_keys"]` array
  // (JSON-stringified array leaf per spans-query.ts's flatten()).
  const annotations: Record<string, unknown> = {};
  for (const row of rows) {
    const keysRaw = row["attributes.aws.xray.annotation_keys"];
    if (typeof keysRaw !== "string" || keysRaw.length === 0) continue;
    let keys: unknown;
    try {
      keys = JSON.parse(keysRaw);
    } catch {
      continue;
    }
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      if (typeof key !== "string" || key.length === 0) continue;
      const value = row[`attributes.${key}`];
      if (typeof value === "string") {
        annotations[key] = value;
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
    // Verified (evidence report finding a3d8a2ea, samples + probe D):
    // subsegments always carry an empty top-level `name` (""); their
    // display name lives only in `_aws.xray.name`. Fall back to it when
    // the top-level name is empty/absent.
    name:
      typeof row.name === "string" && row.name.length > 0
        ? row.name
        : typeof row["_aws.xray.name"] === "string"
          ? row["_aws.xray.name"]!
          : "",
    // Verified: namespace lives at `_aws.xray.namespace` (e.g. "aws" on
    // the AppSync segment), never `attributes.namespace` (unobserved).
    namespace:
      typeof row["_aws.xray.namespace"] === "string"
        ? row["_aws.xray.namespace"]!
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

/** In-progress snapshots (`attributes["aws.xray.inprogress"]===true`, no
 * `endTimeUnixNano`) and the eventual completed event share the same
 * `spanId` — Transaction Search emits both as the stream progresses
 * (evidence report finding a3d8a2ea: 3 duplicate spanIds observed in a
 * 10-event window). Dedup before tree-building: keep the completed row
 * (has `endTimeUnixNano`) when both are present for a spanId, else keep
 * whichever snapshot row was seen last (the latest in-progress state).
 */
function dedupBySpanId(rows: SpanQueryRowLike[]): SpanQueryRowLike[] {
  const bySpanId = new Map<string, SpanQueryRowLike>();
  const order: string[] = [];
  for (const row of rows) {
    const spanId = row.spanId as string;
    const existing = bySpanId.get(spanId);
    if (!existing) {
      bySpanId.set(spanId, row);
      order.push(spanId);
      continue;
    }
    const existingCompleted =
      typeof existing.endTimeUnixNano === "string" &&
      existing.endTimeUnixNano.length > 0;
    const rowCompleted =
      typeof row.endTimeUnixNano === "string" && row.endTimeUnixNano.length > 0;
    if (rowCompleted || !existingCompleted) {
      // Either this row is the completed one (always wins), or neither
      // row is completed yet and this is the latest snapshot seen.
      bySpanId.set(spanId, row);
    }
  }
  return order.map((id) => bySpanId.get(id)!);
}

function shapeSingleTrace(
  traceId: string,
  rows: SpanQueryRowLike[],
  options: { includeMetadata: boolean },
): TraceEntry {
  const validRows = dedupBySpanId(
    rows.filter((r) => typeof r.spanId === "string" && r.spanId.length > 0),
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
  const rootName =
    rootRow && typeof rootRow.name === "string" && rootRow.name.length > 0
      ? rootRow.name
      : rootRow && typeof rootRow["_aws.xray.name"] === "string"
        ? rootRow["_aws.xray.name"]!
        : null;

  return {
    traceId,
    rootName,
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
