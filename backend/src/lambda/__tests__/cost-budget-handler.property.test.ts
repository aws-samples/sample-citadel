/**
 * BINDING property test (per architect design §7, extended to the budgets
 * Lambda per verify-aftercare loop-1 failure 2(c)): for arbitrary org pairs,
 * a non-admin request against GET /budgets or PUT /budgets/{scope} ALWAYS
 * pins its DynamoDB command to PK=ORG#<claimOrg> — asserted on the mocked
 * DDB command itself, never by post-filtering results — and a non-admin
 * supplying a different orgId is rejected with 403 before any DDB call
 * carrying that other org's key is ever made.
 *
 * Admin requests may honor an explicit ?orgId= (including cross-org) on
 * GET /budgets.
 */
import fc from "fast-check";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { handler } from "../cost-budget-handler";

const ddbMock = mockClient(DynamoDBDocumentClient);

const orgIdArb = fc
  .stringMatching(/^[a-zA-Z0-9-]{1,20}$/)
  .filter((s) => s.length > 0);

function makeGetBudgetsEvent(
  claimOrg: string,
  queryOrgId: string | undefined,
  isAdmin: boolean,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, unknown> = {
    "custom:organization": claimOrg,
  };
  if (isAdmin) claims["custom:role"] = "admin";

  const qsp: Record<string, string> | null =
    queryOrgId !== undefined ? { orgId: queryOrgId } : null;

  return {
    version: "2.0",
    routeKey: "GET /budgets",
    rawPath: "/budgets",
    rawQueryString: "",
    headers: {},
    queryStringParameters: qsp,
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: "GET", path: "/budgets" },
    },
    body: undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function makePutBudgetEvent(
  claimOrg: string,
  isAdmin: boolean,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, unknown> = {
    "custom:organization": claimOrg,
  };
  if (isAdmin) claims["custom:role"] = "admin";

  return {
    version: "2.0",
    routeKey: "PUT /budgets/{scope}",
    rawPath: "/budgets/org",
    rawQueryString: "",
    headers: {},
    queryStringParameters: null,
    pathParameters: { scope: "org" },
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: "PUT", path: "/budgets/org" },
    },
    body: JSON.stringify({
      periodType: "monthly",
      limitMicros: 1_000_000_000,
      thresholds: [0.8],
      currency: "USD",
    }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  ddbMock.on(UpdateCommand).resolves({});
  process.env.COST_LEDGER_TABLE = "test-ledger";
});

afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("cost-budget-handler org-scoping property (binding)", () => {
  test("GET /budgets non-admin: every Query is pinned to PK=ORG#<claimOrg>; never a Scan; never ORG#<otherOrg>", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        fc.pre(orgA !== orgB);
        ddbMock.resetHistory();

        const event = makeGetBudgetsEvent(orgA, undefined, false);
        const res = await handler(event);
        expect(res.statusCode).toBe(200);

        const scanCalls = ddbMock.commandCalls(ScanCommand);
        expect(scanCalls).toHaveLength(0);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls.length).toBeGreaterThan(0);

        for (const call of queryCalls) {
          const values = call.args[0].input.ExpressionAttributeValues as
            Record<string, unknown> | undefined;
          expect(Object.values(values ?? {})).toContain(`ORG#${orgA}`);
          expect(Object.values(values ?? {})).not.toContain(`ORG#${orgB}`);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("GET /budgets admin: ?orgId=<orgB> is honored — key condition pins ORG#<orgB>", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        ddbMock.resetHistory();

        const event = makeGetBudgetsEvent(orgA, orgB, true);
        const res = await handler(event);
        expect(res.statusCode).toBe(200);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls.length).toBeGreaterThan(0);
        for (const call of queryCalls) {
          const values = call.args[0].input.ExpressionAttributeValues as
            Record<string, unknown> | undefined;
          expect(Object.values(values ?? {})).toContain(`ORG#${orgB}`);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("GET /budgets non-admin passing a different ?orgId= is rejected 403 before any DDB call carries that org", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        fc.pre(orgA !== orgB);
        ddbMock.resetHistory();

        const event = makeGetBudgetsEvent(orgA, orgB, false);
        const res = await handler(event);
        expect(res.statusCode).toBe(403);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        for (const call of queryCalls) {
          const values = call.args[0].input.ExpressionAttributeValues as
            Record<string, unknown> | undefined;
          expect(Object.values(values ?? {})).not.toContain(`ORG#${orgB}`);
        }
        const scanCalls = ddbMock.commandCalls(ScanCommand);
        expect(scanCalls).toHaveLength(0);
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls).toHaveLength(0);
      }),
      { numRuns: 50 },
    );
  });

  test("PUT /budgets/{scope} non-admin: UpdateItem Key is always ORG#<claimOrg>#BUDGET#ORG — never any other org", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        fc.pre(orgA !== orgB);
        ddbMock.resetHistory();

        const event = makePutBudgetEvent(orgA, false);
        const res = await handler(event);
        expect(res.statusCode).toBe(200);

        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        expect(updateCalls.length).toBeGreaterThan(0);
        for (const call of updateCalls) {
          const key = call.args[0].input.Key as Record<string, unknown>;
          expect(key.PK).toBe(`ORG#${orgA}`);
          expect(key.PK).not.toBe(`ORG#${orgB}`);
        }
      }),
      { numRuns: 50 },
    );
  });
});
