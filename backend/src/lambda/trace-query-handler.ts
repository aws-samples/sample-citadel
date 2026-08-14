/**
 * Trace Query Handler — read-only Lambda (HTTP API payload format 2.0)
 * branching on `routeKey` for the 3 waterfall-trace-viewer routes (design
 * §2 "Routes", §1 "AUTHORIZATION DECISION"):
 *   GET /traces/by-execution/{executionId}      # ownership-gated
 *   GET /traces/by-conversation/{conversationId} # ownership-gated (-> project -> org)
 *   GET /traces/{traceId}                         # admin-only
 *
 * BINDING INVARIANTS (design §6), enforced in this file:
 *   1. No X-Ray/Logs-Insights call is ever issued before the entry-key
 *      org check passes (403 short-circuits first) — except
 *      /traces/{traceId}, which requires admin first. Structurally
 *      guaranteed here: every branch calls
 *      resolveExecutionOwnership/resolveConversationOwnership (or checks
 *      isAdminFromHttpEvent for the raw-id route) and returns on failure
 *      BEFORE any backend query is reached.
 *   2. /traces/{traceId} is unreachable for non-admins (403), always.
 *   3. IAM role (telemetry-stack.ts) holds exactly the read-only X-Ray +
 *      Logs Insights actions + table read grants — zero write, enforced
 *      at the infrastructure layer, not here.
 *   4. Segment/span parsing never throws (xray-waterfall.ts /
 *      spans-waterfall.ts).
 *   5. Response is field-allowlisted (xray-waterfall.ts /
 *      spans-waterfall.ts, includeMetadata gated to admin + explicit
 *      opt-in below).
 *   6. Filter expression exactly `annotation.correlation_id = "<id>"`
 *      (xray-filter.ts) / the Logs Insights equivalent (trace-span-query.ts).
 *   7. Zero new frontend/CDK config — reuses costHttpApi (telemetry-stack.ts).
 *
 * DUAL-BACKEND DISPATCH (design §3 "SIMPLEST safe option", pass 2):
 *   `TRACE_BACKEND` env var (`xray`|`spans`, DEFAULT `xray`) selects the
 *   fetch+parse path. Both backends emit the identical response object —
 *   the frontend cannot tell which one produced it. Defaulting to `xray`
 *   means this port ships with NO behavior change until an operator
 *   flips the env var post-cutover (Transaction Search enabled
 *   account-wide) — see docs/TRACING_RUNBOOK.md.
 */
import {
  XRayClient,
  GetTraceSummariesCommand,
  BatchGetTracesCommand,
} from "@aws-sdk/client-xray";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import {
  badRequest,
  forbidden,
  json,
  notFound,
  extractOrgFromHttpEvent,
  isAdminFromHttpEvent,
  resolveExecutionOwnership,
  resolveConversationOwnership,
  type HttpResponse,
  type OwnershipResult,
} from "./utils/trace-http-shared";
import { buildCorrelationFilter, buildRunIdFilter } from "./utils/xray-filter";
import { shapeTraces, type XRayTraceLike } from "./utils/xray-waterfall";
import {
  buildSpanCorrelationFilter,
  buildSpanRunIdFilter,
} from "./utils/trace-span-query";
import { runSpanQuery, type SpanQueryStatus } from "./utils/spans-query";
import { shapeSpanRows, type SpanQueryRowLike } from "./utils/spans-waterfall";

const xrayClient = new XRayClient({});

/** `xray` (default — today's behavior, unchanged) or `spans` (Transaction
 * Search / Logs Insights over aws/spans, design §3). Read once per cold
 * start; a warm invocation reflects whatever the env held at that
 * cold-start snapshot, matching how every other env-driven Lambda config
 * in this codebase (e.g. AGENT_MODEL in services-stack.ts) is read. */
/** Matches an X-Ray-format trace id: `1-{8hex}-{24hex}` (e.g.
 * `1-5f84c7c1-000000000000000000000001`). */
