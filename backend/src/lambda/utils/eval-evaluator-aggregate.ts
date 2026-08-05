/**
 * eval-evaluator-aggregate.ts (CIT-107) — run-level aggregation for
 * CUSTOM (org-registered, non-canonical) dimensions. Composes ALONGSIDE
 * the unmodified aggregateScoreVectors() (eval-score-aggregate.ts),
 * which continues to iterate only the fixed DIMENSION_ORDER and is never
 * touched by this module — a caller wanting a full run report calls
 * both and concatenates: `[...aggregateScoreVectors(rows), ...aggregateCustomDimensions(rows)]`.
 *
 * Same aggregation semantics as the canonical aggregator for the
 * boolean-passRate / score-meanScore split (design §4, mirrored from
 * eval-score-aggregate.ts) — minus latency/cost special-casing, which
 * are reserved canonical names that can never appear in a custom
 * dimension name (enforced by validateExternalDimensionScore's
 * RESERVED_DIMENSION_NAMES check).
 *
 * Unlike aggregateScoreVectors, this function does NOT pre-seed every
 * possible dimension name (there is no fixed set of custom names to
 * enumerate) — it discovers whichever custom dimension names actually
 * appear across the run's rows and returns exactly those, so a run with
 * zero custom evaluators registered returns [] rather than a synthetic
 * all-zero entry.
 */
import type { EvaluatorDimensionScore } from "./eval-evaluator-registry";
import { DIMENSION_ORDER } from "./eval-scoring";

const CANONICAL_DIMENSIONS = new Set<string>(DIMENSION_ORDER);

export interface CaseCustomScoreRow {
  caseId: string;
  scores: EvaluatorDimensionScore[];
}

export interface CustomDimensionAggregate {
  dimension: string;
  scoredCount: number;
  notApplicableCount: number;
  unknownCount: number;
  pendingCount: number;
  passedCount?: number;
  passRate?: number;
  meanScore?: number;
}

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Aggregates a run's custom-dimension scores. Discovers dimension names
 * dynamically (canonical dimension names are skipped — they belong to
 * aggregateScoreVectors, not here) and returns one aggregate per
 * distinct custom name found, sorted alphabetically for determinism.
 */
export function aggregateCustomDimensions(
  rows: CaseCustomScoreRow[],
): CustomDimensionAggregate[] {
  const byDimension = new Map<string, EvaluatorDimensionScore[]>();

  for (const row of rows) {
    for (const score of row.scores) {
      if (CANONICAL_DIMENSIONS.has(score.dimension)) continue;
      const bucket = byDimension.get(score.dimension) ?? [];
      bucket.push(score);
      byDimension.set(score.dimension, bucket);
    }
  }

  const dimensionNames = [...byDimension.keys()].sort();

  return dimensionNames.map((dimension) => {
    const scores = byDimension.get(dimension) ?? [];
    const agg: CustomDimensionAggregate = {
      dimension,
      scoredCount: 0,
      notApplicableCount: 0,
      unknownCount: 0,
      pendingCount: 0,
    };

    const scored: EvaluatorDimensionScore[] = [];
    for (const s of scores) {
      if (s.status === "NOT_APPLICABLE") agg.notApplicableCount += 1;
      else if (s.status === "UNKNOWN") agg.unknownCount += 1;
      else if (s.status === "PENDING") agg.pendingCount += 1;
      else if (s.status === "SCORED") scored.push(s);
    }
    agg.scoredCount = scored.length;

    if (scored.length === 0) return agg;

    const booleanScored = scored.filter((s) => s.verdict?.kind === "boolean");
    const scoreScored = scored.filter((s) => s.verdict?.kind === "score");

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
