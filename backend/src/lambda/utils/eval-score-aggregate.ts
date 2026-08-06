/**
 * eval-score-aggregate.ts (CIT-103 Pass A) — pure run-level rollup over a
 * set of per-case ScoreVectors. Design §4 (VECTOR PERSISTENCE):
 *
 *  - boolean dims (task_success, policy_compliance, groundedness_citation,
 *    plus any JUDGE-basis dim landed as a boolean verdict): passRate =
 *    passed/scored + counts.
 *  - score dims (tool_accuracy, judge-scored dims): meanScore over SCORED
 *    + counts.
 *  - latency: p50/p95 over `measurement` (percentile helper mirrors
 *    app-metrics-handler.ts's percentile()) + count.
 *  - cost: sumUsd + meanUsd over priced (SCORED) measurements +
 *    unknownCount (priced-only sum discipline — mirrors cost-aggregate.ts;
 *    UNKNOWN rows are counted but never fabricated into the sum as zero).
 *
 * NEVER a composite single number anywhere in this module's output — see
 * eval-no-composite.guard.test.ts for the mechanical guard. Pure and
 * I/O-free: no AWS SDK imports, no Date.now(), no randomness.
 */
import {
  DIMENSION_ORDER,
  type DimensionName,
  type DimensionScore,
} from "./eval-scoring";

export interface CaseScoreRowForAggregation {
  caseId: string;
  scoreVector: DimensionScore[];
}

export interface DimensionAggregate {
  dimension: DimensionName;
  scoredCount: number;
  notApplicableCount: number;
  unknownCount: number;
  pendingCount: number;
  /** boolean-verdict dims only. */
  passedCount?: number;
  passRate?: number;
  /** score-verdict dims only. */
  meanScore?: number;
  /** latency only. */
  p50?: number;
  p95?: number;
  /** cost only. */
  sumUsd?: number;
  meanUsd?: number;
}

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Percentile over a SORTED numeric array — same nearest-rank formula as
 * app-metrics-handler.ts's percentile() helper, for consistency across
 * the codebase's two percentile call sites. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function emptyAggregate(dimension: DimensionName): DimensionAggregate {
  return {
    dimension,
    scoredCount: 0,
    notApplicableCount: 0,
    unknownCount: 0,
    pendingCount: 0,
  };
}

/**
 * Aggregates a run's per-case ScoreVectors into one DimensionAggregate per
 * DIMENSION_ORDER entry (always all 7, even if a run has zero cases or a
 * dimension never appears — an absent dimension is reported as a
 * zeroed/all-undefined aggregate rather than omitted, so a UI/consumer
 * never has to special-case a missing key).
 */
export function aggregateScoreVectors(
  rows: CaseScoreRowForAggregation[],
): DimensionAggregate[] {
  const byDimension = new Map<DimensionName, DimensionScore[]>();
  for (const dimension of DIMENSION_ORDER) {
    byDimension.set(dimension, []);
  }

  for (const row of rows) {
    for (const score of row.scoreVector) {
      const bucket = byDimension.get(score.dimension);
      if (bucket) bucket.push(score);
    }
  }

  return DIMENSION_ORDER.map((dimension) => {
    const scores = byDimension.get(dimension) ?? [];
    const agg = emptyAggregate(dimension);

    const scored: DimensionScore[] = [];
    for (const s of scores) {
      if (s.status === "NOT_APPLICABLE") agg.notApplicableCount += 1;
      else if (s.status === "UNKNOWN") agg.unknownCount += 1;
      else if (s.status === "PENDING") agg.pendingCount += 1;
      else if (s.status === "SCORED") scored.push(s);
    }
    agg.scoredCount = scored.length;

    if (scored.length === 0) {
      return agg;
    }

    const booleanScored = scored.filter((s) => s.verdict?.kind === "boolean");
    const scoreScored = scored.filter((s) => s.verdict?.kind === "score");
    const measured = scored.filter((s) => typeof s.measurement === "number");

    if (dimension === "latency") {
      const values = measured
        .map((s) => s.measurement as number)
        .sort((a, b) => a - b);
      if (values.length > 0) {
        agg.p50 = percentile(values, 50);
        agg.p95 = percentile(values, 95);
      }
      return agg;
    }

    if (dimension === "cost") {
      // Priced-only sum discipline: a cost row only ever reaches SCORED
      // when it was fully priced (eval-scoring.ts's scoreCost sets
      // status=UNKNOWN on any unpriced contributor) — so every SCORED
      // measurement here is safe to sum without a further priced check.
      const values = measured.map((s) => s.measurement as number);
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0);
        agg.sumUsd = round6dp(sum);
        agg.meanUsd = round6dp(sum / values.length);
      }
      return agg;
    }

    if (booleanScored.length > 0) {
      const passed = booleanScored.filter(
        (s) => s.verdict?.kind === "boolean" && s.verdict.pass,
      ).length;
      agg.passedCount = passed;
      agg.passRate = round6dp(passed / booleanScored.length);
    }

    if (scoreScored.length > 0) {
      const sum = scoreScored.reduce(
        (a, s) => a + (s.verdict?.kind === "score" ? s.verdict.score : 0),
        0,
      );
      agg.meanScore = round6dp(sum / scoreScored.length);
    }

    return agg;
  });
}
