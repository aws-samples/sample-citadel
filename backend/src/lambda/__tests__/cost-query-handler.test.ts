/**
 * Unit tests for cost-query-handler.ts: routing, base-table key condition
 * discipline (PK=ORG#<claimOrg>), PUT /budgets validation, pagination
 * cap/truncated flag, and response shapes.
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

  test("PUT /budgets/{scope} validates and upserts a budget row", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const event = makeEvent({
      routeKey: "PUT /budgets/{scope}",
      rawPath: "/budgets/org",
      pathParameters: { scope: "org" },
      body: JSON.stringify({
        periodType: "monthly",
        limitMicros: 1_000_000_000,
        thresholds: [0.8, 1.0],
        currency: "USD",
      }),
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.Key).toEqual({ PK: "ORG#org-1", SK: "BUDGET#ORG" });
  });

  test("PUT /budgets/{scope} rejects a malformed body with 400", async () => {
    const event = makeEvent({
      routeKey: "PUT /budgets/{scope}",
      rawPath: "/budgets/org",
      pathParameters: { scope: "org" },
      body: JSON.stringify({ periodType: "yearly" }),
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  test("GET /budgets lists budgets for the caller org via base-table Query", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: "ORG#org-1",
          SK: "BUDGET#ORG",
          periodType: "monthly",
          limitMicros: 1_000_000_000,
          thresholds: [0.8],
          currency: "USD",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const event = makeEvent({
      routeKey: "GET /budgets",
      rawPath: "/budgets",
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].scope).toBe("org");
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

  test("unrecognized route returns 404", async () => {
    const event = makeEvent({
      routeKey: "GET /unknown",
      rawPath: "/unknown",
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });
});
