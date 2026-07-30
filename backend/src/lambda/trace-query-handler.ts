/**
 * Trace Query Handler — read-only Lambda (HTTP API payload format 2.0)
 * branching on `routeKey` for the 3 waterfall-trace-viewer routes (design
 * §2 "Routes", §1 "AUTHORIZATION DECISION"):
 *   GET /traces/by-execution/{executionId}      # ownership-gated
 *   GET /traces/by-conversation/{conversationId} # ownership-gated (-> project -> org)
 *   GET /traces/{traceId}                         # admin-only
 *
 * BINDING INVARIANTS (design §6), enforced in this file:
 *   1. No X-Ray call is ever issued before the entry-key org check passes
 *      (403 short-circuits first) — except /traces/{traceId}, which
 *      requires admin first. Structurally guaranteed here: every branch
 *      calls resolveExecutionOwnership/resolveConversationOwnership (or
 *      checks isAdminFromHttpEvent for the raw-id route) and returns on
 *      failure BEFORE the xrayClient.send(...) call is reached.
 *   2. /traces/{traceId} is unreachable for non-admins (403), always.
 *   3. IAM role (telemetry-stack.ts) holds exactly the 2 read-only X-Ray
 *      actions + table read grants — zero write, enforced at the
 *      infrastructure layer, not here.
 *   4. Segment-Document parsing never throws (xray-waterfall.ts).
 *   5. Response is field-allowlisted (xray-waterfall.ts,
 *      includeMetadata gated to admin + explicit opt-in below).
 *   6. Filter expression exactly `annotation.correlation_id = "<id>"`
 *      (xray-filter.ts).
 *   7. Zero new frontend/CDK config — reuses costHttpApi (telemetry-stack.ts).
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

const xrayClient = new XRayClient({});

/** Zero summaries within this window after entry completion -> "indexing"
 * (still likely propagating through X-Ray's eventual-consistency window),
 * not "empty" (design §2 status freshness semantics). */
const FRESHNESS_WINDOW_MS = 90_000;
/** Default lookback window when the caller supplies no ?from/&to. */
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** BatchGetTraces accepts at most 5 trace ids per call. */
const BATCH_GET_TRACES_MAX_IDS = 5;

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
    // they did, fail closed rather than issue an X-Ray call.
    return notFound();
  }

  const params = qsp(event);
  const { fromIso, toIso } = resolveWindow(params);
  const isAdmin = isAdminFromHttpEvent(event);
  const includeMetadata = isAdmin && params.includeMetadata === "1";

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
