/**
 * Tests for trace-query-handler.ts — the 3-route waterfall trace viewer
 * Lambda (design §1 "Authorization matrix", §2 "Routes",
 * §2 "status freshness semantics").
 *
 * AUTHORIZATION PROPERTY TESTS (binding, invariant 1 + 2):
 *   - same-org non-admin -> 200
 *   - cross-org non-admin -> 403, asserted BEFORE any X-Ray call (spy proves
 *     zero X-Ray SDK invocations on the 403 path)
 *   - admin cross-org -> 200
 *   - non-admin /traces/{traceId} -> 403 always (no ownership path exists)
 *   - admin /traces/{traceId} -> 200
 *   - indexing vs empty freshness logic
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  XRayClient,
  GetTraceSummariesCommand,
  BatchGetTracesCommand,
} from "@aws-sdk/client-xray";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

const ddbMock = mockClient(DynamoDBDocumentClient);
const xrayMock = mockClient(XRayClient);
const logsMock = mockClient(CloudWatchLogsClient);

beforeEach(() => {
  ddbMock.reset();
  xrayMock.reset();
  logsMock.reset();
  process.env.EXECUTIONS_TABLE = "executions-test";
  process.env.CONVERSATIONS_TABLE = "conversations-test";
  process.env.PROJECTS_TABLE = "projects-test";
  process.env.ENVIRONMENT = "test";
  // TRACE_BACKEND intentionally left unset in the base beforeEach — the
  // default-xray dispatch (design §3 "SIMPLEST safe option") must hold for
  // every pre-existing test above without them opting in. Tests in the
  // new "TRACE_BACKEND=spans dispatch" describe block below set it
  // explicitly per-test.
  delete process.env.TRACE_BACKEND;
  // Keeps the poll-budget-exhausted test (below) fast and deterministic —
  // spans-query.ts's runSpanQuery reads these as overridable poll tuning,
  // defaulting to 500ms/40 attempts (~20s) in production.
  process.env.SPANS_QUERY_POLL_INTERVAL_MS = "0";
  process.env.SPANS_QUERY_MAX_POLL_ATTEMPTS = "3";
});

import { handler } from "../trace-query-handler";

function makeEvent(
  routeKey: string,
  pathParameters: Record<string, string>,
  claims: Record<string, unknown>,
  queryStringParameters: Record<string, string> = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    routeKey,
    pathParameters,
    queryStringParameters,
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function recentIso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

describe("GET /traces/by-execution/{executionId} — ownership authorization", () => {
  test("same-org non-admin -> 200, and X-Ray IS called (after the ownership check passes)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-1",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(xrayMock.calls().length).toBeGreaterThan(0);
  });

  test("cross-org non-admin -> 403 BEFORE any X-Ray call (spy proves zero X-Ray invocations)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-2",
        orgId: "org-OTHER",
        completedAt: recentIso(5),
      },
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-2" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    // The binding assertion: no X-Ray SDK call was ever made on this path.
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("admin cross-org -> 200 (admin may view any org's execution trace)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-3",
        orgId: "org-OTHER",
        completedAt: recentIso(5),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-3" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
  });

  test("missing custom:organization claim -> 403 before any X-Ray call", async () => {
    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-4" },
      {},
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(xrayMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test("unknown executionId -> 404", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "does-not-exist" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(xrayMock.calls()).toHaveLength(0);
  });
});

describe("GET /traces/by-conversation/{conversationId} — ownership via project->org", () => {
  test("same-org non-admin -> 200", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", orgId: "org-1", updatedAt: recentIso(5) },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      { conversationId: "proj-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
  });

  test("cross-org non-admin -> 403 before any X-Ray call", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-2", orgId: "org-OTHER", updatedAt: recentIso(5) },
    });

    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      { conversationId: "proj-2" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(xrayMock.calls()).toHaveLength(0);
  });
});

describe("GET /traces/{traceId} — admin-only (invariant 2)", () => {
  test("non-admin -> 403 always, regardless of org, no X-Ray call", async () => {
    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-000000000000000000000001" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(xrayMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test("admin -> 200, X-Ray IS called", async () => {
    xrayMock.on(BatchGetTracesCommand).resolves({ Traces: [] });

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-000000000000000000000001" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(xrayMock.calls().length).toBeGreaterThan(0);
  });

  test("admin missing org claim -> still 403 (org claim is required on every route)", async () => {
    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-000000000000000000000001" },
      { "custom:role": "admin" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });
});

describe("indexing vs empty freshness logic (design §2 status semantics)", () => {
  test("zero summaries + entry completed within freshness window (~90s) -> status:indexing", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-fresh",
        orgId: "org-1",
        completedAt: recentIso(10),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-fresh" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("indexing");
  });

  test("zero summaries + entry older than the freshness window -> status:empty", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-old",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-old" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
  });

  test(">=1 summary -> status:ready", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-ready",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({
      TraceSummaries: [{ Id: "1-5f84c7c1-000000000000000000000001" }],
    });
    xrayMock.on(BatchGetTracesCommand).resolves({
      Traces: [
        {
          Id: "1-5f84c7c1-000000000000000000000001",
          Segments: [],
        },
      ],
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-ready" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ready");
  });
});

describe("unknown route", () => {
  test("returns 404", async () => {
    const event = makeEvent(
      "GET /traces/unknown-shape",
      {},
      { "custom:organization": "org-1" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });
});

describe("runId-primary correlation (Pass 2, design §4)", () => {
  test("execution row WITH runId -> filters by annotation.run_id, linkedBy:run_id", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-runid",
        orgId: "org-1",
        completedAt: recentIso(5),
        runId: "run-11111111-1111-1111-1111-111111111111",
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-runid" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.linkedBy).toBe("run_id");
    expect(body.query.runId).toBe("run-11111111-1111-1111-1111-111111111111");

    const summariesCall = xrayMock
      .calls()
      .find((c) => c.args[0] instanceof GetTraceSummariesCommand);
    expect(summariesCall).toBeDefined();
    const input = (summariesCall!.args[0] as GetTraceSummariesCommand).input;
    expect(input.FilterExpression).toBe(
      'annotation.run_id = "run-11111111-1111-1111-1111-111111111111"',
    );
  });

  test("execution row WITHOUT runId (pre-runId data) -> falls back to annotation.correlation_id, linkedBy:correlation_id, response never breaks", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-legacy",
        orgId: "org-1",
        completedAt: recentIso(5),
        // no runId field at all — pre-runId row.
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-legacy" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.linkedBy).toBe("correlation_id");
    expect(body.query.runId).toBeNull();

    const summariesCall = xrayMock
      .calls()
      .find((c) => c.args[0] instanceof GetTraceSummariesCommand);
    expect(summariesCall).toBeDefined();
    const input = (summariesCall!.args[0] as GetTraceSummariesCommand).input;
    expect(input.FilterExpression).toBe(
      'annotation.correlation_id = "exec-legacy"',
    );
  });

  test("conversation row WITH runId on the project record is absent (projects table has no runId) -> falls back cleanly, no throw", async () => {
    // Conversations resolve ownership via the PROJECTS table (no runId
    // column there); this asserts the fallback path never breaks the
    // response shape when runId is simply not present on the ownership row.
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-runid", orgId: "org-1", updatedAt: recentIso(5) },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      { conversationId: "proj-runid" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.linkedBy).toBe("correlation_id");
  });
});

describe("unhandled X-Ray error", () => {
  test("500 on X-Ray throw, never leaks the raw error to the client", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-boom",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    xrayMock
      .on(GetTraceSummariesCommand)
      .rejects(new Error("xray unavailable"));

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-boom" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("xray unavailable");
  });
});

describe("TRACE_BACKEND=spans dispatch (design §3 dual-backend, §1 query mechanism)", () => {
  test("TRACE_BACKEND unset -> defaults to xray path (zero CloudWatch Logs calls)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-default",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-default" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(xrayMock.calls().length).toBeGreaterThan(0);
    expect(logsMock.calls()).toHaveLength(0);
  });

  test("TRACE_BACKEND=spans -> ownership gate still runs BEFORE any Logs Insights call (cross-org 403, zero logs calls)", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-x",
        orgId: "org-OTHER",
        completedAt: recentIso(5),
      },
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-x" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(logsMock.calls()).toHaveLength(0);
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("TRACE_BACKEND=spans, same-org -> 200, StartQuery/GetQueryResults called, zero X-Ray calls", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-1",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h1" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-1" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(logsMock.calls().length).toBeGreaterThan(0);
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("TRACE_BACKEND=spans, query Complete with rows -> status:ready, response shape unchanged", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-ready",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h2" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [
          { field: "traceId", value: "1-5f84c7c1-000000000000000000000001" },
          { field: "spanId", value: "root-1" },
          { field: "name", value: "root-op" },
          { field: "startTimeUnixNano", value: "1000000000000" },
          { field: "endTimeUnixNano", value: "1001000000000" },
        ],
      ],
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-ready" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ready");
    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("linkedBy");
    expect(body).toHaveProperty("traces");
    expect(body).toHaveProperty("truncated");
    expect(body).toHaveProperty("meta");
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].traceId).toBe("1-5f84c7c1-000000000000000000000001");
  });

  test("TRACE_BACKEND=spans, query Complete with zero rows + entry fresh -> status:indexing", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-fresh",
        orgId: "org-1",
        completedAt: recentIso(10),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h3" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-fresh" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("indexing");
  });

  test("TRACE_BACKEND=spans, query Complete with zero rows + entry stale -> status:empty", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-stale",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h4" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-stale" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
  });

  test("TRACE_BACKEND=spans, query still Running when poll budget exhausted -> status:indexing (NOT empty, NOT 5xx) — design §1 new case", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      // Entry is OLD (outside freshness window) — proves the mapping is
      // driven by query-incomplete, not by the freshness-window fallback.
      Item: {
        executionId: "exec-spans-incomplete",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h5" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Running", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-incomplete" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("indexing");
  }, 15000);

  test("TRACE_BACKEND=spans, GetQueryResults throws -> 500, never leaks the raw error", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-boom",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h6" });
    logsMock
      .on(GetQueryResultsCommand)
      .rejects(new Error("LimitExceededException"));

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-boom" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("LimitExceededException");
  });

  test("TRACE_BACKEND=spans, runId present on ownership row -> Logs Insights query targets annotation.run_id, linkedBy:run_id", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-spans-runid",
        orgId: "org-1",
        completedAt: recentIso(5),
        runId: "run-22222222-2222-2222-2222-222222222222",
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h7" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-spans-runid" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    const body = JSON.parse(res.body!);
    expect(body.linkedBy).toBe("run_id");

    const startCall = logsMock
      .calls()
      .find((c) => c.args[0] instanceof StartQueryCommand);
    expect(startCall).toBeDefined();
    const input = (startCall!.args[0] as StartQueryCommand).input;
    expect(input.queryString).toContain(
      'filter `annotation.run_id` = "run-22222222-2222-2222-2222-222222222222"',
    );
  });

  test("TRACE_BACKEND=spans, admin raw traceId route queries aws/spans by traceId, response shape unchanged", async () => {
    process.env.TRACE_BACKEND = "spans";
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-h8" });
    logsMock.on(GetQueryResultsCommand).resolves({
      status: "Complete",
      results: [
        [
          { field: "traceId", value: "1-5f84c7c1-000000000000000000000002" },
          { field: "spanId", value: "root-2" },
          { field: "name", value: "root-op-2" },
          { field: "startTimeUnixNano", value: "1000000000000" },
          { field: "endTimeUnixNano", value: "1001000000000" },
        ],
      ],
    });

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-000000000000000000000002" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ready");
    expect(body.traces).toHaveLength(1);
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("TRACE_BACKEND=spans, non-admin raw traceId route -> still 403, zero Logs Insights calls (invariant 2 unchanged)", async () => {
    process.env.TRACE_BACKEND = "spans";

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-000000000000000000000003" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(logsMock.calls()).toHaveLength(0);
  });
});

describe("route param validation (400 arms) + non-Error throw path", () => {
  test("by-execution with no executionId path param -> 400", async () => {
    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      {},
      { "custom:organization": "org-1" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("executionId is required");
  });

  test("by-conversation with no conversationId path param -> 400", async () => {
    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      {},
      { "custom:organization": "org-1" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("conversationId is required");
  });

  test("raw traceId route with no traceId path param -> 400", async () => {
    const event = makeEvent(
      "GET /traces/{traceId}",
      {},
      { "custom:organization": "org-1", "custom:role": "admin" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("traceId is required");
  });

  test("by-conversation with missing org claim -> 403 before any DDB/X-Ray call", async () => {
    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      { conversationId: "proj-noclaim" },
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(ddbMock.calls()).toHaveLength(0);
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("by-conversation with unknown project id -> 404, no X-Ray call", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent(
      "GET /traces/by-conversation/{conversationId}",
      { conversationId: "proj-unknown" },
      { "custom:organization": "org-1" },
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("non-Error rejection (plain string) -> 500 via String(err) arm, no leak", async () => {
    ddbMock
      .on(GetCommand)
      .callsFake(() => Promise.reject("plain-string-rejection"));
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const event = makeEvent(
        "GET /traces/by-execution/{executionId}",
        { executionId: "exec-string-throw" },
        { "custom:organization": "org-1" },
      );
      const res = await handler(event);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("plain-string-rejection");
      expect(JSON.parse(res.body!)).toEqual({ error: "Internal server error" });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("X-Ray path — remaining freshness/window/response arms", () => {
  test("explicit ?from&to window is passed through to GetTraceSummaries", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { executionId: "exec-window", orgId: "org-1" },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const fromIso = "2026-07-30T00:00:00.000Z";
    const toIso = "2026-07-30T06:00:00.000Z";
    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-window" },
      { "custom:organization": "org-1" },
      { from: fromIso, to: toIso },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const summariesCall = xrayMock
      .calls()
      .find((c) => c.args[0] instanceof GetTraceSummariesCommand);
    expect(summariesCall).toBeDefined();
    const input = (summariesCall!.args[0] as GetTraceSummariesCommand).input;
    expect(input.StartTime).toEqual(new Date(fromIso));
    expect(input.EndTime).toEqual(new Date(toIso));
  });

  test("ownership row with NO completedAt + zero summaries -> status:empty (missing-timestamp arm)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { executionId: "exec-nots", orgId: "org-1" },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-nots" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).status).toBe("empty");
  });

  test("ownership row with a NON-PARSEABLE completedAt + zero summaries -> status:empty (NaN-timestamp arm)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-nan",
        orgId: "org-1",
        completedAt: "not-a-timestamp",
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({ TraceSummaries: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-nan" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).status).toBe("empty");
  });

  test("GetTraceSummaries response with NO TraceSummaries key -> treated as zero summaries, never throws", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-nokey",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({});

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-nokey" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
    expect(body.traces).toEqual([]);
  });

  test("BatchGetTraces response with NO Traces key -> ready (summary existed) with zero shaped traces, never throws", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-batch-nokey",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    xrayMock.on(GetTraceSummariesCommand).resolves({
      TraceSummaries: [{ Id: "1-5f84c7c1-00000000000000000000000a" }],
    });
    xrayMock.on(BatchGetTracesCommand).resolves({});

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-batch-nokey" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ready");
    expect(body.traces).toEqual([]);
  });

  test("non-allowlisted executionId (quote-bearing) on the xray path -> defensive empty result, ZERO X-Ray calls (filter.ok=false arm)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: 'exec-"evil',
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: 'exec-"evil' },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    // Zero summaries + fresh entry -> indexing via the freshness fallback.
    expect(body.status).toBe("indexing");
    expect(body.traces).toEqual([]);
    expect(body.linkedBy).toBe("correlation_id");
    // The binding assertion: no unsafe FilterExpression was ever built/sent.
    expect(xrayMock.calls()).toHaveLength(0);
  });

  test("admin raw traceId route (xray) with a returned trace -> status:ready", async () => {
    xrayMock.on(BatchGetTracesCommand).resolves({
      Traces: [{ Id: "1-5f84c7c1-00000000000000000000000b", Segments: [] }],
    });

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-00000000000000000000000b" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).status).toBe("ready");
  });

  test("admin raw traceId route (xray) with NO Traces key in response AND no queryStringParameters at all -> empty, never throws", async () => {
    xrayMock.on(BatchGetTracesCommand).resolves({});

    // Built inline (not via makeEvent) so queryStringParameters is truly
    // absent — exercises the `queryStringParameters ?? {}` fallback arm.
    const event = {
      routeKey: "GET /traces/{traceId}",
      pathParameters: { traceId: "1-5f84c7c1-00000000000000000000000c" },
      requestContext: {
        authorizer: {
          jwt: {
            claims: { "custom:organization": "org-1", "custom:role": "admin" },
            scopes: null,
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
    expect(body.traces).toEqual([]);
  });
});

describe("TRACE_BACKEND=spans — defensive filter rejects, failed-status mapping, poll-env defaults, truncated, includeMetadata", () => {
  test("spans: non-allowlisted correlationId (quote-bearing executionId, no runId) -> defensive 200, linkedBy:correlation_id, runId:null, ZERO Logs Insights calls", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: 'exec-"spans-evil',
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: 'exec-"spans-evil' },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("indexing"); // fresh entry, freshness fallback
    expect(body.linkedBy).toBe("correlation_id");
    expect(body.query.runId).toBeNull();
    expect(body.traces).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.meta).toEqual({ traceCount: 0, spanCount: 0, estimate: false });
    expect(logsMock.calls()).toHaveLength(0);
  });

  test("spans: non-allowlisted runId on the ownership row -> runId still preferred, filter rejected -> defensive 200, linkedBy:run_id, ZERO Logs Insights calls", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-badrunid",
        orgId: "org-1",
        completedAt: recentIso(600),
        runId: 'run-"not allowlisted',
      },
    });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-badrunid" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty"); // stale entry, freshness fallback
    expect(body.linkedBy).toBe("run_id");
    expect(body.query.runId).toBe('run-"not allowlisted');
    expect(body.traces).toEqual([]);
    expect(logsMock.calls()).toHaveLength(0);
  });

  test("spans: admin raw traceId route with non-allowlisted traceId -> defensive 200 empty, ZERO Logs Insights calls", async () => {
    process.env.TRACE_BACKEND = "spans";

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: 'bad"trace|id' },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
    expect(body.traces).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.meta).toEqual({ traceCount: 0, spanCount: 0, estimate: false });
    expect(logsMock.calls()).toHaveLength(0);
  });

  test("spans: admin raw traceId route, query Complete with zero rows -> status:empty", async () => {
    process.env.TRACE_BACKEND = "spans";
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-raw-empty" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-00000000000000000000000d" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("empty");
    expect(body.traces).toEqual([]);
  });

  test("spans: query FAILED terminal status + fresh entry -> freshness-window fallback -> status:indexing (design §1 failed mapping)", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-failed-fresh",
        orgId: "org-1",
        completedAt: recentIso(10),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-failed-1" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Failed", results: [] });
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const event = makeEvent(
        "GET /traces/by-execution/{executionId}",
        { executionId: "exec-failed-fresh" },
        { "custom:organization": "org-1" },
      );

      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!).status).toBe("indexing");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("spans: query FAILED terminal status + stale entry -> freshness-window fallback -> status:empty (never a 5xx)", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-failed-stale",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-failed-2" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Cancelled", results: [] });
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const event = makeEvent(
        "GET /traces/by-execution/{executionId}",
        { executionId: "exec-failed-stale" },
        { "custom:organization": "org-1" },
      );

      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!).status).toBe("empty");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("spans: poll-tuning env vars UNSET -> undefined passed through (runSpanQuery defaults apply), first-poll Complete still returns immediately", async () => {
    process.env.TRACE_BACKEND = "spans";
    delete process.env.SPANS_QUERY_POLL_INTERVAL_MS;
    delete process.env.SPANS_QUERY_MAX_POLL_ATTEMPTS;
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-env-default",
        orgId: "org-1",
        completedAt: recentIso(600),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-env" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-env-default" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).status).toBe("empty");
    expect(logsMock.calls().length).toBeGreaterThan(0);
  });

  test("spans: row count hitting the query row limit -> truncated:true on the response", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-truncated",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    // SPANS_QUERY_ROW_LIMIT is 1000 — return exactly 1000 rows so
    // runSpanQuery reports truncated (rows.length >= limit).
    const results = Array.from({ length: 1000 }, (_, i) => [
      { field: "traceId", value: "1-5f84c7c1-00000000000000000000000e" },
      { field: "spanId", value: `span-${i}` },
      { field: "name", value: `op-${i}` },
      { field: "startTimeUnixNano", value: "1000000000000" },
      { field: "endTimeUnixNano", value: "1001000000000" },
    ]);
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-trunc" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-truncated" },
      { "custom:organization": "org-1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.status).toBe("ready");
    expect(body.truncated).toBe(true);
    expect(body.meta.spanCount).toBe(1000);
  });

  const metadataRow = [
    { field: "traceId", value: "1-5f84c7c1-00000000000000000000000f" },
    { field: "spanId", value: "meta-span-1" },
    { field: "name", value: "meta-op" },
    { field: "startTimeUnixNano", value: "1000000000000" },
    { field: "endTimeUnixNano", value: "1001000000000" },
    { field: "attributes.custom.stage", value: "prod" },
  ];

  test("spans: includeMetadata=1 as ADMIN -> metadata bag included on spans (admin + explicit opt-in honored)", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-meta-admin",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-meta-1" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [metadataRow] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-meta-admin" },
      { "custom:organization": "org-1", "custom:role": "admin" },
      { includeMetadata: "1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.traces[0].spans[0].metadata).toEqual({
      "attributes.custom.stage": "prod",
    });
  });

  test("spans: includeMetadata=1 as NON-ADMIN -> ignored, metadata never leaves the Lambda (invariant 5 gating)", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-meta-user",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-meta-2" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [metadataRow] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-meta-user" },
      { "custom:organization": "org-1" },
      { includeMetadata: "1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.traces[0].spans[0].metadata).toBeUndefined();
    expect(res.body).not.toContain("attributes.custom.stage");
  });

  test("spans: ADMIN without the explicit includeMetadata opt-in -> metadata still withheld", async () => {
    process.env.TRACE_BACKEND = "spans";
    ddbMock.on(GetCommand).resolves({
      Item: {
        executionId: "exec-meta-noopt",
        orgId: "org-1",
        completedAt: recentIso(5),
      },
    });
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-meta-3" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [metadataRow] });

    const event = makeEvent(
      "GET /traces/by-execution/{executionId}",
      { executionId: "exec-meta-noopt" },
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.traces[0].spans[0].metadata).toBeUndefined();
  });

  test("spans: admin raw traceId route honors includeMetadata=1 (raw-route gating arm)", async () => {
    process.env.TRACE_BACKEND = "spans";
    logsMock.on(StartQueryCommand).resolves({ queryId: "q-meta-4" });
    logsMock
      .on(GetQueryResultsCommand)
      .resolves({ status: "Complete", results: [metadataRow] });

    const event = makeEvent(
      "GET /traces/{traceId}",
      { traceId: "1-5f84c7c1-00000000000000000000000f" },
      { "custom:organization": "org-1", "custom:role": "admin" },
      { includeMetadata: "1" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.traces[0].spans[0].metadata).toEqual({
      "attributes.custom.stage": "prod",
    });
  });
});
