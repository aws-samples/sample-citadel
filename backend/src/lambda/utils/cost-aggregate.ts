/**
 * Cost Aggregate — pure in-Lambda rollup helpers for the cost query
 * surface (`/cost/summary`, `/cost/series`).
 *
 * Org-scoped reads hit the BASE table (PK=ORG#<org>, SK=<capturedAt>#...)
 * because the binding property test requires the org isolation guarantee
 * to live in the DynamoDB key condition, never in a post-filter — and
 * `groupBy=model` has no supporting GSI. Aggregation therefore happens
 * here, in-Lambda, over rows the caller already Queried against the base
 * table (or, for the admin all-orgs exception, a Scan).
 *
 * Pure and I/O-free — no AWS SDK imports. costMicros sums only include
 * `priced===true` rows (unpriced rows are counted separately, per the
 * "never fabricate a price" policy); a mixed-currency rollup would be
 * meaningless to sum, so callers that need currency-safety should bucket
 * upstream by currency before calling this (v1 assumes a single currency
 * per org, matching the model-catalog's per-model single-currency rows).
 */

export type SummaryGroupBy = "app" | "agent" | "model" | "project";
export type SeriesBucket = "hour" | "day";

/** Narrow view of a ledger row this module needs — see cost-ledger-writer.ts's LedgerRow for the full shape. */
export interface CostLedgerRowForAggregation {
  orgId: string;
  appId?: string;
  agentId?: string;
  projectId?: string;
  modelKey?: string;
  capturedAt: string;
  totalTokens: number;
  costMicros: number | null;
  tokenCost: number | null;
  currency: string | null;
  priced: boolean;
}

export interface SummaryBucket {
  key: string;
  label: string;
  costMicros: number;
  tokenCost: number;
  totalTokens: number;
  rows: number;
  unpricedRows: number;
}

export interface SummaryResult {
  totalCostMicros: number;
  pricedRows: number;
  unpricedRows: number;
  buckets: SummaryBucket[];
}

export interface SeriesPoint {
  t: string;
  costMicros: number;
  totalTokens: number;
  rows: number;
  unpricedRows: number;
}

export interface SeriesResult {
  points: SeriesPoint[];
  unpricedCount: number;
}

const UNASSIGNED = "unassigned";

function dimensionKey(
  row: CostLedgerRowForAggregation,
  groupBy: SummaryGroupBy,
): string {
  const value =
    groupBy === "app"
      ? row.appId
      : groupBy === "agent"
        ? row.agentId
        : groupBy === "project"
          ? row.projectId
          : row.modelKey;
  return value && value.length > 0 ? value : UNASSIGNED;
}

/**
 * Groups rows by the requested dimension, summing cost/tokens per bucket.
 * Rows missing the dimension attribute fall into a single `unassigned`
 * bucket rather than being dropped — a dropped row would silently
 * understate total spend.
 */
export function aggregateSummary(
  rows: CostLedgerRowForAggregation[],
  groupBy: SummaryGroupBy,
): SummaryResult {
  const buckets = new Map<string, SummaryBucket>();
  let totalCostMicros = 0;
  let pricedRows = 0;
  let unpricedRows = 0;

  for (const row of rows) {
    const key = dimensionKey(row, groupBy);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: key,
        costMicros: 0,
        tokenCost: 0,
        totalTokens: 0,
        rows: 0,
        unpricedRows: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.rows += 1;
    bucket.totalTokens += row.totalTokens;

    if (row.priced && row.costMicros !== null) {
      bucket.costMicros += row.costMicros;
      bucket.tokenCost += row.tokenCost ?? 0;
      totalCostMicros += row.costMicros;
      pricedRows += 1;
    } else {
      bucket.unpricedRows += 1;
      unpricedRows += 1;
    }
  }

  return {
    totalCostMicros,
    pricedRows,
    unpricedRows,
    buckets: Array.from(buckets.values()).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
  };
}

/** UTC day bucket key, e.g. "2026-07-25". */
function dayBucketKey(capturedAt: string): string {
  return capturedAt.slice(0, 10);
}

/** UTC hour bucket key, e.g. "2026-07-25T05". */
function hourBucketKey(capturedAt: string): string {
  return capturedAt.slice(0, 13);
}

/**
 * Buckets rows into a time series (hour or day, UTC), summing
 * cost/tokens per bucket. Points are sorted ascending by bucket key —
 * ISO-prefixed keys sort chronologically as plain strings, so no Date
 * parsing is needed for ordering.
 */
export function aggregateSeries(
  rows: CostLedgerRowForAggregation[],
  bucket: SeriesBucket,
): SeriesResult {
  const keyFor = bucket === "hour" ? hourBucketKey : dayBucketKey;
  const points = new Map<string, SeriesPoint>();
  let unpricedCount = 0;

  for (const row of rows) {
    const t = keyFor(row.capturedAt);
    let point = points.get(t);
    if (!point) {
      point = { t, costMicros: 0, totalTokens: 0, rows: 0, unpricedRows: 0 };
      points.set(t, point);
    }

    point.rows += 1;
    point.totalTokens += row.totalTokens;

    if (row.priced && row.costMicros !== null) {
      point.costMicros += row.costMicros;
    } else {
      point.unpricedRows += 1;
      unpricedCount += 1;
    }
  }

  return {
    points: Array.from(points.values()).sort((a, b) => a.t.localeCompare(b.t)),
    unpricedCount,
  };
}
