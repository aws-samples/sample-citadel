/**
 * Cost Budget Handler — dedicated Lambda for the BUDGET# SK domain:
 *   GET /budgets[?orgId=] (admin only for orgId)
 *   PUT /budgets/{scope}
 *
 * Split out of cost-query-handler.ts (which retains only the read-only
 * GET /cost/summary + GET /cost/series routes) so the query surface's IAM
 * role can be `dynamodb:Query`-only with zero write permission. This
 * Lambda is the sole place with `dynamodb:UpdateItem` on the cost-ledger
 * table.
 *
 * HONEST SK-SCOPING LIMITATION: IAM cannot scope `UpdateItem` to the
 * `BUDGET#` SK namespace — `dynamodb:LeadingKeys` constrains the
 * PARTITION key only, and `PK=ORG#<org>` comes from a verified JWT claim
 * (this Lambda serves every org), so neither SK-level nor per-org IAM
 * scoping of the write is possible. The real guarantee this split
 * provides is a ROLE-LEVEL read-vs-write separation: the query Lambda's
 * role can never call UpdateItem at all, full stop. Within this Lambda,
 * `validatePutBudgetBody` + `parseBudgetScope` are the only thing
 * standing between the grant and an accidental overwrite of a rollup
 * row — they reject anything that doesn't resolve to a `BUDGET#` SK
 * before an `UpdateCommand` is ever built.
 *
 * Both routes reuse `resolveScopedOrg` from `cost-http-shared.ts` — the
 * exact same org-scoping discipline as the query Lambda.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { extractOrgFromHttpEvent } from "./utils/auth-http-event";
import {
  badRequest,
  forbidden,
  json,
  notFound,
  resolveScopedOrg,
  type HttpResponse,
} from "./utils/cost-http-shared";
import {
  budgetSortKey,
  parseBudgetScope,
  type BudgetPeriodType,
} from "./utils/cost-budget";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;

const BUDGET_PERIOD_TYPES: BudgetPeriodType[] = ["monthly", "daily"];

function qsp(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Record<string, string | undefined> {
  return event.queryStringParameters ?? {};
}

async function handleListBudgets(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const params = qsp(event);
  const scoped = resolveScopedOrg(event, params.orgId);
  if (!scoped.ok) return forbidden();

  // Budget rows live under SK prefix BUDGET# on the same org partition —
  // reuses the exact PK=ORG# key-condition discipline as ledger rollups.
  const result = await docClient.send(
    new QueryCommand({
      TableName: COST_LEDGER_TABLE,
      KeyConditionExpression: "PK = :org AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":org": `ORG#${scoped.orgId}`,
        ":prefix": "BUDGET#",
      },
    }),
  );

  const budgets = (result.Items ?? []).map((item) => {
    const sk = item.SK as string;
    const scope =
      sk === "BUDGET#ORG" ? "org" : `app:${sk.replace("BUDGET#APP#", "")}`;
    return {
      scope,
      orgId: scoped.orgId,
      appId: scope.startsWith("app:") ? scope.slice(4) : undefined,
      periodType: item.periodType,
      limitMicros: item.limitMicros,
      thresholds: item.thresholds,
      currency: item.currency,
      updatedAt: item.updatedAt,
    };
  });

  return json(200, { budgets });
}

interface PutBudgetBody {
  periodType?: unknown;
  limitMicros?: unknown;
  thresholds?: unknown;
  currency?: unknown;
}

function validatePutBudgetBody(raw: unknown):
  | {
      ok: true;
      body: {
        periodType: BudgetPeriodType;
        limitMicros: number;
        thresholds: number[];
        currency: string;
      };
    }
  | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = raw as PutBudgetBody;

  if (
    typeof b.periodType !== "string" ||
    !BUDGET_PERIOD_TYPES.includes(b.periodType as BudgetPeriodType)
  ) {
    return {
      ok: false,
      error: `periodType must be one of: ${BUDGET_PERIOD_TYPES.join(", ")}`,
    };
  }
  if (
    typeof b.limitMicros !== "number" ||
    !Number.isFinite(b.limitMicros) ||
    b.limitMicros <= 0
  ) {
    return { ok: false, error: "limitMicros must be a positive number" };
  }
  if (
    !Array.isArray(b.thresholds) ||
    b.thresholds.length === 0 ||
    !b.thresholds.every((t) => typeof t === "number" && t > 0 && t <= 1)
  ) {
    return {
      ok: false,
      error: "thresholds must be a non-empty array of numbers in (0, 1]",
    };
  }
  if (typeof b.currency !== "string" || b.currency.length === 0) {
    return { ok: false, error: "currency must be a non-empty string" };
  }

  return {
    ok: true,
    body: {
      periodType: b.periodType as BudgetPeriodType,
      limitMicros: b.limitMicros,
      thresholds: b.thresholds as number[],
      currency: b.currency,
    },
  };
}

async function handlePutBudget(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return forbidden();

  const rawScope = event.pathParameters?.scope;
  if (!rawScope) return badRequest("Missing {scope} path parameter");

  let parsedScope: ReturnType<typeof parseBudgetScope>;
  let sk: string;
  try {
    parsedScope = parseBudgetScope(rawScope);
    sk = budgetSortKey(
      rawScope === "org" ? "org" : `app#${parsedScope["appId" as never]}`,
    );
  } catch {
    return badRequest(`Invalid budget scope: ${rawScope}`);
  }

  let rawBody: unknown;
  try {
    rawBody = event.body ? JSON.parse(event.body) : undefined;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const validated = validatePutBudgetBody(rawBody);
  if (!validated.ok) return badRequest(validated.error);

  const updatedAt = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: COST_LEDGER_TABLE,
      Key: { PK: `ORG#${claimOrg}`, SK: sk },
      UpdateExpression:
        "SET periodType = :periodType, limitMicros = :limitMicros, thresholds = :thresholds, currency = :currency, updatedAt = :updatedAt, GSI5PK = :gsi5pk, GSI5SK = :gsi5sk",
      ExpressionAttributeValues: {
        ":periodType": validated.body.periodType,
        ":limitMicros": validated.body.limitMicros,
        ":thresholds": validated.body.thresholds,
        ":currency": validated.body.currency,
        ":updatedAt": updatedAt,
        ":gsi5pk": "BUDGET",
        ":gsi5sk": `ORG#${claimOrg}#${sk}`,
      },
    }),
  );

  return json(200, {
    scope: parsedScope.scopeType === "org" ? "org" : `app:${parsedScope.appId}`,
    orgId: claimOrg,
    ...validated.body,
    updatedAt,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> => {
  try {
    switch (event.routeKey) {
      case "GET /budgets":
        return await handleListBudgets(event);
      case "PUT /budgets/{scope}":
        return await handlePutBudget(event);
      default:
        return notFound();
    }
  } catch (err: unknown) {
    console.error("cost-budget-handler: unhandled error", {
      routeKey: event.routeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }
};
