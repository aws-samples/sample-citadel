/**
 * eval-drift-detector.ts (Phase 3 §3.2) — scheduled Lambda.
 *
 * Per (agentId, dimension) pair:
 *  1. Query `EvalProdSamples.AgentDimTimeIndex` for the CURRENT window
 *     and a BASELINE rolling window (both plain Queries — the GSI keeps
 *     this off a Scan regardless of table size, design §2.4 acceptance
 *     substrate).
 *  2. Reduce each window's rows into a `DimStat` via the pure
 *     `aggregateDimStat` (eval-drift.ts), extracting just this
 *     dimension's `ProdDimensionScore` from each row's `scoreVector`
 *     JSON blob.
 *  3. Emit EMF (`Citadel/EvalDrift`, dims `{Environment, AgentId,
 *     Dimension}`) via the existing `emitMetrics` — this is the
 *     "5% sampling yields a per-agent x per-dimension time series"
 *     deliverable (design acceptance #1). High-cardinality identifiers
 *     never become dimensions; they are not applicable here since this
 *     Lambda emits pre-aggregated per-window statistics, not per-sample
 *     data points.
 *  4. Compare via the pure `computeDrift`; on a breach, emit
 *     `governance.eval.drift.detected` (best-effort — a failed emit is
 *     logged, never thrown, since EMF for this cycle has already been
 *     durably flushed to CloudWatch Logs regardless).
 *
 * FAILURE ISOLATION (binding, same discipline as cost-budget-evaluator.ts):
 * one (agent, dimension) pair's query/processing failure is logged and
 * the loop continues with the remaining pairs — never throws out of
 * `runDriftDetection`.
 *
 * IDEMPOTENCY PER CYCLE: `runDriftDetection` is a pure function of the
 * `now` argument passed to it (defaulting to `new Date()` only at the
 * `handler` entry point, never inside the detection logic itself) and
 * the DynamoDB rows queried for the two windows it derives from `now`.
 * Two invocations with the same `now` and unchanged underlying data
 * therefore always reach the same breach decision and emit the same EMF
 * values and the same drift.detected payload — this Lambda has no
 * internal state that would make a re-run of the same cycle diverge.
 * De-duplicating REDELIVERY of the resulting drift.detected event is the
 * downstream consumer's job (eval-drift-finding-writer.ts's own
 * IdempotencyGuard on `{agentId}#{dimension}#{window}`), exactly as the
 * design's §3.3 note describes — this detector does not need its own
 * idempotency table because emitting the same finding-request twice for
 * the same window is intentionally safe: the finding-writer is what
 * de-dupes to one finding per breach per cycle.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { emitMetrics } from "../utils/emf";
import { emitGovernanceEvent } from "../utils/notifier-base";
import {
  computeDrift,
  aggregateDimStat,
  type ProdSampleDimensionRow,
} from "./utils/eval-drift";
import {
  EVAL_DRIFT_NAMESPACE,
  METRIC_PASS_RATE,
  METRIC_MEAN_SCORE,
  METRIC_SAMPLE_COUNT,
  METRIC_BASELINE_PASS_RATE,
  METRIC_BASELINE_MEAN_SCORE,
  METRIC_DRIFT_DELTA,
  DIMENSION_ENVIRONMENT_EVAL,
  DIMENSION_AGENT_ID_EVAL,
  DIMENSION_DIMENSION,
} from "../utils/eval-metrics-constants";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_PROD_SAMPLES_TABLE = process.env.EVAL_PROD_SAMPLES_TABLE!;

/** Default agent/dimension enumeration source when the scheduled
 * invocation does not supply an explicit list (production entry point).
 * Overridable via env for operability without a redeploy. */
const DEFAULT_CURRENT_WINDOW_HOURS = 24;
const DEFAULT_BASELINE_WINDOW_HOURS = 24 * 7;
const DEFAULT_BASELINE_LAG_HOURS = 24 * 7; // baseline ends 7d before current starts

