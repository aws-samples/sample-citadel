/**
 * rollback-policy.ts — PURE post-deploy rollback policy + evaluator.
 *
 * PURE — no I/O, no `Date.now()`, no `Math.random()`, no module-level
 * mutable state, matching release-gate.ts's own purity contract:
 * `evaluateRollback` is deterministic (identical inputs → byte-identical
 * output).
 *
 * This is the post-deploy KILL-SWITCH counterpart to release-gate.ts's
 * pre-deploy promotion floors, and is stored as a DISTINCT `rollbackPolicy`
 * sub-object on the SAME PROMOTION_POLICY_CONFIG_TABLE row (decision D1) so
 * it reuses promotion-policy-store.ts's DEFAULT ← org ← agent ← env
 * field-level merge + fail-closed UNREADABLE + admin authz verbatim.
 *
 * FAIL-SAFE DIRECTION (decision D3, the whole point of this module):
 * auto-rollback is a MUTATING action, so it must fire ONLY on POSITIVE
 * breach evidence over a sufficient candidate-arm sample. Every safety
 * lever below biases toward do-nothing:
 *   - `enabled` defaults false — an org that authors no rollbackPolicy
 *     never auto-rolls, full stop.
 *   - a `null` threshold means "not evaluated" (distinct from 0) — a
 *     metric with no configured ceiling can never trigger.
 *   - a candidate-arm sampleCount below `minSampleCount` → INSUFFICIENT_DATA
 *     → never triggers (a tiny sample is not evidence).
 *   - a metric with no measured value (`observedValue === null`) is
 *     skipped — this is how errorRate / policyViolationFindingRate /
 *     driftScore stay defined-in-policy but never-triggering until their
 *     per-arm attribution lands (decisions D3/D7/D9): the metrics reader
 *     supplies `null` for them today, so they are structurally unable to
 *     cause a rollback.
 */

/** The metrics a rollback policy can gate on. Only `costPerInvocation`
 * and `modelCallLatencyP95` are per-arm measurable TODAY (via cost-ledger
 * releaseId+releaseArm attribution — decision D3); the remaining three are
 * defined here so the policy is extensible, but the metrics reader supplies
 * `null` for them (no per-arm attribution exists yet — D7 finding-rate is
 * an E12 follow-up; D9 drift is gated on unverified prod-sample arm
 * attribution), so they never trigger. */
export type RollbackMetricName =
  | "costPerInvocation"
  | "modelCallLatencyP95"
  | "errorRate"
  | "policyViolationFindingRate"
  | "driftScore";

/** The action a breach maps to. v1 mints ABORT_CANARY only (decision D4):
 * zero the candidate arm, leave the human-promoted stable untouched — it
 * can never cross the floor. ROLLBACK_STABLE / BOTH are defined for policy
 * extensibility + the floor logic but are not exercised by the v1
 * evaluator. */
export type RollbackAction = "ABORT_CANARY" | "ROLLBACK_STABLE" | "BOTH";

export interface RollbackPolicy {
  /** Per-env opt-in kill switch. DEFAULT false — no auto-rollback until an
   * org deliberately turns it on AND authors at least one threshold. */
  enabled: boolean;
  /** Candidate-arm error-rate ceiling, rate 0..1. `null` = not evaluated.
   * No per-arm error attribution exists today (D3) — reader supplies null. */
  errorRateMax: number | null;
  /** Candidate-arm model-call p95 latency ceiling, ms. `null` = not
   * evaluated. Per-arm measurable today via usage-row latencyMs (D3). */
  latencyP95MaxMs: number | null;
  /** Candidate-arm policy-violation finding-rate ceiling, rate 0..1.
   * `null` = not evaluated. GovernanceFinding carries no release attribution
   * today (D7, E12 follow-up) — reader supplies null. */
  policyViolationFindingRateMax: number | null;
  /** Candidate-arm cost-per-invocation ceiling, micros. `null` = not
   * evaluated. Per-arm measurable today via cost-ledger releaseArm (D3). */
  costPerInvocationMaxMicros: number | null;
  /** Candidate-arm drift-score ceiling, 0..1. `null` = not evaluated. Gated
   * on prod-sample arm attribution that does not exist today (D9) — reader
   * supplies null. */
  driftScoreMax: number | null;
  /** Minimum candidate-arm sample count. Below this the candidate arm has
   * no trustworthy evidence → INSUFFICIENT_DATA → never triggers. DEFAULT
   * 20. */
  minSampleCount: number;
  /** Lookback window in minutes for the candidate-arm metric read. DEFAULT
   * 15. */
  evaluationWindowMinutes: number;
  /** What a breach maps to. DEFAULT ABORT_CANARY (D4). */
  action: RollbackAction;
}

