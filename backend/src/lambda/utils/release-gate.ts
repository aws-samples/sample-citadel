/**
 * release-gate.ts — pure gate evaluator + promotion policy.
 *
 * PURE — no I/O, no `Date.now()`, no `Math.random()`, no module-level
 * mutable state, matching eval-comparison.ts / eval-score-aggregate.ts's
 * own purity contract. `evaluateReleaseGate` and `assessStaleness` are
 * deterministic: identical inputs always produce byte-identical output.
 *
 * Consumes existing verdict/aggregate types verbatim — never recomputes
 * regression or scoring:
 *   - EvalComparisonVerdict.{verdictStatus,anyMaterialRegression,
 *     materiallyRegressedDimensions} (eval-comparison.ts)
 *   - EvalComparisonDimension.materialRegression (eval-comparison.ts)
 *   - DimensionAggregate fields (eval-score-aggregate.ts)
 *   - EvalSuite.{gateClass,version,status} (types/index.ts)
 *
 * The regression rule is exactly: `verdictStatus === "PASS"` passes;
 * anything else (REGRESSED / UNSTABLE / INCOMPARABLE /
 * NOTHING_TO_COMPARE) fails closed. This module does NOT re-derive
 * regression from raw deltas — see the fixture in release-gate.test.ts
 * where a dimension's own delta looks like an improvement but
 * verdictStatus says REGRESSED, and the gate must fail on verdictStatus.
 *
 * NO_BASELINE (amendment — overrides the original design's blanket
 * FAIL): a first-ever promotion has no baseline to compare against, so
 * `hasBaseline: false` is a DISTINCT outcome from FAIL, never conflated
 * with a regression. The policy (`allowNoBaselineOnAbsoluteFloors`)
 * decides whether a no-baseline release may pass on absolute floors
 * alone (per-dimension pass-rate minimums + required gateClass packs
 * present and passing). Absence of a comparison never silently passes —
 * satisfying explicit absolute thresholds is what earns
 * NO_BASELINE_PASS. Every outcome carries machine-readable reasons.
 */
import type { EvalComparisonVerdict } from "./eval-comparison";
import type { DimensionAggregate } from "./eval-score-aggregate";
import type { DimensionName } from "./eval-scoring";
import type { EvalSuite } from "../../types";

// ─────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────

export interface PromotionPolicy {
  /** task_success dimension: DimensionAggregate.passRate must be >= this. */
  taskSuccessMin: number;
  /** policy_compliance dimension: DimensionAggregate.passRate must be
   * exactly this (default 1.0 — zero tolerance). */
  policyComplianceMin: number;
  /** latency dimension: DimensionAggregate.p95 (ms) must be <= this. */
  latencyP95TargetMs: number;
  /** cost dimension: DimensionAggregate.meanUsd must be <= this. */
  avgCostBudgetUsd: number;
  /** Minimum DimensionAggregate.scoredCount required per gated
   * dimension; below this there is no evidence for that dimension and
   * the gate fails closed rather than trusting a tiny sample. */
  minSampleCount: number;
  /** gateClass packs (EvalSuite.gateClass) that must be present and
   * passing for this agent/org. Empty = no required packs. */
  requiredGateClasses: string[];
  /** Evidence older than this many days (relative to `now`) is stale
   * and fails closed regardless of outcome. */
  maxEvidenceAgeDays: number;
  /** Whether a NO_BASELINE release may resolve to NO_BASELINE_PASS by
   * satisfying absolute floors alone (per-dimension minimums + required
   * gateClass packs). false = NO_BASELINE never passes, no matter how
   * good the absolute scores are. */
  allowNoBaselineOnAbsoluteFloors: boolean;
  /** Org ceiling (decision D5) on canary blast radius: the maximum
   * `percentBasisPoints` a startCanary/reweightCanary may request, in
   * basis points 0..10000. A CEILING that TIGHTENS going up the ladder
   * (prod ≤ staging, see promotion-ladder.ts's TIGHTENING_CEILING_FIELDS)
   * so a prod canary can never expose a wider fraction of traffic than
   * staging. Default 2500 (25%) — a conservative floor an org may raise
   * explicitly through the existing per-org/per-agent/per-env override
   * chain. */
  canaryMaxBasisPoints: number;
}

/** Dev-calibrated starting points — NOT final SLOs. TUNE with prod
 * baseline, mirroring eval-comparison.ts's DEFAULT_COMPARISON_THRESHOLDS
 * discipline. */
export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  taskSuccessMin: 0.9,
  policyComplianceMin: 1.0,
  latencyP95TargetMs: 5000,
  avgCostBudgetUsd: 1.0,
  minSampleCount: 5,
  requiredGateClasses: [],
  maxEvidenceAgeDays: 7,
  allowNoBaselineOnAbsoluteFloors: false,
  canaryMaxBasisPoints: 2500,
};