/** The Phase 2 allowlisted prod dimensions (mirrors PROD_DIMENSION_ORDER
 * in eval-prod-scoring.ts). Re-declared as a literal list here rather
 * than imported, matching eval-drift.ts's own "no dependency on the
 * prod-scoring module's full type surface" discipline. */
const ALL_PROD_DIMENSIONS = [
  "policy_compliance",
  "groundedness_citation",
  "groundedness_faithfulness",
  "trajectory",
  "latency",
  "cost",
] as const;

interface ProdSampleRow {
  agentId?: string;
  scoreVector?: string;
}

/** Queries EvalProdSamples.AgentDimTimeIndex for one agent over
 * [fromBucket, toBucket] (inclusive), paginating through
 * LastEvaluatedKey. Never a Scan. */
async function queryAgentWindow(
  agentId: string,
  fromBucket: string,
  toBucket: string,
): Promise<ProdSampleRow[]> {
  const rows: ProdSampleRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: EVAL_PROD_SAMPLES_TABLE,
        IndexName: "AgentDimTimeIndex",
        KeyConditionExpression:
          "GSI1PK = :agent AND GSI1SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":agent": `AGENT#${agentId}`,
          ":from": fromBucket,
          ":to": toBucket,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    rows.push(...((result.Items ?? []) as ProdSampleRow[]));
    exclusiveStartKey = result.LastEvaluatedKey as
      Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return rows;
}

/** Extracts this dimension's ProdDimensionScore-shaped row from a
 * sample's `scoreVector` JSON blob. Returns null (never fabricated) on
 * missing/malformed JSON or a dimension absent from the vector. */
function extractDimensionRow(
  row: ProdSampleRow,
  dimension: string,
): ProdSampleDimensionRow | null {
  if (!row.scoreVector) return null;
  let vector: Array<{ dimension: string; status: string; verdict?: unknown }>;
  try {
    vector = JSON.parse(row.scoreVector);
  } catch {
    return null;
  }
  const entry = vector.find((d) => d.dimension === dimension);
  if (!entry) return null;
  return entry as ProdSampleDimensionRow;
}

