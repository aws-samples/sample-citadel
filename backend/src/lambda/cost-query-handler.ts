/**
 * Cost Query Handler — read-only Lambda (HTTP API payload format 2.0)
 * branching on `routeKey` for the 2 read-only cost-query routes:
 *   GET /cost/summary?groupBy=app|agent|model|project&from&to
 *   GET /cost/series?dimension=org|app|agent|model|project&id?&bucket=hour|day&from&to
 *
 * GET /budgets and PUT /budgets/{scope} moved to the dedicated
 * cost-budget-handler.ts Lambda (query/budgets IAM split) — this handler's
 * IAM role is `dynamodb:Query`-only, with zero write permission, full stop.
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
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import {
  aggregateSummary,
  aggregateSeries,
  type CostLedgerRowForAggregation,
  type SummaryGroupBy,
  type SeriesBucket,
} from "./utils/cost-aggregate";
import {
  badRequest,
  forbidden,
  json,
  notFound,
  resolveScopedOrg,
  type HttpResponse,
} from "./utils/cost-http-shared";

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

function defaultWindow(): { fromIso: string; toIso: string } {
  const to = new Date();
  const from = new Date(
    to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
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

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<HttpResponse> => {
  try {
    switch (event.routeKey) {
      case "GET /cost/summary":
        return await handleSummary(event);
      case "GET /cost/series":
        return await handleSeries(event);
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