/** Opt-in, never-triggers-by-default starting point. Every threshold is
 * `null` (not evaluated) and `enabled` is false, so a bare
 * DEFAULT_ROLLBACK_POLICY can never cause a rollback — an org must
 * explicitly enable it AND set a ceiling. */
export const DEFAULT_ROLLBACK_POLICY: RollbackPolicy = {
  enabled: false,
  errorRateMax: null,
  latencyP95MaxMs: null,
  policyViolationFindingRateMax: null,
  costPerInvocationMaxMicros: null,
  driftScoreMax: null,
  minSampleCount: 20,
  evaluationWindowMinutes: 15,
  action: "ABORT_CANARY",
};

/** Measured candidate-arm metrics for one evaluation window. A `null`
 * value means "not measurable for this arm today" (never triggers). The
 * three unattributed metrics (errorRate/findingRate/driftScore) are always
 * null in v1 — see RollbackPolicy field docs. */
export interface CandidateArmMetrics {
  costPerInvocationMicros: number | null;
  modelCallLatencyP95Ms: number | null;
  errorRate: number | null;
  policyViolationFindingRate: number | null;
  driftScore: number | null;
  /** Number of candidate-arm samples in the window — the evidence gate. */
  sampleCount: number;
}

export type RollbackEvaluation =
  | { shouldRollback: false; insufficientData: true; reason: string }
  | { shouldRollback: false; insufficientData: false }
  | {
      shouldRollback: true;
      breachedMetric: RollbackMetricName;
      observedValue: number;
      threshold: number;
      sampleCount: number;
      action: RollbackAction;
    };

/** Deterministic metric evaluation order — cost first, then the
 * measurable latency, then the three currently-unmeasured metrics (which
 * carry null observed values and are therefore always skipped). Fixing the
 * order makes `breachedMetric` reproducible when more than one threshold is
 * breached. */
const METRIC_ORDER: {
  name: RollbackMetricName;
  threshold: (p: RollbackPolicy) => number | null;
  observed: (m: CandidateArmMetrics) => number | null;
}[] = [
  {
    name: "costPerInvocation",
    threshold: (p) => p.costPerInvocationMaxMicros,
    observed: (m) => m.costPerInvocationMicros,
  },
  {
    name: "modelCallLatencyP95",
    threshold: (p) => p.latencyP95MaxMs,
    observed: (m) => m.modelCallLatencyP95Ms,
  },
  {
    name: "errorRate",
    threshold: (p) => p.errorRateMax,
    observed: (m) => m.errorRate,
  },
  {
    name: "policyViolationFindingRate",
    threshold: (p) => p.policyViolationFindingRateMax,
    observed: (m) => m.policyViolationFindingRate,
  },
  {
    name: "driftScore",
    threshold: (p) => p.driftScoreMax,
    observed: (m) => m.driftScore,
  },
];

/**
 * Pure rollback decision for one candidate arm.
 *
 * Returns, in strict precedence:
 *  1. `{ insufficientData: true }` when the policy is disabled OR the
 *     candidate arm has fewer than `minSampleCount` samples — NEVER a
 *     trigger (fail-safe: missing/thin data must not mutate).
 *  2. `{ shouldRollback: true, ... }` on the FIRST metric (in METRIC_ORDER)
 *     whose threshold is non-null, whose observed value is non-null, and
 *     whose observed value strictly EXCEEDS the threshold. Exact-boundary
 *     equality does NOT breach (mirrors release-gate.ts's
 *     exact-threshold-does-not-breach discipline).
 *  3. `{ shouldRollback: false, insufficientData: false }` — the candidate
 *     arm is healthy against every evaluated threshold.
 *
 * A `null` threshold is never evaluated (distinct from 0). A `null`
 * observed value is skipped (the metric is not measurable for this arm
 * today), so the three unattributed metrics can never trigger regardless
 * of their configured ceilings.
 */
export function evaluateRollback(
  metrics: CandidateArmMetrics,
  policy: RollbackPolicy,
): RollbackEvaluation {
  if (!policy.enabled) {
    return {
      shouldRollback: false,
      insufficientData: true,
      reason: "POLICY_DISABLED",
    };
  }

  if (metrics.sampleCount < policy.minSampleCount) {
    return {
      shouldRollback: false,
      insufficientData: true,
      reason: "BELOW_MIN_SAMPLE_COUNT",
    };
  }

  for (const metric of METRIC_ORDER) {
    const threshold = metric.threshold(policy);
    if (threshold === null) continue; // not evaluated
    const observed = metric.observed(metrics);
    if (observed === null) continue; // not measurable for this arm today
    if (observed > threshold) {
      return {
        shouldRollback: true,
        breachedMetric: metric.name,
        observedValue: observed,
        threshold,
        sampleCount: metrics.sampleCount,
        action: policy.action,
      };
    }
  }

  return { shouldRollback: false, insufficientData: false };
}
