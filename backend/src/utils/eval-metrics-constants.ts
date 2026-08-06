/**
 * Shared EMF metric constants for the eval-drift-detector Lambda
 * (Phase 3 §3.2). Single source of truth for the `Citadel/EvalDrift`
 * namespace, metric names, and dimension keys emitted via
 * `backend/src/utils/emf.ts`'s `emitMetrics`. A CloudWatch alarm and any
 * downstream dashboard consume these names/dimensions directly — a
 * literal here is a CONTRACT, pinned by
 * `backend/src/utils/__tests__/eval-metrics-constants.test.ts`, mirroring
 * `metrics-constants.ts`'s own pinning discipline.
 *
 * Dimensions are intentionally low-cardinality per emf.ts's own
 * convention: `{Environment, AgentId, Dimension}` — finite agents x 8
 * scoring dimensions. High-cardinality identifiers (runId, sampleId) are
 * NEVER dimensions here; they ride as `properties` on the EMF flush
 * (queryable in Logs Insights, not a metric dimension).
 */

export const EVAL_DRIFT_NAMESPACE = "Citadel/EvalDrift";

/** Current-window pass rate for a boolean-verdict dimension, 0..1. */
export const METRIC_PASS_RATE = "PassRate";

/** Current-window mean score for a score-verdict dimension, 0..1. */
export const METRIC_MEAN_SCORE = "MeanScore";

/** Number of samples contributing to the current window's measurement. */
export const METRIC_SAMPLE_COUNT = "SampleCount";

/** Baseline-window pass rate, emitted alongside the current-window value
 * so a dashboard can render both series without a second query. */
export const METRIC_BASELINE_PASS_RATE = "BaselinePassRate";

/** Baseline-window mean score, same rationale as BaselinePassRate. */
export const METRIC_BASELINE_MEAN_SCORE = "BaselineMeanScore";

/** Absolute delta between baseline and current measurement — the value
 * the `DriftDelta` CloudWatch alarm (telemetry-stack.ts) watches. */
export const METRIC_DRIFT_DELTA = "DriftDelta";

export const DIMENSION_ENVIRONMENT_EVAL = "Environment";
export const DIMENSION_AGENT_ID_EVAL = "AgentId";
export const DIMENSION_DIMENSION = "Dimension";
