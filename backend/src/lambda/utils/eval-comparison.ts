/**
 * eval-comparison.ts (CIT-105) — pure baseline-vs-candidate-cohort
 * regression comparison. Design: `planning/CONTEXT.md` cit-105-design.
 *
 * PURE — no `Date.now()`, no `Math.random()`, no I/O, no module-level
 * mutable state, mirroring eval-scoring.ts / eval-score-aggregate.ts /
 * eval-drift.ts's own purity contract. `compareRuns` is deterministic:
 * identical inputs always produce byte-identical output.
 *
 * Reuses eval-drift.ts's `computeDrift` semantics EXACTLY for the
 * material-regression threshold band (drop strictly-greater-than
 * threshold breaches; exact-threshold does not; improvement never
 * breaches; below minSampleCount is insufficient_sample), extended with:
 *  - direction-awareness for latency/cost (higher is worse — the one
 *    thing computeDrift's passRate/meanScore model lacks),
 *  - per-case classification (join by caseId, then by dimension),
 *  - unstable/flaky detection across an N-repeat candidate cohort
 *    (flagged, never averaged away — regression verdict withheld until
 *    stability is confirmed).
 *
 * NEVER a composite single number anywhere in this module's output —
 * see eval-no-composite.guard.test.ts (CURATED_FILES includes this
 * file). `verdictStatus` is a categorical enum derived from per-
 * dimension booleans, not a collapsed score.
 */
import {
  DIMENSION_ORDER,
  type DimensionName,
  type DimensionScore,
} from "./eval-scoring";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface ResolvedComparisonThresholds {
  passRateDropThreshold: number;
  meanScoreDropThreshold: number;
  latencyP95IncreaseMsThreshold: number;
  costIncreaseThreshold: number;
  minSampleCount: number;
  /** Max spread (score dims) or disagreement (boolean dims via this same
   * band applied to normalized 0/1 values) tolerated across repeats
   * before a (case,dimension) is flagged unstable. */
  scoreStabilityBand: number;
}

/** Dev-calibrated starting points — NOT final SLOs. TUNE with prod
 * baseline, mirroring eval-drift.ts's DEFAULT_DRIFT_THRESHOLDS /
 * DEFAULT_MIN_SAMPLE_COUNT discipline. */
export const DEFAULT_COMPARISON_THRESHOLDS: ResolvedComparisonThresholds = {
  passRateDropThreshold: 0.15,
  meanScoreDropThreshold: 0.15,
  latencyP95IncreaseMsThreshold: 500,
  costIncreaseThreshold: 0.05,
  minSampleCount: 10,
  scoreStabilityBand: 0.05,
};

export interface EvalComparisonCaseRow {
  caseId: string;
  scoreVector: DimensionScore[];
}

export interface EvalComparisonRunInput {
  evalRunId: string;
  agentTargetVersion: string;
  scorerVersion: string;
  cases: EvalComparisonCaseRow[];
}

export type EvalComparisonDirection =
  | "improved"
  | "regressed"
  | "unchanged"
  | "unstable"
  | "incomparable"
  | "insufficient_sample";

export type EvalComparisonPerCaseClass =
  | "improved"
  | "regressed"
  | "unchanged"
  | "unstable"
  | "incomparable"
  | "new"
  | "dropped";

export interface EvalComparisonCaseCounts {
  improved: number;
  regressed: number;
  unstable: number;
  unchanged: number;
  incomparable: number;
  new: number;
  dropped: number;
}

export interface EvalComparisonPerCaseRow {
  caseId: string;
  classification: EvalComparisonPerCaseClass;
  baselineValue: number | null;
  candidateValue: number | null;
}

export interface EvalComparisonDimension {
  dimension: DimensionName;
  direction: EvalComparisonDirection;
  materialRegression: boolean;
  unstable: boolean;
  baselineStat: number | null;
  candidateStat: number | null;
  delta: number | null;
  caseCounts: EvalComparisonCaseCounts;
  /** Per-case×per-dimension breakdown — one row per joined caseId,
   * sorted by caseId. Required by the acceptance criterion ("per-case
   * deltas AND dimension aggregates"); the aggregate stat alone is not
   * sufficient evidence for a promotion gate or a reviewer. */
  perCase: EvalComparisonPerCaseRow[];
}

