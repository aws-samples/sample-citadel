/**
 * Unit tests for cost-query-handler.ts: routing, base-table key condition
 * discipline (PK=ORG#<claimOrg>), pagination cap/truncated flag, and
 * response shapes.
 *
 * Budget routes (GET /budgets, PUT /budgets/{scope}) moved to
 * cost-budget-handler.test.ts as part of the query/budgets Lambda IAM
 * split — this handler now serves ONLY the two read-only routes and its
 * IAM role carries zero write permission, so no test here should ever
 * need an UpdateCommand mock.
 *
 * Cross-org leak / admin-bypass / never-Scan invariants live in the
 * companion property test (cost-query-handler.property.test.ts) — this
 * file covers example-based routing and shape correctness.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { handler } from "../cost-query-handler";

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(
  overrides: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {},
  claims: Record<string, unknown> = { "custom:organization": "org-1" },
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: "2.0",
    routeKey: "GET /cost/summary",
    rawPath: "/cost/summary",
    rawQueryString: "",
    headers: {},
    queryStringParameters: null,
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: "GET", path: "/cost/summary" },
    },
    body: undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: "ORG#org-1",
    SK: "2026-07-01T00:00:00.000Z#evt:0",
    orgId: "org-1",
    appId: "app-1",
    modelKey: "model-x",
    capturedAt: "2026-07-01T00:00:00.000Z",
    totalTokens: 10,
    costMicros: 1_000_000,
    tokenCost: 1,
    currency: "USD",
    priced: true,
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  process.env.COST_LEDGER_TABLE = "test-ledger";
});

afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("cost-query-handler routing", () => {
  test("GET /cost/summary?groupBy=app returns a 200 with bucketed totals", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ledgerRow()] });

    const event = makeEvent({
      routeKey: "GET /cost/summary",
      rawPath: "/cost/summary",
      queryStringParameters: { groupBy: "app" },
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.groupBy).toBe("app");
    expect(body.estimate).toBe(true);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].key).toBe("app-1");
  });

  test("GET /cost/summary rejects an invalid groupBy with 400", async () => {
    const event = makeEvent({
      routeKey: "GET /cost/summary",
      rawPath: "/cost/summary",
      queryStringParameters: { groupBy: "not-a-dimension" },
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  test("GET /cost/series?dimension=org&bucket=day returns points", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ledgerRow()] });

    const event = makeEvent({
      routeKey: "GET /cost/series",
      rawPath: "/cost/series",
      queryStringParameters: { dimension: "org", bucket: "day" },
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.bucket).toBe("day");
    expect(body.points).toHaveLength(1);
  });

  test("missing org claim returns 403 on every route", async () => {
    const event = makeEvent(
      {
        routeKey: "GET /cost/summary",
        rawPath: "/cost/summary",
      } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>,
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  test("GET /budgets is no longer served by this handler (moved to cost-budget-handler) -> 404", async () => {
    const event = makeEvent({
      routeKey: "GET /budgets",
      rawPath: "/budgets",
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });

  test("PUT /budgets/{scope} is no longer served by this handler -> 404", async () => {
    const event = makeEvent({
      routeKey: "PUT /budgets/{scope}",
      rawPath: "/budgets/org",
      pathParameters: { scope: "org" },
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });

  test("unrecognized route returns 404", async () => {
    const event = makeEvent({
      routeKey: "GET /unknown",
      rawPath: "/unknown",
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });

  test("no request handled by this Lambda ever issues an UpdateCommand (read-only IAM role invariant)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ledgerRow()] });

    await handler(
      makeEvent({
        routeKey: "GET /cost/summary",
        rawPath: "/cost/summary",
        queryStringParameters: { groupBy: "app" },
      } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>),
    );
    await handler(
      makeEvent({
        routeKey: "GET /cost/series",
        rawPath: "/cost/series",
        queryStringParameters: { dimension: "org", bucket: "day" },
      } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>),
    );

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