// ─────────────────────────────────────────────────────────────────────────
// Staleness
// ─────────────────────────────────────────────────────────────────────────

export type StalenessReason =
  | "SUITE_VERSION_SUPERSEDED"
  | "SUITE_NOT_FROZEN"
  | "EVIDENCE_TOO_OLD"
  | "EVIDENCE_UNREADABLE";

export interface StalenessAssessment {
  stale: boolean;
  reasons: StalenessReason[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure staleness check. Independent conditions, any fails closed:
 *  1. Suite version superseded — the pinned `evalSuiteVersion` is behind
 *     the live `EvalSuite.version`, OR the live suite's `status` is no
 *     longer `"FROZEN"` (evidence was produced against a suite that has
 *     since moved on).
 *  2. Evidence age — `now - runCompletedAt` (days) is strictly greater
 *     than `policy.maxEvidenceAgeDays`. Exact-boundary age does NOT
 *     breach (mirrors eval-comparison.ts's exact-threshold-does-not-
 *     breach discipline).
 *  3. Evidence unreadable — `runCompletedAt` or `now` fails to parse as
 *     a valid timestamp (`Date.parse` → NaN). NaN comparisons are always
 *     false, so an unvalidated NaN age would silently read as "not
 *     stale" — this branch fails closed instead of trusting a
 *     malformed/unreadable timestamp.
 */
export function assessStaleness(
  pinnedSuiteVersion: number,
  liveSuite: EvalSuite,
  runCompletedAt: string,
  policy: PromotionPolicy,
  now: string,
): StalenessAssessment {
  const reasons: StalenessReason[] = [];

  if (pinnedSuiteVersion < liveSuite.version) {
    reasons.push("SUITE_VERSION_SUPERSEDED");
  }
  if (liveSuite.status !== "FROZEN") {
    reasons.push("SUITE_NOT_FROZEN");
  }

  const runCompletedAtMs = Date.parse(runCompletedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(runCompletedAtMs) || Number.isNaN(nowMs)) {
    // Malformed/unreadable timestamps must never be treated as fresh —
    // NaN comparisons are always false, which would silently pass a
    // gate that cannot actually establish evidence age. Fail closed.
    reasons.push("EVIDENCE_UNREADABLE");
  } else {
    const ageMs = nowMs - runCompletedAtMs;
    const ageDays = ageMs / MS_PER_DAY;
    if (ageDays > policy.maxEvidenceAgeDays) {
      reasons.push("EVIDENCE_TOO_OLD");
    }
  }

  return { stale: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Gate
// ─────────────────────────────────────────────────────────────────────────

export type ReleaseGateStatus =
  "PASS" | "FAIL" | "NO_BASELINE" | "NO_BASELINE_PASS";

export type ReleaseGateReason =
  | "MATERIAL_REGRESSION"
  | "NOTHING_TO_COMPARE"
  | "VERDICT_NOT_PASS"
  | "STALE_EVIDENCE"
  | "THRESHOLD_FAILED"
  | "REQUIRED_PACK_MISSING"
  | "NO_BASELINE"
  | "NO_BASELINE_BOOTSTRAP_DISABLED";

export interface ReleaseGateVerdict {
  status: ReleaseGateStatus;
  reasons: ReleaseGateReason[];
  failedThresholds: DimensionName[];
  scoreVector: DimensionAggregate[];
  staleness: StalenessAssessment;
  requiredPacksSatisfied: boolean;
}

export interface ReleaseGateInputs {
  /** Whether a baseline evidence set exists to compare against. false
   * for a first-ever promotion to an environment with no current
   * pointer. */
  hasBaseline: boolean;
  /** Present only when hasBaseline is true — the consumed comparison
   * verdict (compareRuns() output). Never read when hasBaseline is
   * false. */
  comparisonVerdict?: EvalComparisonVerdict;
  candidateAggregates: DimensionAggregate[];
  pinnedSuiteVersion: number;
  liveSuite: EvalSuite;
  runCompletedAt: string;
  now: string;
  policy: PromotionPolicy;
}

/** Evaluate absolute per-dimension thresholds over the candidate's
 * DimensionAggregate[] against policy floors. Returns the list of
 * dimensions that failed (empty = all gated dimensions met their
 * floor). A gated dimension with fewer than policy.minSampleCount
 * scored cases is treated as having no evidence and fails closed. */
function evaluateAbsoluteThresholds(
  aggregates: DimensionAggregate[],
  policy: PromotionPolicy,
): DimensionName[] {
  const byDimension = new Map<DimensionName, DimensionAggregate>();
  for (const agg of aggregates) {
    byDimension.set(agg.dimension, agg);
  }

  const failed: DimensionName[] = [];

  const taskSuccess = byDimension.get("task_success");
  if (
    !taskSuccess ||
    taskSuccess.scoredCount < policy.minSampleCount ||
    taskSuccess.passRate === undefined ||
    taskSuccess.passRate < policy.taskSuccessMin
  ) {
    failed.push("task_success");
  }

  const policyCompliance = byDimension.get("policy_compliance");
  if (
    policyCompliance &&
    (policyCompliance.scoredCount < policy.minSampleCount ||
      policyCompliance.passRate === undefined ||
      policyCompliance.passRate < policy.policyComplianceMin)
  ) {
    failed.push("policy_compliance");
  }

  const latency = byDimension.get("latency");
  if (
    latency &&
    (latency.scoredCount < policy.minSampleCount ||
      latency.p95 === undefined ||
      latency.p95 > policy.latencyP95TargetMs)
  ) {
    failed.push("latency");
  }

  const cost = byDimension.get("cost");
  if (
    cost &&
    (cost.scoredCount < policy.minSampleCount ||
      cost.meanUsd === undefined ||
      cost.meanUsd > policy.avgCostBudgetUsd)
  ) {
    failed.push("cost");
  }

  return failed;
}

/** Whether the live suite satisfies every policy-required gateClass
 * pack. This slice resolves a single liveSuite per evaluation call
 * (evidence resolution across multiple suites is a Slice-2 concern);
 * satisfied is true only when every required class matches this
 * suite's gateClass. Empty requiredGateClasses is always satisfied. */
function evaluateRequiredPacks(
  liveSuite: EvalSuite,
  policy: PromotionPolicy,
): boolean {
  if (policy.requiredGateClasses.length === 0) return true;
  return policy.requiredGateClasses.every(
    (required) => liveSuite.gateClass === required,
  );
}

export function evaluateReleaseGate(
  inputs: ReleaseGateInputs,
): ReleaseGateVerdict {
  const staleness = assessStaleness(
    inputs.pinnedSuiteVersion,
    inputs.liveSuite,
    inputs.runCompletedAt,
    inputs.policy,
    inputs.now,
  );
  const failedThresholds = evaluateAbsoluteThresholds(
    inputs.candidateAggregates,
    inputs.policy,
  );
  const requiredPacksSatisfied = evaluateRequiredPacks(
    inputs.liveSuite,
    inputs.policy,
  );

  // Stale evidence fails closed regardless of baseline presence or any
  // other signal — missing/unreadable/stale must never read as a pass.
  if (staleness.stale) {
    return {
      status: "FAIL",
      reasons: ["STALE_EVIDENCE"],
      failedThresholds,
      scoreVector: inputs.candidateAggregates,
      staleness,
      requiredPacksSatisfied,
    };
  }

  if (!inputs.hasBaseline) {
    const absoluteFloorsMet =
      failedThresholds.length === 0 && requiredPacksSatisfied;

    if (!inputs.policy.allowNoBaselineOnAbsoluteFloors) {
      return {
        status: "NO_BASELINE",
        reasons: ["NO_BASELINE", "NO_BASELINE_BOOTSTRAP_DISABLED"],
        failedThresholds,
        scoreVector: inputs.candidateAggregates,
        staleness,
        requiredPacksSatisfied,
      };
    }

    if (absoluteFloorsMet) {
      return {
        status: "NO_BASELINE_PASS",
        reasons: ["NO_BASELINE"],
        failedThresholds,
        scoreVector: inputs.candidateAggregates,
        staleness,
        requiredPacksSatisfied,
      };
    }

    const reasons: ReleaseGateReason[] = ["NO_BASELINE"];
    if (failedThresholds.length > 0) reasons.push("THRESHOLD_FAILED");
    if (!requiredPacksSatisfied) reasons.push("REQUIRED_PACK_MISSING");
    return {
      status: "NO_BASELINE",
      reasons,
      failedThresholds,
      scoreVector: inputs.candidateAggregates,
      staleness,
      requiredPacksSatisfied,
    };
  }

  // hasBaseline is true: comparisonVerdict is required to make a
  // decision. The regression rule defers entirely to verdictStatus —
  // this module never re-derives regression from raw per-dimension
  // deltas.
  const verdict = inputs.comparisonVerdict as EvalComparisonVerdict;
  const reasons: ReleaseGateReason[] = [];

  if (verdict.verdictStatus === "NOTHING_TO_COMPARE") {
    reasons.push("NOTHING_TO_COMPARE");
  } else if (verdict.verdictStatus !== "PASS") {
    reasons.push(
      verdict.anyMaterialRegression
        ? "MATERIAL_REGRESSION"
        : "VERDICT_NOT_PASS",
    );
  }
  if (failedThresholds.length > 0) reasons.push("THRESHOLD_FAILED");
  if (!requiredPacksSatisfied) reasons.push("REQUIRED_PACK_MISSING");

  const status: ReleaseGateStatus = reasons.length === 0 ? "PASS" : "FAIL";

  return {
    status,
    reasons,
    failedThresholds,
    scoreVector: inputs.candidateAggregates,
    staleness,
    requiredPacksSatisfied,
  };
}