const XRAY_TRACE_ID_RE = /^1-([0-9a-f]{8})-([0-9a-f]{24})$/i;

/**
 * Normalizes an X-Ray-format traceId (`1-{8hex}-{24hex}`) to the plain
 * 32-hex form aws/spans stores its `traceId` field as (verified: all
 * sampled aws/spans traceIds are 32-hex with no `1-` prefix — evidence
 * report finding a3d8a2ea, verdict #1). Any other shape (already 32-hex,
 * or unrecognized) is passed through unchanged, so existing links minted
 * before this normalization, and ids that are already in the spans-native
 * form, keep working identically.
 */
export function normalizeToSpansTraceId(traceId: string): string {
  const match = XRAY_TRACE_ID_RE.exec(traceId);
  if (!match) return traceId;
  return `${match[1]}${match[2]}`;
}

function traceBackend(): "xray" | "spans" {
  return process.env.TRACE_BACKEND === "spans" ? "spans" : "xray";
}

/** The aws/spans log group Transaction Search writes to (design §1, §4). */
const SPANS_LOG_GROUP = "aws/spans";

/** Zero summaries within this window after entry completion -> "indexing"
 * (still likely propagating through X-Ray's eventual-consistency window),
 * not "empty" (design §2 status freshness semantics). Reused unchanged
 * for the spans backend — Transaction Search ingestion lag makes this
 * window MORE relevant, not less (design §1). */
const FRESHNESS_WINDOW_MS = 90_000;
/** Default lookback window when the caller supplies no ?from/&to. */
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** BatchGetTraces accepts at most 5 trace ids per call. */
const BATCH_GET_TRACES_MAX_IDS = 5;
/** Row cap per Logs Insights query — mirrors the `truncated` semantics
 * BatchGetTraces' 5-id paging notion served for the X-Ray path
 * (design §1 "truncated"). */
const SPANS_QUERY_ROW_LIMIT = 1000;

