/**
 * Trace-context propagation helpers (architect task f4f4bab3-7a07-4acf-ba43-
 * ba43bb488444, design §"Carried-context format decision" /
 * §"Annotation-key contract").
 *
 * Root-segment constraint (honest framing, see design): Lambda owns its root
 * segment. These helpers never attempt to make a consumer adopt an upstream
 * trace-id as its own root — they carry an ADDITIVE, OPTIONAL `traceContext`
 * object across async hops and, on the consumer side, stitch it onto the
 * consumer's own trace via searchable X-Ray annotations
 * (`source_trace_id` / `correlation_id`) plus structured-log fields. This
 * delivers provably-linked traces, never a false merge.
 *
 * No-op-safety (property-tested in __tests__/trace-context.test.ts): every
 * function here is safe to call with NO active X-Ray segment (Jest, local
 * dev, a cold path before the Lambda runtime attaches a segment) — none of
 * them throw, and the additive fields are simply omitted.
 */
import * as AWSXRay from "aws-xray-sdk-core";

/**
 * The additive, optional trace-context object carried in EventBridge Detail
 * bodies / SQS message bodies across async hops. Every field is optional —
 * absence must never fail a consumer (property-tested).
 */
export interface TraceContext {
  /** Authoritative: the exact format our SDKs (X-Ray, Lambda) consume. */
  xrayTraceHeader?: string;
  /** X-Ray Root trace id, e.g. "1-<8hex>-<24hex>". Convenience for logs/annotations. */
  traceId?: string;
  /** Active (sub)segment id at carry time, e.g. "<16hex>". */
  parentId?: string;
  /** W3C rendering, mechanical/best-effort. Cheap to omit. */
  traceparent?: string;
  /** Correlation id (== executionId for workflows; per-event uuid for intake usage). */
  correlationId?: string;
  /**
   * Server-minted shared correlation id (Pass 1, decision f1cbd5ef,
   * design §2 "Carried trace context" row). Additive, optional — absent on
   * pre-runId hops; never fabricated here, only carried when the producer
   * supplied one.
   */
  runId?: string;
}

const XRAY_ROOT_RE = /^1-([0-9a-f]{8})-([0-9a-f]{24})$/i;

/**
 * Read the active X-Ray segment/subsegment (if any) and render it into a
 * TraceContext. Returns undefined outside a segment (e.g. Jest, cold
 * dev-local invocation) — never throws.
 */
export function getActiveTraceContext(): TraceContext | undefined {
  try {
    const segment = AWSXRay.getSegment();
    if (!segment) {
      return undefined;
    }
    // A Subsegment carries the Root trace_id on its parent `.segment`, not
    // on itself; a root Segment carries it directly. Read whichever is
    // present, narrowing to a plain object shape with `trace_id` so this
    // works for either union member without importing the Subsegment type.
    const rootSegment: Pick<AWSXRay.Segment, "trace_id"> & {
      notTraced?: boolean;
    } =
      (segment as { segment?: AWSXRay.Segment }).segment ??
      (segment as unknown as AWSXRay.Segment);
    const xrayTraceHeader = renderXRayHeader(rootSegment, segment.id);
    const traceId = rootSegment.trace_id;
    const parentId = segment.id;
    const sampled = !(rootSegment as { notTraced?: boolean }).notTraced;
    const traceparent =
      traceId && parentId
        ? toTraceparent(traceId, parentId, sampled)
        : undefined;
    if (!traceId && !parentId && !xrayTraceHeader) {
      return undefined;
    }
    return {
      ...(xrayTraceHeader ? { xrayTraceHeader } : {}),
      ...(traceId ? { traceId } : {}),
      ...(parentId ? { parentId } : {}),
      ...(traceparent ? { traceparent } : {}),
    };
  } catch {
    // No-op-safe: a tracing read failure must never break the caller.
    return undefined;
  }
}

/**
 * Render an X-Ray segment/subsegment as the standard header string:
 * "Root=<traceId>;Parent=<id>;Sampled=<0|1>" — the exact format the X-Ray
 * `AWSTraceHeader` SQS MessageAttribute and the `_X_AMZN_TRACE_ID` env var
 * use. `rootSegment` supplies `trace_id`; `parentId` is the active
 * (sub)segment's own id.
 */
