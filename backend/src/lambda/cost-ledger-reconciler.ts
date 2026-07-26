/**
 * Cost Ledger Reconciler — Lambda (Tier A aggregate drift, Tier B skeleton).
 *
 * Scheduled `rate(1 hour)` handler that compares aggregate ledger token
 * totals against AWS/Bedrock CloudWatch token metrics, per model per
 * hour-aligned window, and emits a drift metric. Per-row `estimate:true`
 * is NEVER flipped by Tier A — an aggregate comparison cannot honestly
 * produce a per-row actual. See `utils/cost-drift.ts` for the pure math
 * and `utils/cost-reconciler-types.ts` for the row shapes.
 *
 * WATERMARK / IDEMPOTENCY (binding, per architect design):
 *   State lives in the cost-ledger table itself as reserved meta rows under
 *   `PK="RECON#COST"` (never colliding with `ORG#...` data rows):
 *     - `SK="WATERMARK"` — single global monotonic watermark (scan-avoidance
 *       optimization only).
 *     - `SK="WINDOW#<startSec>"` — per-window marker. Its `PutItem` with
 *       `ConditionExpression: attribute_not_exists(PK)` IS the idempotency
 *       gate (writer's exact pattern) — a re-run of an already-marked
 *       window is a strict no-op: no metric emit, no row annotation, no
 *       watermark regression. The marker is written BEFORE emit/annotate so
 *       a mid-window crash leaves the marker present and a re-run skips
 *       cleanly (at-most-once emit; the marker already holds the durable
 *       drift truth, so a missed CloudWatch emit on crash is acceptable and
 *       back-fillable).
 *
 * ERROR ISOLATION: each window is processed in its own try/catch so one bad
 * window (e.g. a transient Scan failure) never aborts the sweep. A failed
 * `PutMetricData` call is logged and swallowed — never thrown — because the
 * marker row (already durable) is the source of truth; the metric is a
 * best-effort projection of it.
 *
 * A reconciler failure must never corrupt ledger rows: every mutation is a
 * conditional `PutItem`/`UpdateItem` (read-modify-write via
 * `attribute_not_exists`), never a blind overwrite.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  PutMetricDataCommand,
  StandardUnit,
  type MetricDataQuery,
  type MetricDataResult,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import {
  alignToHour,
  aggregateLedgerWindow,
  computeDriftPct,
  enumerateWindows,
} from "./utils/cost-drift";
import {
  RECON_PK,
  WATERMARK_SK,
  windowSk,
  type LedgerModelAggregate,
  type LedgerRowProjection,
  type LedgerWindowMarkerRow,
  type ModelDriftEntry,
  type ReconcilerWindow,
  type TierBGateResult,
  type WatermarkRow,
} from "./utils/cost-reconciler-types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cloudwatch = new CloudWatchClient({});

const DEFAULT_SETTLE_LAG_MINUTES = 15;
const DEFAULT_MAX_WINDOWS_PER_RUN = 6;
const DEFAULT_METRIC_NAMESPACE = "Citadel/CostReconciler";
const HOUR_SEC = 3600;

function costLedgerTable(): string {
  return process.env.COST_LEDGER_TABLE!;
}

function environment(): string {
  return process.env.ENVIRONMENT ?? "dev";
}

function settleLagSec(): number {
  const raw = Number(process.env.SETTLE_LAG_MINUTES);
  const minutes =
    Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SETTLE_LAG_MINUTES;
  return minutes * 60;
}

function maxWindowsPerRun(): number {
  const raw = Number(process.env.MAX_WINDOWS_PER_RUN);
  return Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : DEFAULT_MAX_WINDOWS_PER_RUN;
}

function metricNamespace(): string {
  return process.env.METRIC_NAMESPACE || DEFAULT_METRIC_NAMESPACE;
}

function tierBEnabled(): boolean {
  return process.env.COST_RECONCILER_TIER_B_ENABLED === "true";
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/** Reads the single global watermark row. Absent row => cold start (caller picks the default). */
async function readWatermark(): Promise<number | undefined> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: costLedgerTable(),
        Key: { PK: RECON_PK, SK: WATERMARK_SK },
      }),
    );
    const item = result.Item as WatermarkRow | undefined;
    return item && Number.isFinite(item.watermarkEpochSec)
      ? item.watermarkEpochSec
      : undefined;
  } catch (err: unknown) {
    console.error(
      "cost-ledger-reconciler: watermark read failed, treating as cold start",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return undefined;
  }
}

