/**
 * Cost Query Handler — single Lambda (HTTP API payload format 2.0)
 * branching on `routeKey` for the 4 cost-query-surface routes:
 *   GET /cost/summary?groupBy=app|agent|model|project&from&to
 *   GET /cost/series?dimension=org|app|agent|model|project&id?&bucket=hour|day&from&to
 *   GET /budgets[?orgId=] (admin only for orgId)
 *   PUT /budgets/{scope}
 *
 * ORG-SCOPING (binding, security core): every non-admin read is a
 * base-table Query with KeyConditionExpression `PK = :org AND SK BETWEEN
 * :fromIso AND :toIso`, where `:org = 'ORG#' + <verified JWT claim>`. The
 * org is NEVER taken from a query/path parameter for a non-admin caller —
 * a non-admin passing a *different* `?orgId=` is rejected 403 before any
 * DynamoDB call is made. Admins may pass `?orgId=` to read another org, or
 * omit it for their own; admin "all orgs" is a separate, explicitly
 * documented, paginated Scan exception (not implemented this pass — no
 * route requests it yet, keeping the "never Scan on the org-scoped path"
 * invariant simple to hold and test).
 *
 * SK-namespace: rollups bound SK with ISO timestamps only
 * (`SK BETWEEN :fromIso AND :toIso`), so `BUDGET#...` rows (see
 * cost-budget.ts's `budgetSortKey`) can never be swept in — see
 * cost-ledger-sk-namespace.test.ts.
 *
 * Aggregation (groupBy / bucketing) happens in-Lambda via cost-aggregate.ts
 * — required for groupBy=model since there is no ModelIndex GSI.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import {
  extractOrgFromHttpEvent,
  isAdminFromHttpEvent,
} from "./utils/auth-http-event";
import {
  aggregateSummary,
  aggregateSeries,
  type CostLedgerRowForAggregation,
  type SummaryGroupBy,
  type SeriesBucket,
} from "./utils/cost-aggregate";
import {
  budgetSortKey,
  parseBudgetScope,
  type BudgetPeriodType,
} from "./utils/cost-budget";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;

/** Hard cap on rows read per request across all pagination pages — bounds worst-case cost/latency; response is aggregated so the body stays small regardless. */
const MAX_ROWS_PER_REQUEST = 50_000;
const DEFAULT_WINDOW_DAYS = 30;
const SUMMARY_GROUP_BYS: SummaryGroupBy[] = [
  "app",
  "agent",
  "model",
  "project",
];
const SERIES_BUCKETS: SeriesBucket[] = ["hour", "day"];
const BUDGET_PERIOD_TYPES: BudgetPeriodType[] = ["monthly", "daily"];

interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function json(statusCode: number, payload: unknown): HttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function badRequest(message: string): HttpResponse {
  return json(400, { error: message });
}

function forbidden(message = "Forbidden"): HttpResponse {
  return json(403, { error: message });
}

function notFound(): HttpResponse {
  return json(404, { error: "Not found" });
}