export function renderXRayHeader(
  rootSegment: Pick<AWSXRay.Segment, "trace_id"> & { notTraced?: boolean },
  parentId: string | undefined,
): string | undefined {
  if (!rootSegment || !rootSegment.trace_id || !parentId) {
    return undefined;
  }
  const sampled = rootSegment.notTraced ? "0" : "1";
  return `Root=${rootSegment.trace_id};Parent=${parentId};Sampled=${sampled}`;
}

/**
 * Mechanical, best-effort X-Ray Root -> W3C `traceparent` conversion:
 * strip the "1-" version prefix and the dash from an X-Ray Root
 * (1-<8hex>-<24hex>) to produce the 32-hex W3C trace-id, reuse the X-Ray
 * (sub)segment id as the W3C parent/span-id, and map Sampled -> flags
 * (01 sampled, 00 not). Returns undefined for a malformed X-Ray trace id
 * rather than throwing or fabricating a value.
 */
export function toTraceparent(
  xrayTraceId: string,
  parentId: string,
  sampled: boolean,
): string | undefined {
  const match = XRAY_ROOT_RE.exec(xrayTraceId ?? "");
  if (!match || !parentId) {
    return undefined;
  }
  const traceId32 = `${match[1]}${match[2]}`;
  const flags = sampled ? "01" : "00";
  return `00-${traceId32}-${parentId}-${flags}`;
}

/**
 * Extract a well-formed `TraceContext` from an arbitrary EventBridge Detail
 * / SQS message-body object. Returns undefined for a missing, non-object,
 * or malformed `traceContext` field — never throws (property-tested against
 * arbitrary input).
 */
export function extractCarried(detail: unknown): TraceContext | undefined {
  try {
    if (
      typeof detail !== "object" ||
      detail === null ||
      Array.isArray(detail)
    ) {
      return undefined;
    }
    const candidate = (detail as Record<string, unknown>).traceContext;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    return candidate as TraceContext;
  } catch {
    return undefined;
  }
}

/**
 * Annotate the active X-Ray segment/subsegment from a carried TraceContext
 * (stable annotation-key contract — the waterfall-viewer story consumes
 * these keys, see design). No-op when there is no active segment AND
 * no-op when `carried` is undefined/malformed — never throws
 * (property-tested against arbitrary input).
 *
 * Optional identity fields (executionId/nodeId/sessionId) are read off the
 * carried context when present so a single call site can stamp the full
 * annotation set without a second helper invocation.
 */
export function annotateFromCarried(
  carried:
    | (TraceContext & {
        executionId?: string;
        nodeId?: string;
        sessionId?: string;
      })
    | undefined,
): void {
  try {
    const segment = AWSXRay.getSegment();
    if (!segment) {
      return;
    }
    if (carried?.correlationId) {
      segment.addAnnotation("correlation_id", carried.correlationId);
    }
    if (carried?.traceId) {
      segment.addAnnotation("source_trace_id", carried.traceId);
    }
    if (carried?.executionId) {
      segment.addAnnotation("execution_id", carried.executionId);
    }
    if (carried?.nodeId) {
      segment.addAnnotation("node_id", carried.nodeId);
    }
    if (carried?.sessionId) {
      segment.addAnnotation("session_id", carried.sessionId);
    }
    // Additive, nullable (Pass 1, decision f1cbd5ef, design §2 "Carried
    // trace context" row): stamp the server-minted runId when the carried
    // context happens to include one. Absent ⇒ no annotation, same
    // discipline as every other field above.
    if (carried?.runId) {
      segment.addAnnotation("run_id", carried.runId);
    }
    if (carried) {
      segment.addMetadata("trace_context", carried);
    }
  } catch {
    // No-op-safe: annotation failure must never break the consumer.
  }
}

/**
 * Structured-log fields to merge into every log line (stable contract):
 * `trace_id` from the active segment (when present), plus `source_trace_id`
 * lifted from a carried TraceContext (when present). Returns `{}` when
 * neither is available — never throws.
 */
export function logFields(
  carried: TraceContext | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  try {
    const active = getActiveTraceContext();
    if (active?.traceId) {
      fields.trace_id = active.traceId;
    }
  } catch {
    // No-op-safe.
  }
  if (carried?.traceId) {
    fields.source_trace_id = carried.traceId;
  }
  return fields;
}
