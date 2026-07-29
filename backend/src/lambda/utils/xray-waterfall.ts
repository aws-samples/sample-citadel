/**
 * X-Ray Waterfall — pure `Trace[] -> TraceWaterfallResponse` transform
 * (design §2 "Response — TraceWaterfallResponse", §3 "X-RAY PARSING
 * NOTES"). No AWS SDK imports; callers pass already-fetched
 * `BatchGetTraces` `Trace[]` items in.
 *
 * Invariant 4 (binding): segment-Document parsing never throws — a
 * malformed or missing `Document` is skipped, never propagated.
 * Invariant 5 (binding): response is field-allowlisted; raw
 * `metadata`/`aws`/`sql` bags are dropped unless `includeMetadata` is
 * true (the admin opt-in). Annotations are NOT part of that bag — they
 * are the stitch-key contract (`correlation_id` etc., see
 * trace-context.ts) and are always included.
 */

export type SpanStatus = "ok" | "error" | "fault" | "throttle";

export interface TraceSpan {
  id: string;
  parentId: string | null;
  name: string;
  namespace: string | null;
  origin: string | null;
  startTime: number;
  endTime: number | null;
  startOffsetMs: number;
  durationMs: number;
  status: SpanStatus;
  http: { status: number } | null;
  error: { type: string; message: string } | null;
  inProgress: boolean;
  children: TraceSpan[];
  /** Present only when includeMetadata is true (admin opt-in). */
  metadata?: unknown;
  aws?: unknown;
  sql?: unknown;
}

export interface TraceEntry {
  traceId: string;
  rootName: string | null;
  startTime: number;
  endTime: number | null;
  durationMs: number;
  hasError: boolean;
  hasFault: boolean;
  hasThrottle: boolean;
  annotations: Record<string, unknown>;
  spans: TraceSpan[];
}

export interface TraceWaterfallShape {
  traces: TraceEntry[];
  truncated: boolean;
  meta: { traceCount: number; spanCount: number; estimate: boolean };
}

/** Narrow view of a BatchGetTraces `Trace` item — avoids depending on the
 * full @aws-sdk/client-xray `Trace` type so this module stays pure/testable
 * with plain object fixtures. */
export interface XRayTraceLike {
  Id?: string;
  Duration?: number;
  Segments?: Array<{ Document?: string }>;
}

interface SegmentDoc {
  id?: string;
  name?: string;
  trace_id?: string;
  parent_id?: string;
  start_time?: number;
  end_time?: number;
  namespace?: string;
  origin?: string;
  http?: { response?: { status?: number } };
  error?: boolean;
  fault?: boolean;
  throttle?: boolean;
  cause?: { exceptions?: Array<{ type?: string; message?: string }> };
  annotations?: Record<string, unknown>;
  metadata?: unknown;
  aws?: unknown;
  sql?: unknown;
  subsegments?: SegmentDoc[];
}

/**
 * Parses a single segment's `Document` JSON string. Returns undefined for
 * a missing or malformed document — never throws (invariant 4). Also
 * flattens `subsegments[]` into the returned array (each subsegment
 * carries its own `parent_id` back to its owner when present, or inherits
 * the segment's id as parent when absent), so the caller can index every
 * (sub)segment uniformly by `id`.
 */
function parseSegmentDocuments(
  documents: Array<string | undefined>,
): SegmentDoc[] {
  const flat: SegmentDoc[] = [];

  function flatten(
    doc: SegmentDoc,
    inheritedParentId: string | undefined,
  ): void {
    const withParent: SegmentDoc = {
      ...doc,
      parent_id: doc.parent_id ?? inheritedParentId,
    };
    flat.push(withParent);
    if (Array.isArray(doc.subsegments)) {
      for (const sub of doc.subsegments) {
        if (sub && typeof sub === "object") {
          flatten(sub, doc.id);
        }
      }
    }
  }

  for (const raw of documents) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      const doc = parsed as SegmentDoc;
      if (typeof doc.id !== "string" || doc.id.length === 0) continue;
      flatten(doc, undefined);
    } catch {
      // Malformed JSON — skip this segment, never throw (invariant 4).
      continue;
    }
  }

  return flat;
}

function statusOf(doc: SegmentDoc): SpanStatus {
  if (doc.fault) return "fault";
  if (doc.error) return "error";
  if (doc.throttle) return "throttle";
  return "ok";
}

function errorOf(doc: SegmentDoc): { type: string; message: string } | null {
  const first = doc.cause?.exceptions?.[0];
  if (!first) return null;
  return {
    type: typeof first.type === "string" ? first.type : "Error",
    message: typeof first.message === "string" ? first.message : "",
  };
}