/** Scan+filter the ledger table for rows captured within `[startSec, endSec)`. Paginated. */
async function scanLedgerWindow(
  window: ReconcilerWindow,
): Promise<LedgerRowProjection[]> {
  const startIso = new Date(window.startSec * 1000).toISOString();
  const endIso = new Date(window.endSec * 1000).toISOString();

  const rows: LedgerRowProjection[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const resp = await docClient.send(
      new ScanCommand({
        TableName: costLedgerTable(),
        FilterExpression: "capturedAt >= :s AND capturedAt < :e",
        ExpressionAttributeValues: { ":s": startIso, ":e": endIso },
        ProjectionExpression:
          "PK, SK, modelKey, modelId, inputTokens, outputTokens, capturedAt, bedrockRequestId, estimate",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (resp.Items ?? []) as LedgerRowProjection[]) {
      rows.push(item);
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return rows;
}

/** Batches one GetMetricData call for all in-window models' Input/OutputTokenCount Sum. */
async function fetchMetricAggregates(
  models: Map<string, LedgerModelAggregate>,
  window: ReconcilerWindow,
): Promise<
  Map<string, { inputTokens: number | null; outputTokens: number | null }>
> {
  const modelKeys = [...models.keys()];
  const result = new Map<
    string,
    { inputTokens: number | null; outputTokens: number | null }
  >();
  if (modelKeys.length === 0) return result;

  const startTime = new Date(window.startSec * 1000);
  const endTime = new Date(window.endSec * 1000);

  const queries: MetricDataQuery[] = [];
  modelKeys.forEach((modelKey, idx) => {
    const modelId = models.get(modelKey)!.modelId;
    queries.push({
      Id: `input_${idx}`,
      MetricStat: {
        Metric: {
          Namespace: "AWS/Bedrock",
          MetricName: "InputTokenCount",
          Dimensions: [{ Name: "ModelId", Value: modelId }],
        },
        Period: HOUR_SEC,
        Stat: "Sum",
      },
      ReturnData: true,
    });
    queries.push({
      Id: `output_${idx}`,
      MetricStat: {
        Metric: {
          Namespace: "AWS/Bedrock",
          MetricName: "OutputTokenCount",
          Dimensions: [{ Name: "ModelId", Value: modelId }],
        },
        Period: HOUR_SEC,
        Stat: "Sum",
      },
      ReturnData: true,
    });
  });

  let metricResults: MetricDataResult[] = [];
  try {
    const resp = await cloudwatch.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: startTime,
        EndTime: endTime,
      }),
    );
    metricResults = resp.MetricDataResults ?? [];
  } catch (err: unknown) {
    console.error(
      "cost-ledger-reconciler: GetMetricData failed, treating all models as unmatched this window",
      { error: err instanceof Error ? err.message : String(err) },
    );
    modelKeys.forEach((modelKey) =>
      result.set(modelKey, { inputTokens: null, outputTokens: null }),
    );
    return result;
  }

  const byId = new Map(metricResults.map((r) => [r.Id, r]));

  modelKeys.forEach((modelKey, idx) => {
    const inputResult = byId.get(`input_${idx}`);
    const outputResult = byId.get(`output_${idx}`);
    const inputSum =
      inputResult?.Values && inputResult.Values.length > 0
        ? inputResult.Values.reduce((sum, v) => sum + v, 0)
        : null;
    const outputSum =
      outputResult?.Values && outputResult.Values.length > 0
        ? outputResult.Values.reduce((sum, v) => sum + v, 0)
        : null;
    result.set(modelKey, { inputTokens: inputSum, outputTokens: outputSum });
  });

  return result;
}

/** Builds the per-model drift entries. Never fabricates a match when metrics are absent. */
function buildDriftEntries(
  ledgerAgg: Map<string, LedgerModelAggregate>,
  metricAgg: Map<
    string,
    { inputTokens: number | null; outputTokens: number | null }
  >,
): { entries: ModelDriftEntry[]; unmatchedCount: number } {
  const entries: ModelDriftEntry[] = [];
  let unmatchedCount = 0;

  for (const [modelKey, ledger] of ledgerAgg) {
    const metric = metricAgg.get(modelKey);
    const metricInputTokens = metric?.inputTokens ?? null;
    const metricOutputTokens = metric?.outputTokens ?? null;

    const ledgerTotal = ledger.inputTokens + ledger.outputTokens;
    const metricTotal =
      metricInputTokens !== null && metricOutputTokens !== null
        ? metricInputTokens + metricOutputTokens
        : null;

    const matched = metricTotal !== null;
    if (!matched) unmatchedCount += 1;

    entries.push({
      modelKey,
      modelId: ledger.modelId,
      ledgerInputTokens: ledger.inputTokens,
      ledgerOutputTokens: ledger.outputTokens,
      metricInputTokens,
      metricOutputTokens,
      driftPct: matched
        ? computeDriftPct(ledgerTotal, metricTotal as number)
        : null,
      match: matched ? "matched" : "metricsMissing",
    });
  }

  return { entries, unmatchedCount };
}

/** Best-effort metric emission — logs and swallows any failure (marker is already durable). */
async function emitMetrics(
  entries: ModelDriftEntry[],
  ledgerRowCount: number,
  unmatchedModelCount: number,
): Promise<void> {
  const env = environment();
  const namespace = metricNamespace();
  const timestamp = new Date();

  const metricData: MetricDatum[] = [];

  for (const entry of entries) {
    if (entry.match === "matched" && entry.driftPct !== null) {
      metricData.push({
        MetricName: "EstimateDriftPct",
        Value: entry.driftPct,
        Unit: StandardUnit.Percent,
        Timestamp: timestamp,
        Dimensions: [
          { Name: "Environment", Value: env },
          { Name: "ModelKey", Value: entry.modelKey },
        ],
      });
    }
    metricData.push({
      MetricName: "LedgerTokens",
      Value: entry.ledgerInputTokens + entry.ledgerOutputTokens,
      Unit: StandardUnit.Count,
      Timestamp: timestamp,
      Dimensions: [
        { Name: "Environment", Value: env },
        { Name: "ModelKey", Value: entry.modelKey },
      ],
    });
    if (entry.metricInputTokens !== null && entry.metricOutputTokens !== null) {
      metricData.push({
        MetricName: "MetricTokens",
        Value: entry.metricInputTokens + entry.metricOutputTokens,
        Unit: StandardUnit.Count,
        Timestamp: timestamp,
        Dimensions: [
          { Name: "Environment", Value: env },
          { Name: "ModelKey", Value: entry.modelKey },
        ],
      });
    }
  }

  metricData.push({
    MetricName: "UnmatchedLedgerModels",
    Value: unmatchedModelCount,
    Unit: StandardUnit.Count,
    Timestamp: timestamp,
    Dimensions: [{ Name: "Environment", Value: env }],
  });
  metricData.push({
    MetricName: "WindowsReconciled",
    Value: 1,
    Unit: StandardUnit.Count,
    Timestamp: timestamp,
    Dimensions: [{ Name: "Environment", Value: env }],
  });

  const matchedDrifts = entries
    .filter((e) => e.driftPct !== null)
    .map((e) => Math.abs(e.driftPct as number));
  if (matchedDrifts.length > 0) {
    metricData.push({
      MetricName: "AbsEstimateDriftPct",
      Value: Math.max(...matchedDrifts),
      Unit: StandardUnit.Percent,
      Timestamp: timestamp,
      Dimensions: [{ Name: "Environment", Value: env }],
    });
  }

  void ledgerRowCount; // reserved for future cardinality metric; not emitted yet.

  // PutMetricData batches are capped at 1000 data points; our per-window
  // cardinality is bounded by distinct models, well under that.
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: metricData,
      }),
    );
  } catch (err: unknown) {
    console.error(
      "cost-ledger-reconciler: PutMetricData failed, window marker already durable — continuing",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/** Annotates every ledger row in the window with driftCheckedAt. A vanished row is a logged no-op. */
async function annotateRows(
  rowKeys: Array<{ PK: string; SK: string }>,
  checkedAt: string,
): Promise<void> {
  for (const key of rowKeys) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: costLedgerTable(),
          Key: key,
          UpdateExpression: "SET driftCheckedAt = :checkedAt",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":checkedAt": checkedAt },
        }),
      );
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) {
        console.log(
          "cost-ledger-reconciler: row vanished before annotation, skipping",
          { key },
        );
        continue;
      }
      console.error("cost-ledger-reconciler: row annotation failed, skipping", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Monotonic, only-forward watermark advance. Never regresses. */
async function advanceWatermark(newWatermarkSec: number): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: costLedgerTable(),
        Key: { PK: RECON_PK, SK: WATERMARK_SK },
        UpdateExpression: "SET watermarkEpochSec = :next, updatedAt = :now",
        ConditionExpression:
          "attribute_not_exists(watermarkEpochSec) OR watermarkEpochSec < :next",
        ExpressionAttributeValues: {
          ":next": newWatermarkSec,
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      console.log(
        "cost-ledger-reconciler: watermark already at or past this window's end, no-op",
        { newWatermarkSec },
      );
      return;
    }
    console.error("cost-ledger-reconciler: watermark advance failed", {
      newWatermarkSec,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Processes exactly one window: read-only aggregate compute, then a
 * conditional marker write that gates everything downstream. Returns
 * without throwing on any sub-step failure other than the initial Scan
 * (whose failure propagates so the per-window try/catch in `handler` can
 * isolate it from sibling windows).
 */
async function reconcileWindow(window: ReconcilerWindow): Promise<void> {
  const ledgerRows = await scanLedgerWindow(window);
  const ledgerAgg = aggregateLedgerWindow(ledgerRows);
  const metricAgg = await fetchMetricAggregates(ledgerAgg, window);
  const { entries, unmatchedCount } = buildDriftEntries(ledgerAgg, metricAgg);

  const computedAt = new Date().toISOString();
  const marker: LedgerWindowMarkerRow = {
    PK: RECON_PK,
    SK: windowSk(window.startSec),
    windowStartEpochSec: window.startSec,
    windowEndEpochSec: window.endSec,
    computedAt,
    tier: "A",
    models: entries,
    ledgerRowCount: ledgerRows.length,
    unmatchedModelCount: unmatchedCount,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: costLedgerTable(),
        Item: marker,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      console.log(
        "cost-ledger-reconciler: window already reconciled, strict no-op",
        { windowStartEpochSec: window.startSec },
      );
      return;
    }
    console.error("cost-ledger-reconciler: window marker write failed", {
      windowStartEpochSec: window.startSec,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Marker created — safe to emit/annotate/advance. Best-effort from here.
  await emitMetrics(entries, ledgerRows.length, unmatchedCount);

  const allRowKeys = [...ledgerAgg.values()].flatMap((agg) => agg.rowKeys);
  await annotateRows(allRowKeys, computedAt);

  await advanceWatermark(window.endSec);

  if (tierBEnabled()) {
    const gate = await tierBReconcile(window, ledgerAgg);
    if (!gate.active) {
      console.warn(
        `cost-ledger-reconciler: Tier B gate inactive (${gate.reason})`,
        { windowStartEpochSec: window.startSec },
      );
    }
  }
}

/**
 * Tier B skeleton (feature-flagged OFF). Ships the gate + signature + the
 * inactive log path only — NOT the log-parsing/matching logic described in
 * the design's follow-ups. Never throws, never mutates a ledger row.
 */
export async function tierBReconcile(
  _window: ReconcilerWindow,
  ledgerAgg: Map<string, LedgerModelAggregate>,
): Promise<TierBGateResult> {
  if (!tierBEnabled()) {
    console.debug("cost-ledger-reconciler: Tier B disabled, skipping");
    return { active: false, reason: "disabled" };
  }

  // Tier B is inert today because no ledger row carries a bedrockRequestId
  // (upstream capture change is out of scope — follow-up). We check the
  // in-window aggregate for any row that would plausibly carry one; today
  // that is always none, by construction of `aggregateLedgerWindow`'s
  // input shape.
  void ledgerAgg;
  console.warn(
    "cost-ledger-reconciler: Tier B enabled but ledger rows carry no bedrockRequestId; " +
      "per-row upgrade requires upstream capture (follow-up). Skipping.",
  );
  return { active: false, reason: "missing_requestId" };
}

export const handler = async (): Promise<{ windowsProcessed: number }> => {
  const nowSec = Math.floor(Date.now() / 1000);
  const targetEnd = alignToHour(nowSec - settleLagSec());

  const watermark = await readWatermark();
  // Cold start: reconcile exactly the single most-recent closed window.
  const effectiveWatermark = watermark ?? alignToHour(nowSec) - HOUR_SEC;

  const windows = enumerateWindows(
    effectiveWatermark,
    targetEnd,
    maxWindowsPerRun(),
  );
  console.log("cost-ledger-reconciler: windows to process", {
    count: windows.length,
    watermark: effectiveWatermark,
    targetEnd,
  });

  let processed = 0;
  for (const window of windows) {
    try {
      await reconcileWindow(window);
      processed += 1;
    } catch (err: unknown) {
      console.error(
        "cost-ledger-reconciler: window processing error, continuing sweep",
        {
          windowStartEpochSec: window.startSec,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return { windowsProcessed: processed };
};