export type EvalComparisonVerdictStatus =
  | "PASS"
  | "REGRESSED"
  | "UNSTABLE"
  | "INCOMPARABLE"
  /** No genuine comparable evidence exists at all — zero candidate
   * repeats, or zero cases shared between baseline and every candidate
   * repeat. Distinct from PASS/INCOMPARABLE so a promotion gate never
   * treats "nothing was actually compared" as a clean pass. */
  | "NOTHING_TO_COMPARE";

export interface EvalComparisonVerdict {
  baselineEvalRunId: string;
  baselineAgentTargetVersion: string;
  candidateEvalRunIds: string[];
  candidateAgentTargetVersion: string;
  repeatCount: number;
  scorerVersions: string[];
  thresholds: ResolvedComparisonThresholds;
  dimensions: EvalComparisonDimension[];
  anyMaterialRegression: boolean;
  materiallyRegressedDimensions: DimensionName[];
  unstableDimensions: DimensionName[];
  verdictStatus: EvalComparisonVerdictStatus;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function round6dp(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Direction of "worse" per dimension — latency/cost invert (an increase
 * is worse); every other dimension's worse direction is a decrease. */
const HIGHER_IS_WORSE: ReadonlySet<DimensionName> = new Set([
  "latency",
  "cost",
]);

/** Narrow classification of one DimensionScore's comparable value + kind,
 * or null when the score is not SCORED (nothing to compare — honest gap,
 * never fabricated). */
type ComparableValue =
  { kind: "boolean"; pass: boolean } | { kind: "score"; value: number };

function comparableOf(
  score: DimensionScore | undefined,
): ComparableValue | null {
  if (!score || score.status !== "SCORED" || !score.verdict) return null;
  if (score.verdict.kind === "boolean") {
    return { kind: "boolean", pass: score.verdict.pass };
  }
  if (score.verdict.kind === "score") {
    return { kind: "score", value: score.verdict.score };
  }
  return null;
}

/** For measurement-only dimensions (latency without a maxLatencyMs
 * budget, cost without a maxCostUsd budget) there is no boolean/score
 * verdict, only a raw `measurement`. Falls back to that when present. */
function comparableValueOrMeasurement(
  score: DimensionScore | undefined,
): number | null {
  const comparable = comparableOf(score);
  if (comparable?.kind === "score") return comparable.value;
  if (comparable?.kind === "boolean") return comparable.pass ? 1 : 0;
  if (
    score &&
    score.status === "SCORED" &&
    typeof score.measurement === "number" &&
    Number.isFinite(score.measurement)
  ) {
    return score.measurement;
  }
  return null;
}

interface PerCaseDimResult {
  caseId: string;
  classification: EvalComparisonPerCaseClass;
  /** Repeat-combined (post-stability) baseline/candidate numeric value,
   * null when incomparable/new/dropped. */
  baselineValue: number | null;
  candidateValue: number | null;
}

/**
 * Classifies one (case, dimension) pair given the baseline score and the
 * N candidate-repeat scores for that same case+dimension.
 */
function classifyCaseDimension(
  caseId: string,
  dimension: DimensionName,
  baselineScore: DimensionScore | undefined,
  candidateScoresPerRepeat: Array<DimensionScore | undefined>,
  present: { inBaseline: boolean; inAnyCandidate: boolean },
  thresholds: ResolvedComparisonThresholds,
): PerCaseDimResult {
  if (!present.inBaseline && present.inAnyCandidate) {
    return {
      caseId,
      classification: "new",
      baselineValue: null,
      candidateValue: null,
    };
  }
  if (present.inBaseline && !present.inAnyCandidate) {
    return {
      caseId,
      classification: "dropped",
      baselineValue: null,
      candidateValue: null,
    };
  }

  // Honest non-applicability agreement: baseline and every candidate
  // repeat share the identical non-SCORED status (most commonly both
  // NOT_APPLICABLE — a case that legitimately opts out of this
  // dimension on both sides). This is a stable "nothing changed", not a
  // measurability gap — must NOT be reported as incomparable.
  const baselineStatus = baselineScore?.status;
  if (
    baselineStatus &&
    baselineStatus !== "SCORED" &&
    candidateScoresPerRepeat.length > 0 &&
    candidateScoresPerRepeat.every((s) => s?.status === baselineStatus)
  ) {
    return {
      caseId,
      classification: "unchanged",
      baselineValue: null,
      candidateValue: null,
    };
  }

  // latency/cost are frequently measurement-only (no verdict at all when
  // the case has no maxLatencyMs/maxCostUsd budget) — compare on the raw
  // measurement for those two dimensions; every other dimension compares
  // on its boolean/score verdict.
  const measurementOnly = HIGHER_IS_WORSE.has(dimension);

  if (measurementOnly) {
    const baselineMeasured = comparableValueOrMeasurement(baselineScore);
    const candidateMeasuredPerRepeat = candidateScoresPerRepeat.map(
      comparableValueOrMeasurement,
    );
    const anyCandidateMeasured = candidateMeasuredPerRepeat.some(
      (v) => v !== null,
    );
    const allCandidateMeasured = candidateMeasuredPerRepeat.every(
      (v) => v !== null,
    );
    const mixedMeasurability =
      candidateMeasuredPerRepeat.length > 1 &&
      anyCandidateMeasured &&
      !allCandidateMeasured;
    if (mixedMeasurability) {
      return {
        caseId,
        classification: "unstable",
        baselineValue: null,
        candidateValue: null,
      };
    }
    if (
      baselineMeasured === null ||
      !allCandidateMeasured ||
      candidateMeasuredPerRepeat.length === 0
    ) {
      return {
        caseId,
        classification: "incomparable",
        baselineValue: null,
        candidateValue: null,
      };
    }
    const values = candidateMeasuredPerRepeat as number[];
    const spread = Math.max(...values) - Math.min(...values);
    const stabilityBand =
      dimension === "latency"
        ? thresholds.latencyP95IncreaseMsThreshold
        : thresholds.costIncreaseThreshold;
    if (values.length > 1 && spread > stabilityBand) {
      return {
        caseId,
        classification: "unstable",
        baselineValue: null,
        candidateValue: null,
      };
    }
    const combinedCandidate = round6dp(
      values.reduce((a, b) => a + b, 0) / values.length,
    );
    const delta = round6dp(combinedCandidate - baselineMeasured);
    let classification: EvalComparisonPerCaseClass;
    if (delta === 0) classification = "unchanged";
    else classification = delta > 0 ? "regressed" : "improved";
    return {
      caseId,
      classification,
      baselineValue: baselineMeasured,
      candidateValue: combinedCandidate,
    };
  }

  const baselineComparable = comparableOf(baselineScore);
  const candidateComparables = candidateScoresPerRepeat.map(comparableOf);

  // Measurability must agree across ALL repeats and match baseline's
  // measurability, or this (case,dimension) is unstable (mixed
  // measurability) rather than silently incomparable.
  const anyCandidateScored = candidateComparables.some((c) => c !== null);
  const allCandidateScored = candidateComparables.every((c) => c !== null);
  const mixedMeasurability =
    candidateComparables.length > 1 &&
    anyCandidateScored &&
    !allCandidateScored;

  if (mixedMeasurability) {
    return {
      caseId,
      classification: "unstable",
      baselineValue: null,
      candidateValue: null,
    };
  }

  if (
    !baselineComparable ||
    !allCandidateScored ||
    candidateComparables.length === 0
  ) {
    return {
      caseId,
      classification: "incomparable",
      baselineValue: null,
      candidateValue: null,
    };
  }

  const firstCandidateKind = candidateComparables[0]!.kind;
  const kindsAgreeAcrossRepeats = candidateComparables.every(
    (c) => c!.kind === firstCandidateKind,
  );
  if (
    !kindsAgreeAcrossRepeats ||
    firstCandidateKind !== baselineComparable.kind
  ) {
    return {
      caseId,
      classification: "incomparable",
      baselineValue: null,
      candidateValue: null,
    };
  }

  if (baselineComparable.kind === "boolean") {
    const passes = candidateComparables.map(
      (c) => (c as { kind: "boolean"; pass: boolean }).pass,
    );
    const allTrue = passes.every((p) => p);
    const allFalse = passes.every((p) => !p);
    if (!allTrue && !allFalse) {
      return {
        caseId,
        classification: "unstable",
        baselineValue: null,
        candidateValue: null,
      };
    }
    const candidatePass = allTrue;
    const baselineVal = baselineComparable.pass ? 1 : 0;
    const candidateVal = candidatePass ? 1 : 0;
    let classification: EvalComparisonPerCaseClass;
    if (baselineComparable.pass === candidatePass) classification = "unchanged";
    else if (!baselineComparable.pass && candidatePass)
      classification = "improved";
    else classification = "regressed";
    return {
      caseId,
      classification,
      baselineValue: baselineVal,
      candidateValue: candidateVal,
    };
  }

  // score kind — check stability band across repeats first.
  const values = candidateComparables.map(
    (c) => (c as { kind: "score"; value: number }).value,
  );
  const spread = Math.max(...values) - Math.min(...values);
  if (values.length > 1 && spread > thresholds.scoreStabilityBand) {
    return {
      caseId,
      classification: "unstable",
      baselineValue: null,
      candidateValue: null,
    };
  }
  const combinedCandidate = round6dp(
    values.reduce((a, b) => a + b, 0) / values.length,
  );
  const baselineVal = baselineComparable.value;
  const delta = round6dp(combinedCandidate - baselineVal);
  let classification: EvalComparisonPerCaseClass;
  if (delta === 0) classification = "unchanged";
  else if (HIGHER_IS_WORSE.has(dimension)) {
    classification = delta > 0 ? "regressed" : "improved";
  } else {
    classification = delta > 0 ? "improved" : "regressed";
  }
  return {
    caseId,
    classification,
    baselineValue: baselineVal,
    candidateValue: combinedCandidate,
  };
}

function emptyCaseCounts(): EvalComparisonCaseCounts {
  return {
    improved: 0,
    regressed: 0,
    unstable: 0,
    unchanged: 0,
    incomparable: 0,
    new: 0,
    dropped: 0,
  };
}

function scoreByDimension(
  scoreVector: DimensionScore[],
): Map<DimensionName, DimensionScore> {
  const map = new Map<DimensionName, DimensionScore>();
  for (const s of scoreVector) map.set(s.dimension, s);
  return map;
}

/**
 * Aggregate-level stat for one dimension across a set of comparable
 * numeric per-case values (post repeat-combination). Mirrors
 * eval-drift.ts's aggregateDimStat reduction — mean for score-kind
 * values, pass-rate (mean of 0/1) for boolean-kind values. Returns null
 * when there are zero contributing values (nothing to compare).
 */
function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return round6dp(values.reduce((a, b) => a + b, 0) / values.length);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Compares a single dimension across the joined case set. Returns the
 * dimension-level verdict entry (aggregate stat + materialRegression +
 * unstable + per-case counts).
 */
function compareDimension(
  dimension: DimensionName,
  caseIds: string[],
  baselineByCaseId: Map<string, Map<DimensionName, DimensionScore>>,
  candidateByCaseIdPerRepeat: Array<
    Map<string, Map<DimensionName, DimensionScore>>
  >,
  thresholds: ResolvedComparisonThresholds,
): EvalComparisonDimension {
  const counts = emptyCaseCounts();
  const comparablePairs: Array<{
    baselineValue: number;
    candidateValue: number;
  }> = [];
  const perCase: EvalComparisonPerCaseRow[] = [];
  let anyUnstable = false;

  for (const caseId of caseIds) {
    const inBaseline = baselineByCaseId.has(caseId);
    const inAnyCandidate = candidateByCaseIdPerRepeat.some((m) =>
      m.has(caseId),
    );

    const baselineScore = baselineByCaseId.get(caseId)?.get(dimension);
    const candidateScoresPerRepeat = candidateByCaseIdPerRepeat.map((m) =>
      m.get(caseId)?.get(dimension),
    );

    const result = classifyCaseDimension(
      caseId,
      dimension,
      baselineScore,
      candidateScoresPerRepeat,
      { inBaseline, inAnyCandidate },
      thresholds,
    );

    counts[result.classification] += 1;
    perCase.push({
      caseId: result.caseId,
      classification: result.classification,
      baselineValue: result.baselineValue,
      candidateValue: result.candidateValue,
    });
    if (result.classification === "unstable") anyUnstable = true;
    if (
      result.baselineValue !== null &&
      result.candidateValue !== null &&
      result.classification !== "new" &&
      result.classification !== "dropped"
    ) {
      comparablePairs.push({
        baselineValue: result.baselineValue,
        candidateValue: result.candidateValue,
      });
    }
  }

  perCase.sort((a, b) =>
    a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0,
  );

  const totalSampled = comparablePairs.length;
  const insufficientSample = totalSampled < thresholds.minSampleCount;

  // Precedence: unstable dominates — a flaky dimension is never reported
  // as a clean regression (design §2 precedence rule).
  if (anyUnstable) {
    return {
      dimension,
      direction: "unstable",
      materialRegression: false,
      unstable: true,
      baselineStat: null,
      candidateStat: null,
      delta: null,
      caseCounts: counts,
      perCase,
    };
  }

  if (totalSampled === 0) {
    // Every joined case classified as "unchanged" with no numeric value
    // (e.g. NOT_APPLICABLE on both baseline and every candidate repeat)
    // is an honest agreement, not a gap — report unchanged. Only report
    // incomparable when at least one case actually hit that
    // classification (or there were zero cases to join at all, which is
    // also legitimately nothing-to-compare).
    const allCasesUnchanged =
      caseIds.length > 0 &&
      counts.unchanged === caseIds.length - counts.new - counts.dropped &&
      counts.incomparable === 0 &&
      counts.regressed === 0 &&
      counts.improved === 0;
    return {
      dimension,
      direction: allCasesUnchanged ? "unchanged" : "incomparable",
      materialRegression: false,
      unstable: false,
      baselineStat: null,
      candidateStat: null,
      delta: null,
      caseCounts: counts,
      perCase,
    };
  }

  if (insufficientSample) {
    const baselineStat = meanOrNull(
      comparablePairs.map((p) => p.baselineValue),
    );
    const candidateStat = meanOrNull(
      comparablePairs.map((p) => p.candidateValue),
    );
    return {
      dimension,
      direction: "insufficient_sample",
      materialRegression: false,
      unstable: false,
      baselineStat,
      candidateStat,
      delta: null,
      caseCounts: counts,
      perCase,
    };
  }

  let baselineStat: number;
  let candidateStat: number;
  if (dimension === "latency") {
    baselineStat = percentile(
      comparablePairs.map((p) => p.baselineValue).sort((a, b) => a - b),
      95,
    );
    candidateStat = percentile(
      comparablePairs.map((p) => p.candidateValue).sort((a, b) => a - b),
      95,
    );
  } else {
    baselineStat = meanOrNull(comparablePairs.map((p) => p.baselineValue))!;
    candidateStat = meanOrNull(comparablePairs.map((p) => p.candidateValue))!;
  }

  const delta = round6dp(candidateStat - baselineStat);
  const worse = HIGHER_IS_WORSE.has(dimension) ? delta > 0 : delta < 0;
  const magnitude = Math.abs(delta);

  let threshold: number;
  if (dimension === "latency")
    threshold = thresholds.latencyP95IncreaseMsThreshold;
  else if (dimension === "cost") threshold = thresholds.costIncreaseThreshold;
  else {
    // boolean-kind dims measured as 0/1 use passRateDropThreshold;
    // score-kind dims use meanScoreDropThreshold. Both bands apply to a
    // 0..1-scaled delta, so either default is a reasonable fallback when
    // the two thresholds differ — pick passRate for boolean dims
    // (task_success/policy_compliance/groundedness_citation), meanScore
    // otherwise (tool_accuracy/trajectory/judge-scored dims).
    const isBooleanDimension = comparablePairs.every(
      (p) => p.baselineValue === 0 || p.baselineValue === 1,
    );
    threshold = isBooleanDimension
      ? thresholds.passRateDropThreshold
      : thresholds.meanScoreDropThreshold;
  }

  const materialRegression = worse && magnitude > threshold;
  const direction: EvalComparisonDirection =
    delta === 0
      ? "unchanged"
      : materialRegression
        ? "regressed"
        : worse
          ? "unchanged"
          : "improved";

  return {
    dimension,
    direction,
    materialRegression,
    unstable: false,
    baselineStat: round6dp(baselineStat),
    candidateStat: round6dp(candidateStat),
    delta,
    caseCounts: counts,
    perCase,
  };
}

function deriveVerdictStatus(
  dimensions: EvalComparisonDimension[],
): EvalComparisonVerdictStatus {
  if (dimensions.some((d) => d.materialRegression)) return "REGRESSED";
  if (dimensions.some((d) => d.unstable)) return "UNSTABLE";
  if (dimensions.some((d) => d.direction === "incomparable")) {
    return "INCOMPARABLE";
  }
  return "PASS";
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compares a baseline EvalRun against an N≥1-repeat candidate cohort of
 * the same suite. PURE — see module doc. `candidates` order does not
 * affect the output (candidateEvalRunIds/scorerVersions are sorted).
 */
export function compareRuns(
  baseline: EvalComparisonRunInput,
  candidates: EvalComparisonRunInput[],
  thresholds: ResolvedComparisonThresholds = DEFAULT_COMPARISON_THRESHOLDS,
): EvalComparisonVerdict {
  const baselineByCaseId = new Map<
    string,
    Map<DimensionName, DimensionScore>
  >();
  for (const c of baseline.cases) {
    baselineByCaseId.set(c.caseId, scoreByDimension(c.scoreVector));
  }

  const candidateByCaseIdPerRepeat = candidates.map((run) => {
    const m = new Map<string, Map<DimensionName, DimensionScore>>();
    for (const c of run.cases) {
      m.set(c.caseId, scoreByDimension(c.scoreVector));
    }
    return m;
  });

  const caseIdSet = new Set<string>();
  for (const caseId of baselineByCaseId.keys()) caseIdSet.add(caseId);
  for (const m of candidateByCaseIdPerRepeat) {
    for (const caseId of m.keys()) caseIdSet.add(caseId);
  }
  const caseIds = [...caseIdSet].sort();

  const dimensions = DIMENSION_ORDER.map((dimension) =>
    compareDimension(
      dimension,
      caseIds,
      baselineByCaseId,
      candidateByCaseIdPerRepeat,
      thresholds,
    ),
  );

  const materiallyRegressedDimensions = dimensions
    .filter((d) => d.materialRegression)
    .map((d) => d.dimension);
  const unstableDimensions = dimensions
    .filter((d) => d.unstable)
    .map((d) => d.dimension);

  const candidateEvalRunIds = [...candidates.map((c) => c.evalRunId)].sort();
  const scorerVersions = [
    ...new Set([
      baseline.scorerVersion,
      ...candidates.map((c) => c.scorerVersion),
    ]),
  ].sort();

  // Genuine evidence requires (a) at least one candidate repeat, AND
  // (b) at least one case present in BOTH the baseline and every
  // candidate repeat (a case that is `new`/`dropped` for every dimension
  // contributes no comparison at all — it's pure cohort churn, not
  // evidence). Without this, an empty candidate cohort or a first-ever
  // baseline with no prior cases both vacuously satisfy "no regression
  // found" and would let a promotion gate act on zero evidence (verify
  // blocking-2). This check is candidate-cohort-level, independent of
  // any per-dimension score presence, so it correctly overrides the
  // per-dimension PASS/incomparable derivation below.
  const jointlyPresentCaseIds = caseIds.filter(
    (caseId) =>
      baselineByCaseId.has(caseId) &&
      candidateByCaseIdPerRepeat.length > 0 &&
      candidateByCaseIdPerRepeat.every((m) => m.has(caseId)),
  );
  const hasGenuineEvidence =
    candidates.length > 0 && jointlyPresentCaseIds.length > 0;

  return {
    baselineEvalRunId: baseline.evalRunId,
    baselineAgentTargetVersion: baseline.agentTargetVersion,
    candidateEvalRunIds,
    candidateAgentTargetVersion: candidates[0]?.agentTargetVersion ?? "",
    repeatCount: candidates.length,
    scorerVersions,
    thresholds,
    dimensions,
    anyMaterialRegression: materiallyRegressedDimensions.length > 0,
    materiallyRegressedDimensions,
    unstableDimensions,
    verdictStatus: hasGenuineEvidence
      ? deriveVerdictStatus(dimensions)
      : "NOTHING_TO_COMPARE",
  };
}
