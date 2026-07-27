/**
 * Unit tests for cost-budget-handler.ts: GET /budgets + PUT /budgets/{scope}
 * — moved from cost-query-handler.ts as part of the query/budgets Lambda
 * IAM split. Same org-scoping/validation cases as before, now exercised
 * against the dedicated budgets Lambda.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { handler } from "../cost-budget-handler";

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeEvent(
  overrides: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {},
  claims: Record<string, unknown> = { "custom:organization": "org-1" },
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: "2.0",
    routeKey: "GET /budgets",
    rawPath: "/budgets",
    rawQueryString: "",
    headers: {},
    queryStringParameters: null,
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: "GET", path: "/budgets" },
    },
    body: undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  process.env.COST_LEDGER_TABLE = "test-ledger";
});

afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("cost-budget-handler routing", () => {
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

    const event = makeEvent({ routeKey: "GET /budgets", rawPath: "/budgets" });

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].scope).toBe("org");
  });

  test("GET /budgets?orgId=<other> as non-admin is rejected 403", async () => {
    const event = makeEvent({
      routeKey: "GET /budgets",
      rawPath: "/budgets",
      queryStringParameters: { orgId: "org-2" },
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  test("GET /budgets?orgId=<other> as admin is honored", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent(
      {
        routeKey: "GET /budgets",
        rawPath: "/budgets",
        queryStringParameters: { orgId: "org-2" },
      } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>,
      { "custom:organization": "org-1", "custom:role": "admin" },
    );

    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[0].args[0].input.ExpressionAttributeValues?.[":org"]).toBe(
      "ORG#org-2",
    );
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

  test("PUT /budgets/{scope} rejects an invalid scope with 400", async () => {
    const event = makeEvent({
      routeKey: "PUT /budgets/{scope}",
      rawPath: "/budgets/bogus",
      pathParameters: { scope: "bogus" },
      body: JSON.stringify({
        periodType: "monthly",
        limitMicros: 1,
        thresholds: [0.5],
        currency: "USD",
      }),
    } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>);

    const res = await handler(event);
    expect(res.statusCode).toBe(400);
  });

  test("PUT /budgets/{scope} with no org claim returns 403", async () => {
    const event = makeEvent(
      {
        routeKey: "PUT /budgets/{scope}",
        rawPath: "/budgets/org",
        pathParameters: { scope: "org" },
        body: JSON.stringify({
          periodType: "monthly",
          limitMicros: 1,
          thresholds: [0.5],
          currency: "USD",
        }),
      } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>,
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  test("missing org claim on GET /budgets returns 403", async () => {
    const event = makeEvent(
      { routeKey: "GET /budgets", rawPath: "/budgets" },
      {},
    );
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  test("unrecognized route returns 404", async () => {
    const event = makeEvent({ routeKey: "GET /unknown", rawPath: "/unknown" });
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
  });

  test("never issues an UpdateCommand for GET /budgets (read-only shape even on the write-capable Lambda)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const event = makeEvent({ routeKey: "GET /budgets", rawPath: "/budgets" });
    await handler(event);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