function defaultWindow(): { fromIso: string; toIso: string } {
  const to = new Date();
  const from = new Date(
    to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/**
 * Resolves which org's key condition a request may use.
 * Returns `{ ok: false }` (→ caller responds 403) when a non-admin
 * requests an org other than their own claim. Never returns an org that
 * did not come from either the verified claim (non-admin) or an
 * explicit, admin-authorized `?orgId=` (admin).
 */
function resolveScopedOrg(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  requestedOrgId: string | undefined,
): { ok: true; orgId: string } | { ok: false } {
  const claimOrg = extractOrgFromHttpEvent(event);
  if (!claimOrg) return { ok: false };

  const isAdmin = isAdminFromHttpEvent(event);

  if (!requestedOrgId || requestedOrgId === claimOrg) {
    return { ok: true, orgId: claimOrg };
  }

  if (isAdmin) {
    return { ok: true, orgId: requestedOrgId };
  }

  // Non-admin requesting a different org: deny. Never forward requestedOrgId
  // to the key condition, and never silently fall back to the claim org for
  // this branch — the caller explicitly asked for something they cannot have.
  return { ok: false };
}

/**
 * Paginated base-table Query, `PK = ORG#<orgId> AND SK BETWEEN fromIso AND
 * toIso`. This is the ONLY DynamoDB access pattern for org-scoped reads in
 * this handler — never a Scan, never a GSI, so the org-isolation guarantee
 * lives entirely in this key condition (binding invariant).
 */
async function queryLedgerWindow(
  orgId: string,
  fromIso: string,
  toIso: string,
): Promise<{ rows: CostLedgerRowForAggregation[]; truncated: boolean }> {
  const rows: CostLedgerRowForAggregation[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: COST_LEDGER_TABLE,
        KeyConditionExpression: "PK = :org AND SK BETWEEN :fromIso AND :toIso",
        ExpressionAttributeValues: {
          ":org": `ORG#${orgId}`,
          ":fromIso": fromIso,
          ":toIso": toIso,
        },
        Limit: 1000,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      rows.push(item as unknown as CostLedgerRowForAggregation);
      if (rows.length >= MAX_ROWS_PER_REQUEST) {
        truncated = true;
        break;
      }
    }

    exclusiveStartKey = truncated
      ? undefined
      : (result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (exclusiveStartKey);

  return { rows, truncated };
}

function qsp(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Record<string, string | undefined> {
  return event.queryStringParameters ?? {};
}

async function handleSummary(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const params = qsp(event);

  const scoped = resolveScopedOrg(event, params.orgId);
  if (!scoped.ok) return forbidden();

  const groupBy = params.groupBy as SummaryGroupBy;
  if (!SUMMARY_GROUP_BYS.includes(groupBy)) {
    return badRequest(
      `groupBy must be one of: ${SUMMARY_GROUP_BYS.join(", ")}`,
    );
  }

  const { fromIso, toIso } =
    params.from && params.to
      ? { fromIso: params.from, toIso: params.to }
      : defaultWindow();

  const { rows, truncated } = await queryLedgerWindow(
    scoped.orgId,
    fromIso,
    toIso,
  );
  const result = aggregateSummary(rows, groupBy);

  // Mixed-currency guard: sums are only meaningful within one currency.
  const currencies = new Set(
    rows.filter((r) => r.priced && r.currency).map((r) => r.currency),
  );
  const currencyMixed = currencies.size > 1;

  return json(200, {
    groupBy,
    from: fromIso,
    to: toIso,
    currency: currencyMixed ? null : (Array.from(currencies)[0] ?? null),
    currencyMixed,
    totalCostMicros: result.totalCostMicros,
    pricedRows: result.pricedRows,
    unpricedRows: result.unpricedRows,
    estimate: true,
    truncated,
    buckets: result.buckets,
  });
}

async function handleSeries(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> {
  const params = qsp(event);

  const scoped = resolveScopedOrg(event, params.orgId);
  if (!scoped.ok) return forbidden();

  const bucket = params.bucket as SeriesBucket;
  if (!SERIES_BUCKETS.includes(bucket)) {
    return badRequest(`bucket must be one of: ${SERIES_BUCKETS.join(", ")}`);
  }
  const dimension = params.dimension || "org";

  const { fromIso, toIso } =
    params.from && params.to
      ? { fromIso: params.from, toIso: params.to }
      : defaultWindow();

  const { rows: allRows, truncated } = await queryLedgerWindow(
    scoped.orgId,
    fromIso,
    toIso,
  );

  const rows =
    dimension === "org" || !params.id
      ? allRows
      : allRows.filter((r) => {
          const value =
            dimension === "app"
              ? r.appId
              : dimension === "agent"
                ? r.agentId
                : dimension === "project"
                  ? r.projectId
                  : dimension === "model"
                    ? r.modelKey
                    : undefined;
          return value === params.id;
        });

  const result = aggregateSeries(rows, bucket);
  const currencies = new Set(
    rows.filter((r) => r.priced && r.currency).map((r) => r.currency),
  );

  return json(200, {
    dimension,
    id: params.id,
    bucket,
    from: fromIso,
    to: toIso,
    currency: currencies.size === 1 ? Array.from(currencies)[0] : null,
    estimate: true,
    truncated,
    unpricedCount: result.unpricedCount,
    points: result.points,
  });
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

function validatePutBudgetBody(
  raw: unknown,
):
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
      case "GET /cost/summary":
        return await handleSummary(event);
      case "GET /cost/series":
        return await handleSeries(event);
      case "GET /budgets":
        return await handleListBudgets(event);
      case "PUT /budgets/{scope}":
        return await handlePutBudget(event);
      default:
        return notFound();
    }
  } catch (err: unknown) {
    console.error("cost-query-handler: unhandled error", {
      routeKey: event.routeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "Internal server error" });
  }
};
