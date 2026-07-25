/**
 * BINDING property test (per architect design §7): for arbitrary org
 * pairs, a non-admin request ALWAYS issues a Query with KeyCondition
 * PK=ORG#<claimOrg> — asserted on the mocked DDB command itself, never by
 * post-filtering results — and NEVER a Scan. A non-admin supplying a
 * different orgId query/path param is rejected with 403 before any DDB
 * call carrying that other org's key is ever made.
 *
 * Admin requests may honor an explicit ?orgId= (including cross-org).
 */
import fc from "fast-check";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { handler } from "../cost-query-handler";

const ddbMock = mockClient(DynamoDBDocumentClient);

const orgIdArb = fc
  .stringMatching(/^[a-zA-Z0-9-]{1,20}$/)
  .filter((s) => s.length > 0);

function makeSummaryEvent(
  claimOrg: string,
  queryOrgId: string | undefined,
  isAdmin: boolean,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, unknown> = {
    "custom:organization": claimOrg,
  };
  if (isAdmin) claims["custom:role"] = "admin";

  const qsp: Record<string, string> = { groupBy: "app" };
  if (queryOrgId !== undefined) qsp.orgId = queryOrgId;

  return {
    version: "2.0",
    routeKey: "GET /cost/summary",
    rawPath: "/cost/summary",
    rawQueryString: "",
    headers: {},
    queryStringParameters: qsp,
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: "GET", path: "/cost/summary" },
    },
    body: undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  process.env.COST_LEDGER_TABLE = "test-ledger";
});

afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("cost-query-handler org-scoping property (binding)", () => {
  test("non-admin: every DDB command issued is a Query pinned to PK=ORG#<claimOrg>; never a Scan; never ORG#<otherOrg>", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        fc.pre(orgA !== orgB);
        ddbMock.resetHistory();

        const event = makeSummaryEvent(orgA, undefined, false);
        await handler(event);

        const scanCalls = ddbMock.commandCalls(ScanCommand);
        expect(scanCalls).toHaveLength(0);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls.length).toBeGreaterThan(0);

        for (const call of queryCalls) {
          const input = call.args[0].input;
          const values = input.ExpressionAttributeValues as Record<
            string,
            unknown
          >;
          // The key condition must pin exactly ORG#<orgA> — never orgB,
          // and asserted on the command sent to DDB, not on results.
          expect(Object.values(values)).toContain(`ORG#${orgA}`);
          expect(Object.values(values)).not.toContain(`ORG#${orgB}`);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("admin: ?orgId=<orgB> is honored — key condition pins ORG#<orgB>", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        ddbMock.resetHistory();

        const event = makeSummaryEvent(orgA, orgB, true);
        const res = await handler(event);
        expect(res.statusCode).toBe(200);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls.length).toBeGreaterThan(0);
        for (const call of queryCalls) {
          const values = call.args[0].input.ExpressionAttributeValues as Record<
            string,
            unknown
          >;
          expect(Object.values(values)).toContain(`ORG#${orgB}`);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("non-admin passing a different ?orgId= is rejected 403 before any DDB call carries that org", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, orgIdArb, async (orgA, orgB) => {
        fc.pre(orgA !== orgB);
        ddbMock.resetHistory();

        const event = makeSummaryEvent(orgA, orgB, false);
        const res = await handler(event);
        expect(res.statusCode).toBe(403);

        const queryCalls = ddbMock.commandCalls(QueryCommand);
        for (const call of queryCalls) {
          const values = call.args[0].input.ExpressionAttributeValues as Record<
            string,
            unknown
          >;
          expect(Object.values(values)).not.toContain(`ORG#${orgB}`);
        }
        const scanCalls = ddbMock.commandCalls(ScanCommand);
        expect(scanCalls).toHaveLength(0);
      }),
      { numRuns: 50 },
    );
  });

  test("non-admin passing ?orgId= equal to their own claim org is allowed (no-op parity)", async () => {
    await fc.assert(
      fc.asyncProperty(orgIdArb, async (orgA) => {
        ddbMock.resetHistory();
        const event = makeSummaryEvent(orgA, orgA, false);
        const res = await handler(event);
        expect(res.statusCode).toBe(200);
      }),
      { numRuns: 20 },
    );
  });
});
