/**
 * eval-drift.ts (Phase 3 §3.1) — pure drift-comparison math for the
 * production-sampling drift detector.
 *
 * Pure — no `Date.now()`, no `Math.random()`, no I/O, no module-level
 * mutable state, mirroring eval-scoring.ts/eval-trajectory.ts's own
 * purity contract. `computeDrift` is deterministic: identical inputs
 * always produce byte-identical output.
 *
 * `DimStat` mirrors the two measurement kinds `eval-score-aggregate.ts`
 * already produces per dimension: `passRate` for boolean-verdict
 * dimensions (policy_compliance, groundedness_citation, ...) and
 * `meanScore` for score-verdict dimensions (trajectory,
 * groundedness_faithfulness when judge-scored). A stat with NEITHER
 * measurement present (e.g. a dimension that was UNKNOWN/NOT_APPLICABLE
 * for every sample in the window) is honestly incomparable — drift is
 * never fabricated from an absent measurement.
 *
 * Threshold semantics: a regression is a DROP in the measurement
 * (current < baseline) whose magnitude is STRICTLY GREATER than the
 * configured threshold for that measurement kind. An exact match to the
 * threshold does NOT breach — this is the documented boundary contract,
 * pinned by a dedicated boundary test in eval-drift.test.ts. An
 * IMPROVEMENT (current >= baseline) never breaches, regardless of
 * magnitude — drift detection watches for regressions only.
 *
 * Small-N noise guard: if either window's `sampleCount` is below the
 * minimum floor, the result is `direction: "insufficient_sample"` and
 * never breaches — a handful of production samples must not trip a
 * governance finding.
 */

export interface DimStat {
  /** Fraction of SCORED boolean-verdict samples that passed, 0..1. */
  passRate?: number;
  /** Mean of SCORED score-verdict samples, 0..1. */
  meanScore?: number;
  /** Count of samples contributing to this window's measurement. */
  sampleCount: number;
}

export interface DriftThresholds {
  /** Absolute passRate drop that constitutes a breach. */
  passRate?: number;
  /** Absolute meanScore drop that constitutes a breach. */
  meanScore?: number;
}

export type DriftDirection =
  "none" | "regression" | "improvement" | "insufficient_sample" | "unknown";

export interface DriftResult {
  /** Absolute difference between comparable measurements, or null when
   * the two stats are not comparable (different/absent measurement
   * kinds). Never fabricated. */
  delta: number | null;
  breached: boolean;
  direction: DriftDirection;
}

/** Dev-calibrated starting points — NOT final SLOs. TUNE with prod
 * baseline per the same discipline as telemetry-stack.ts's alarm
 * thresholds (see docs/OBSERVABILITY.md tuning path). */
export const DEFAULT_DRIFT_THRESHOLDS: Required<DriftThresholds> = {
  passRate: 0.15,
  meanScore: 0.15,
};

/** Minimum sample count required in BOTH windows before a comparison is
 * trusted. dev-calibrated; TUNE with prod baseline. */
export const DEFAULT_MIN_SAMPLE_COUNT = 10;

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Which measurement kind a stat carries, or null if neither is a finite
 * number. Never treats 0 as absent (0 is a valid measurement). */
function measurementOf(
  stat: DimStat,
): { kind: "passRate" | "meanScore"; value: number } | null {
  if (typeof stat.passRate === "number" && Number.isFinite(stat.passRate)) {
    return { kind: "passRate", value: stat.passRate };
  }
  if (typeof stat.meanScore === "number" && Number.isFinite(stat.meanScore)) {
    return { kind: "meanScore", value: stat.meanScore };
  }
  return null;
}

/**
 * Compares a `baseline` window's stat against a `current` window's stat
 * for one (agent, dimension) pair. `thresholds` defaults to
 * `DEFAULT_DRIFT_THRESHOLDS`; `minSampleCount` defaults to
 * `DEFAULT_MIN_SAMPLE_COUNT`.
 */
export function computeDrift(
  baseline: DimStat,
  current: DimStat,
  thresholds: DriftThresholds = {},
  minSampleCount: number = DEFAULT_MIN_SAMPLE_COUNT,
): DriftResult {
  if (
    baseline.sampleCount < minSampleCount ||
    current.sampleCount < minSampleCount
  ) {
    return { delta: null, breached: false, direction: "insufficient_sample" };
  }

  const baselineMeasurement = measurementOf(baseline);
  const currentMeasurement = measurementOf(current);

  if (
    !baselineMeasurement ||
    !currentMeasurement ||
    baselineMeasurement.kind !== currentMeasurement.kind
  ) {
    // Honest gap: nothing to compare, or the two windows measured
    // different verdict kinds (e.g. a dimension that changed basis
    // between windows) — never fabricate a delta.
    return { delta: null, breached: false, direction: "unknown" };
  }

  const delta = round6dp(
    Math.abs(baselineMeasurement.value - currentMeasurement.value),
  );

  if (currentMeasurement.value >= baselineMeasurement.value) {
    return {
      delta,
      breached: false,
      direction: delta === 0 ? "none" : "improvement",
    };
  }

  const threshold =
    thresholds[baselineMeasurement.kind] ??
    DEFAULT_DRIFT_THRESHOLDS[baselineMeasurement.kind];

  const breached = delta > threshold;

  return {
    delta,
    breached,
    direction: breached ? "regression" : "none",
  };
}

/**
 * Narrow view of one `ProdDimensionScore`-shaped row (see
 * eval-prod-scoring.ts) for exactly one dimension across one window's
 * worth of `EvalProdSamples` rows. Redeclared here (rather than imported
 * from eval-prod-scoring.ts) so this pure module has no dependency on
 * the prod-scoring module's full type surface — only the three fields
 * the aggregation actually reads.
 */
export interface ProdSampleDimensionRow {
  status: "SCORED" | "UNKNOWN" | "NOT_APPLICABLE" | "PENDING";
  verdict?:
    { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };
}

/**
 * Aggregates one window's worth of per-sample dimension rows into a
 * single `DimStat`. Only `status: "SCORED"` rows contribute to the
 * measurement (UNKNOWN/NOT_APPLICABLE/PENDING rows are honestly
 * excluded — never fabricated into a pass or a score). `sampleCount` is
 * the count of SCORED rows actually contributing to the measurement,
 * matching `computeDrift`'s own noise-floor semantics (a window with
 * zero SCORED rows for this dimension is, correctly, "insufficient
 * sample" once passed to `computeDrift`).
 *
 * Deterministic regardless of input row order — order-independent
 * reduction (sum + count), never a stateful/streaming accumulation that
 * could depend on arrival order.
 */
export function aggregateDimStat(rows: ProdSampleDimensionRow[]): DimStat {
  const scored = rows.filter((r) => r.status === "SCORED" && r.verdict);
  const booleanScored = scored.filter(
    (r) => r.verdict!.kind === "boolean",
  ) as Array<{ verdict: { kind: "boolean"; pass: boolean } }>;
  const scoreScored = scored.filter(
    (r) => r.verdict!.kind === "score",
  ) as Array<{ verdict: { kind: "score"; score: number } }>;

  if (booleanScored.length > 0) {
    const passed = booleanScored.filter((r) => r.verdict.pass).length;
    return {
      passRate: round6dp(passed / booleanScored.length),
      sampleCount: booleanScored.length,
    };
  }

  if (scoreScored.length > 0) {
    const sum = scoreScored.reduce((acc, r) => acc + r.verdict.score, 0);
    return {
      meanScore: round6dp(sum / scoreScored.length),
      sampleCount: scoreScored.length,
    };
  }

  return { sampleCount: 0 };
}
