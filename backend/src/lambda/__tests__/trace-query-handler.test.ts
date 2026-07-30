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
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

const ddbMock = mockClient(DynamoDBDocumentClient);
const xrayMock = mockClient(XRayClient);

beforeEach(() => {
  ddbMock.reset();
  xrayMock.reset();
  process.env.EXECUTIONS_TABLE = "executions-test";
  process.env.CONVERSATIONS_TABLE = "conversations-test";
  process.env.PROJECTS_TABLE = "projects-test";
  process.env.ENVIRONMENT = "test";
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