function qsp(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Record<string, string | undefined> {
  return event.queryStringParameters ?? {};
}

function resolveWindow(params: Record<string, string | undefined>): {
  fromIso: string;
  toIso: string;
} {
  if (params.from && params.to) {
    return { fromIso: params.from, toIso: params.to };
  }
  const to = new Date();
  const from = new Date(to.getTime() - DEFAULT_WINDOW_MS);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/**
 * Fetches trace summaries by correlation-id filter, then batch-fetches
 * full segment documents for the matched trace ids. Never issued unless
 * the caller has already passed the ownership/admin gate (invariant 1) —
 * this function itself performs no authorization, by design, so that
 * check is visibly separate at each call site below.
 *
 * PASS 2 (design §4 "trace-viewer workflowId fallback -> runId-PRIMARY
 * correlation where runId is present"): when the ownership row carried a
 * runId, filter by `annotation.run_id` instead of `annotation.correlation_id`
 * — additive/nullable, never breaking: a pre-runId row (no `runId` on the
 * ownership result) falls back to the existing `correlation_id` filter
 * unchanged.
 */
async function fetchTracesByCorrelationId(
  correlationId: string,
  runId: string | undefined,
  fromIso: string,
  toIso: string,
): Promise<{
  traces: XRayTraceLike[];
  summaryCount: number;
  linkedBy: "run_id" | "correlation_id";
}> {
  const preferRunId = typeof runId === "string" && runId.length > 0;
  const filter = preferRunId
    ? buildRunIdFilter(runId!)
    : buildCorrelationFilter(correlationId);
  const linkedBy: "run_id" | "correlation_id" = preferRunId
    ? "run_id"
    : "correlation_id";

  if (!filter.ok) {
    // Should be unreachable: correlationId is always our own
    // executionId/projectId (allowlist-shaped by construction) and runId
    // is always our own `run-<uuidv4>` (also allowlist-shaped). Defensive:
    // treat as "no traces" rather than building an unsafe expression.
    return { traces: [], summaryCount: 0, linkedBy };
  }

  const summariesResult = await xrayClient.send(
    new GetTraceSummariesCommand({
      StartTime: new Date(fromIso),
      EndTime: new Date(toIso),
      FilterExpression: filter.expression,
    }),
  );

  const traceIds = (summariesResult.TraceSummaries ?? [])
    .map((s) => s.Id)
    .filter((id): id is string => typeof id === "string");

  if (traceIds.length === 0) {
    return { traces: [], summaryCount: 0, linkedBy };
  }

  const traces: XRayTraceLike[] = [];
  for (let i = 0; i < traceIds.length; i += BATCH_GET_TRACES_MAX_IDS) {
    const page = traceIds.slice(i, i + BATCH_GET_TRACES_MAX_IDS);
    const batchResult = await xrayClient.send(
      new BatchGetTracesCommand({ TraceIds: page }),
    );
    for (const t of batchResult.Traces ?? []) {
      traces.push(t as XRayTraceLike);
    }
  }

  return { traces, summaryCount: traceIds.length, linkedBy };
}

function freshnessStatus(
  summaryCount: number,
  entryTimestampIso: string | undefined,
): "ready" | "indexing" | "empty" {
  if (summaryCount > 0) return "ready";
  if (!entryTimestampIso) return "empty";
  const entryTime = new Date(entryTimestampIso).getTime();
  if (Number.isNaN(entryTime)) return "empty";
  const ageMs = Date.now() - entryTime;
  return ageMs <= FRESHNESS_WINDOW_MS ? "indexing" : "empty";
}

/**
 * Runs the Logs Insights `aws/spans` query for the given filter clause,
 * shapes the result rows into the SAME TraceEntry[]/TraceSpan[] the X-Ray
 * path produces, and maps the query's terminal state onto the existing
 * ready|indexing|empty enum (design §1 "Mapping onto the existing
 * ready|indexing|empty ... freshness enum").
 *
 * Poll tuning is read from env with production-safe defaults so tests can
 * override it without real 20s waits (spans-query.ts's runSpanQuery
 * accepts these as options; undefined falls through to its own
 * defaults).
 */
async function fetchTracesBySpanFilter(
  filterClause: string,
  fromIso: string,
  toIso: string,
): Promise<{
  traces: SpanQueryRowLike[];
  queryStatus: SpanQueryStatus;
  truncated: boolean;
}> {
  const pollIntervalMs = process.env.SPANS_QUERY_POLL_INTERVAL_MS
    ? Number(process.env.SPANS_QUERY_POLL_INTERVAL_MS)
    : undefined;
  const maxPollAttempts = process.env.SPANS_QUERY_MAX_POLL_ATTEMPTS
    ? Number(process.env.SPANS_QUERY_MAX_POLL_ATTEMPTS)
    : undefined;

  const result = await runSpanQuery({
    logGroupName: SPANS_LOG_GROUP,
    queryString: filterClause,
    startTimeSec: Math.floor(new Date(fromIso).getTime() / 1000),
    endTimeSec: Math.floor(new Date(toIso).getTime() / 1000),
    limit: SPANS_QUERY_ROW_LIMIT,
    pollIntervalMs,
    maxPollAttempts,
  });

  return {
    traces: result.rows,
    queryStatus: result.queryStatus,
    truncated: result.truncated,
  };
}

/**
 * Maps a Logs Insights query's terminal state onto the existing
 * ready|indexing|empty enum (design §1):
 *   - complete + >=1 row -> ready
 *   - complete + 0 rows -> freshness-window fallback (indexing if fresh,
 *     else empty) — same semantics as the X-Ray path's freshnessStatus.
 *   - incomplete (poll budget exhausted while Running/Scheduled) ->
 *     indexing unconditionally (retryable "still working"), NEVER empty,
 *     NEVER a 5xx (design §1 "New case").
 *   - failed (Failed/Cancelled/Timeout) -> fall back to the freshness-
 *     window mapping, same as a 0-row Complete (design §1).
 */
function spanFreshnessStatus(
  queryStatus: SpanQueryStatus,
  rowCount: number,
  entryTimestampIso: string | undefined,
): "ready" | "indexing" | "empty" {
  if (queryStatus === "incomplete") return "indexing";
  if (queryStatus === "complete" && rowCount > 0) return "ready";
  return freshnessStatus(0, entryTimestampIso);
}

async function handleEntryKeyRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  kind: "execution" | "conversation",
  id: string,
  entryTimestampIso: string | undefined,
  ownership: OwnershipResult,
): Promise<HttpResponse> {
  // --- Ownership/authorization check happens in the caller, BEFORE this
  // function is invoked (invariant 1) — this function only proceeds once
  // `ownership.ok === true` has already been confirmed by the caller.
  if (!ownership.ok) {
    // Defensive — callers must never reach here with ok:false, but if
    // they did, fail closed rather than issue a backend query.
    return notFound();
  }

  const params = qsp(event);
  const { fromIso, toIso } = resolveWindow(params);
  const isAdmin = isAdminFromHttpEvent(event);
  const includeMetadata = isAdmin && params.includeMetadata === "1";

  if (traceBackend() === "spans") {
    const preferRunId =
      typeof ownership.runId === "string" && ownership.runId.length > 0;
    const filter = preferRunId
      ? buildSpanRunIdFilter(ownership.runId!)
      : buildSpanCorrelationFilter(ownership.correlationId);
    const linkedBy: "run_id" | "correlation_id" = preferRunId
      ? "run_id"
      : "correlation_id";

    if (!filter.ok) {
      // Mirrors the X-Ray path's defensive reject-first fallback
      // (should be unreachable — see fetchTracesByCorrelationId comment).
      return json(200, {
        query: {
          kind,
          id,
          correlationId: ownership.correlationId,
          runId: ownership.runId ?? null,
        },
        status: freshnessStatus(0, entryTimestampIso),
        linkedBy,
        traces: [],
        truncated: false,
        meta: { traceCount: 0, spanCount: 0, estimate: false },
      });
    }

    const { traces, queryStatus, truncated } = await fetchTracesBySpanFilter(
      filter.clause,
      fromIso,
      toIso,
    );
    const shaped = shapeSpanRows(traces, { includeMetadata });
    const status = spanFreshnessStatus(
      queryStatus,
      shaped.traces.length,
      entryTimestampIso,
    );

    return json(200, {
      query: {
        kind,
        id,
        correlationId: ownership.correlationId,
        runId: ownership.runId ?? null,
      },
      status,
      linkedBy,
      traces: shaped.traces,
      truncated: truncated || shaped.truncated,
      meta: shaped.meta,
    });
  }

  const { traces, summaryCount, linkedBy } = await fetchTracesByCorrelationId(
    ownership.correlationId,
    ownership.runId,
    fromIso,
    toIso,
  );

  const shaped = shapeTraces(traces, { includeMetadata });
  const status = freshnessStatus(summaryCount, entryTimestampIso);

  return json(200, {
    query: {
      kind,
      id,
      correlationId: ownership.correlationId,
      runId: ownership.runId ?? null,
    },
    status,
    linkedBy,
    traces: shaped.traces,
    truncated: shaped.truncated,
    meta: shaped.meta,
  });
}

async function handleByExecution(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const executionId = event.pathParameters?.executionId;
  if (!executionId) return badRequest("executionId is required");

  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  // Ownership check happens BEFORE any X-Ray call (invariant 1): resolve
  // the execution's owning org first, then gate.
  const ownership = await resolveExecutionOwnership(executionId);
  if (!ownership.ok) return notFound();

  const isAdmin = isAdminFromHttpEvent(event);
  if (ownership.orgId !== claimOrg && !isAdmin) {
    // 403 BEFORE any X-Ray call — no fetchTracesByCorrelationId reached.
    return forbidden();
  }

  const executionRecord = ownership.entryTimestamp;
  return handleEntryKeyRoute(
    event,
    "execution",
    executionId,
    executionRecord,
    ownership,
  );
}

async function handleByConversation(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const conversationId = event.pathParameters?.conversationId;
  if (!conversationId) return badRequest("conversationId is required");

  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  const ownership = await resolveConversationOwnership(conversationId);
  if (!ownership.ok) return notFound();

  const isAdmin = isAdminFromHttpEvent(event);
  if (ownership.orgId !== claimOrg && !isAdmin) {
    return forbidden();
  }

  return handleEntryKeyRoute(
    event,
    "conversation",
    conversationId,
    ownership.entryTimestamp,
    ownership,
  );
}

async function handleRawTraceId(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const traceId = event.pathParameters?.traceId;
  if (!traceId) return badRequest("traceId is required");

  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  // Admin-only, always (invariant 2) — no ownership path exists for a raw
  // trace id, so this check alone gates the X-Ray call.
  if (!isAdminFromHttpEvent(event)) {
    return forbidden();
  }

  const params = qsp(event);
  const includeMetadata = params.includeMetadata === "1";

  if (traceBackend() === "spans") {
    // Raw traceId lookup: filter by traceId directly rather than by
    // annotation — traceId is already allowlist-shaped (X-Ray-compatible
    // form, checked at the route level by the admin gate above, never a
    // user-supplied filter target for annotation purposes here) and is
    // the natural Logs Insights equivalent of BatchGetTraces([traceId]).
    // Old links (minted while TRACE_BACKEND=xray) carry the X-Ray-format
    // `1-{8hex}-{24hex}` id; aws/spans stores plain 32-hex (verified,
    // evidence report finding a3d8a2ea) — normalize before filtering so
    // those links keep resolving under the spans backend too.
    const spansTraceId = normalizeToSpansTraceId(traceId);
    const filter = buildSpanCorrelationFilter(spansTraceId);
    if (!filter.ok) {
      return json(200, {
        query: { kind: "traceId", id: traceId, correlationId: null },
        status: "empty",
        linkedBy: "correlation_id",
        traces: [],
        truncated: false,
        meta: { traceCount: 0, spanCount: 0, estimate: false },
      });
    }
    // Filter on traceId itself, not the correlation-id annotation — build
    // the clause directly rather than reusing the annotation-targeted
    // builder's field name.
    const traceIdClause = `filter traceId = "${spansTraceId}"`;
    const { traces, queryStatus } = await fetchTracesBySpanFilter(
      traceIdClause,
      new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString(),
      new Date().toISOString(),
    );
    const shaped = shapeSpanRows(traces, { includeMetadata });
    const status: "ready" | "empty" =
      queryStatus === "complete" && shaped.traces.length > 0
        ? "ready"
        : "empty";

    return json(200, {
      query: { kind: "traceId", id: traceId, correlationId: null },
      status,
      linkedBy: "correlation_id",
      traces: shaped.traces,
      truncated: shaped.truncated,
      meta: shaped.meta,
    });
  }

  const batchResult = await xrayClient.send(
    new BatchGetTracesCommand({ TraceIds: [traceId] }),
  );
  const traces = (batchResult.Traces ?? []) as XRayTraceLike[];
  const shaped = shapeTraces(traces, { includeMetadata });
  const status = traces.length > 0 ? "ready" : "empty";

  return json(200, {
    query: { kind: "traceId", id: traceId, correlationId: null },
    status,
    linkedBy: "correlation_id",
    traces: shaped.traces,
    truncated: shaped.truncated,
    meta: shaped.meta,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> => {
  try {
    switch (event.routeKey) {
      case "GET /traces/by-execution/{executionId}":
        return await handleByExecution(event);
      case "GET /traces/by-conversation/{conversationId}":
        return await handleByConversation(event);
      case "GET /traces/{traceId}":
        return await handleRawTraceId(event);
      default:
        return notFound();
    }
  } catch (err: unknown) {
    console.error("trace-query-handler: unhandled error", {
      routeKey: event.routeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }
};