function hourBucket(d: Date): string {
  return d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

export interface RunDriftDetectionOptions {
  agentIds: string[];
  dimensions?: readonly string[];
  now?: Date;
  currentWindowHours?: number;
  baselineWindowHours?: number;
  baselineLagHours?: number;
}

/**
 * Runs one full drift-detection cycle across the supplied agent list and
 * dimension list (defaults to the full Phase 2 allowlist). Never throws
 * — a single (agent, dimension) pair's failure is logged and the
 * remaining pairs are still processed (failure isolation, per binding
 * rules).
 */
export async function runDriftDetection(
  options: RunDriftDetectionOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  const dimensions = options.dimensions ?? ALL_PROD_DIMENSIONS;
  const currentWindowHours =
    options.currentWindowHours ?? DEFAULT_CURRENT_WINDOW_HOURS;
  const baselineWindowHours =
    options.baselineWindowHours ?? DEFAULT_BASELINE_WINDOW_HOURS;
  const baselineLagHours =
    options.baselineLagHours ?? DEFAULT_BASELINE_LAG_HOURS;

  const currentTo = hourBucket(now);
  const currentFrom = hourBucket(
    new Date(now.getTime() - currentWindowHours * 3600_000),
  );
  const baselineTo = hourBucket(
    new Date(now.getTime() - baselineLagHours * 3600_000),
  );
  const baselineFrom = hourBucket(
    new Date(
      now.getTime() - (baselineLagHours + baselineWindowHours) * 3600_000,
    ),
  );

  const environment = process.env.ENVIRONMENT || "test";

  for (const agentId of options.agentIds) {
    let currentRows: ProdSampleRow[];
    let baselineRows: ProdSampleRow[];
    try {
      [currentRows, baselineRows] = await Promise.all([
        queryAgentWindow(agentId, currentFrom, currentTo),
        queryAgentWindow(agentId, baselineFrom, baselineTo),
      ]);
    } catch (err: unknown) {
      console.error(
        "eval-drift-detector: window query failed for agent — skipping, continuing with remaining agents",
        { agentId, error: err instanceof Error ? err.message : String(err) },
      );
      continue;
    }

    for (const dimension of dimensions) {
      try {
        const currentDimRows = currentRows
          .map((r) => extractDimensionRow(r, dimension))
          .filter((r): r is ProdSampleDimensionRow => r !== null);
        const baselineDimRows = baselineRows
          .map((r) => extractDimensionRow(r, dimension))
          .filter((r): r is ProdSampleDimensionRow => r !== null);

        const currentStat = aggregateDimStat(currentDimRows);
        const baselineStat = aggregateDimStat(baselineDimRows);

        const drift = computeDrift(baselineStat, currentStat);

        emitMetrics({
          namespace: EVAL_DRIFT_NAMESPACE,
          dimensions: {
            [DIMENSION_ENVIRONMENT_EVAL]: environment,
            [DIMENSION_AGENT_ID_EVAL]: agentId,
            [DIMENSION_DIMENSION]: dimension,
          },
          metrics: [
            ...(typeof currentStat.passRate === "number"
              ? [
                  {
                    name: METRIC_PASS_RATE,
                    value: currentStat.passRate,
                    unit: "None",
                  },
                ]
              : []),
            ...(typeof currentStat.meanScore === "number"
              ? [
                  {
                    name: METRIC_MEAN_SCORE,
                    value: currentStat.meanScore,
                    unit: "None",
                  },
                ]
              : []),
            {
              name: METRIC_SAMPLE_COUNT,
              value: currentStat.sampleCount,
              unit: "Count",
            },
            ...(typeof baselineStat.passRate === "number"
              ? [
                  {
                    name: METRIC_BASELINE_PASS_RATE,
                    value: baselineStat.passRate,
                    unit: "None",
                  },
                ]
              : []),
            ...(typeof baselineStat.meanScore === "number"
              ? [
                  {
                    name: METRIC_BASELINE_MEAN_SCORE,
                    value: baselineStat.meanScore,
                    unit: "None",
                  },
                ]
              : []),
            ...(drift.delta !== null
              ? [{ name: METRIC_DRIFT_DELTA, value: drift.delta, unit: "None" }]
              : []),
          ],
          properties: {
            currentWindow: { from: currentFrom, to: currentTo },
            baselineWindow: { from: baselineFrom, to: baselineTo },
          },
        });

        if (drift.breached) {
          try {
            await emitGovernanceEvent("governance.eval.drift.detected", {
              agentId,
              dimension,
              baseline: baselineStat,
              current: currentStat,
              delta: drift.delta,
              window: { from: currentFrom, to: currentTo },
            });
          } catch (err: unknown) {
            console.error(
              "eval-drift-detector: emit governance.eval.drift.detected failed",
              {
                agentId,
                dimension,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          }
        }
      } catch (err: unknown) {
        console.error(
          "eval-drift-detector: failed to process (agent, dimension) pair — continuing",
          {
            agentId,
            dimension,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }
}

/**
 * Discovers the distinct agentIds that have any EvalProdSamples rows at
 * all, by scanning the base table's PK prefix — NO: this would be a
 * Scan. Instead, agent enumeration for the production schedule comes
 * from an operator-supplied env var (comma-separated agentIds) so the
 * detector NEVER Scans EvalProdSamples (binding: never Scan, mirrors
 * cost-budget-evaluator.ts's sparse-GSI-only discipline). An empty/unset
 * env var means the cycle does nothing (never fabricates an agent list).
 */
function agentIdsFromEnv(): string[] {
  const raw = process.env.EVAL_DRIFT_AGENT_IDS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const handler = async (): Promise<void> => {
  const agentIds = agentIdsFromEnv();
  if (agentIds.length === 0) {
    console.warn(
      "eval-drift-detector: EVAL_DRIFT_AGENT_IDS is empty — nothing to check this cycle",
    );
    return;
  }
  await runDriftDetection({ agentIds });
};