function httpOf(doc: SegmentDoc): { status: number } | null {
  const status = doc.http?.response?.status;
  return typeof status === "number" ? { status } : null;
}

interface BuildSpanOptions {
  includeMetadata: boolean;
  minStartTime: number;
}

function buildSpan(
  doc: SegmentDoc,
  byId: Map<string, SegmentDoc[]>,
  childrenOf: Map<string, SegmentDoc[]>,
  options: BuildSpanOptions,
): TraceSpan {
  const startTime = typeof doc.start_time === "number" ? doc.start_time : 0;
  const endTime = typeof doc.end_time === "number" ? doc.end_time : null;
  const inProgress = endTime === null;
  const durationMs =
    endTime !== null ? Math.max(0, (endTime - startTime) * 1000) : 0;
  const startOffsetMs = Math.max(0, (startTime - options.minStartTime) * 1000);

  const childDocs = childrenOf.get(doc.id!) ?? [];
  const children = childDocs.map((child) =>
    buildSpan(child, byId, childrenOf, options),
  );

  const span: TraceSpan = {
    id: doc.id!,
    parentId: doc.parent_id ?? null,
    name: typeof doc.name === "string" ? doc.name : "",
    namespace: typeof doc.namespace === "string" ? doc.namespace : null,
    origin: typeof doc.origin === "string" ? doc.origin : null,
    startTime,
    endTime,
    startOffsetMs,
    durationMs,
    status: statusOf(doc),
    http: httpOf(doc),
    error: errorOf(doc),
    inProgress,
    children,
  };

  if (options.includeMetadata) {
    if (doc.metadata !== undefined) span.metadata = doc.metadata;
    if (doc.aws !== undefined) span.aws = doc.aws;
    if (doc.sql !== undefined) span.sql = doc.sql;
  }

  return span;
}

function shapeSingleTrace(
  raw: XRayTraceLike,
  options: { includeMetadata: boolean },
): TraceEntry {
  const documents = (raw.Segments ?? []).map((s) => s.Document);
  const docs = parseSegmentDocuments(documents);

  const byId = new Map<string, SegmentDoc[]>();
  for (const doc of docs) {
    if (doc.id) byId.set(doc.id, [doc]);
  }

  const childrenOf = new Map<string, SegmentDoc[]>();
  const roots: SegmentDoc[] = [];
  for (const doc of docs) {
    const parentId = doc.parent_id;
    if (parentId && byId.has(parentId) && parentId !== doc.id) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(doc);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(doc);
    }
  }

  const startTimes = docs
    .map((d) => d.start_time)
    .filter((t): t is number => typeof t === "number");
  const minStartTime = startTimes.length > 0 ? Math.min(...startTimes) : 0;
  const maxEndTime = docs
    .map((d) => d.end_time)
    .filter((t): t is number => typeof t === "number")
    .reduce((max, t) => Math.max(max, t), minStartTime);

  const buildOptions: BuildSpanOptions = {
    includeMetadata: options.includeMetadata,
    minStartTime,
  };
  const spans = roots.map((root) =>
    buildSpan(root, byId, childrenOf, buildOptions),
  );

  const hasFault = docs.some((d) => d.fault === true);
  const hasError = docs.some((d) => d.error === true);
  const hasThrottle = docs.some((d) => d.throttle === true);

  const annotations: Record<string, unknown> = {};
  for (const doc of docs) {
    if (doc.annotations && typeof doc.annotations === "object") {
      Object.assign(annotations, doc.annotations);
    }
  }

  const rootDoc = roots[0];

  return {
    traceId: raw.Id ?? "",
    rootName: rootDoc && typeof rootDoc.name === "string" ? rootDoc.name : null,
    startTime: minStartTime,
    endTime: startTimes.length > 0 ? maxEndTime : null,
    durationMs:
      typeof raw.Duration === "number"
        ? raw.Duration * 1000
        : Math.max(0, (maxEndTime - minStartTime) * 1000),
    hasError,
    hasFault,
    hasThrottle,
    annotations,
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
 * Shapes a `BatchGetTraces` result into the `TraceWaterfallResponse`
 * "traces"/"meta" portion (design §2). `truncated` is left to the caller
 * (it depends on pagination state the caller — not this pure function —
 * tracks), so this returns `truncated: false` by default; callers should
 * override that field on the final response object if a page limit was
 * hit.
 */
export function shapeTraces(
  traces: XRayTraceLike[],
  options: { includeMetadata: boolean },
): TraceWaterfallShape {
  const shaped = traces
    .map((t) => shapeSingleTrace(t, options))
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
