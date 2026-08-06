/**
 * eval-metrics-constants.test.ts (Phase 3 §3.2/§3.4) — pins the
 * Citadel/EvalDrift EMF namespace, metric names, and dimension keys as a
 * literal-value contract (same discipline as metrics-constants.test.ts
 * for Citadel/Workflows). A downstream dashboard/alarm consumes these
 * names directly — changing a literal here is a breaking change.
 */
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
} from "../eval-metrics-constants";

describe("eval-metrics-constants", () => {
  it("pins the EMF namespace to Citadel/EvalDrift", () => {
    expect(EVAL_DRIFT_NAMESPACE).toBe("Citadel/EvalDrift");
  });

  it("pins metric name literals", () => {
    expect(METRIC_PASS_RATE).toBe("PassRate");
    expect(METRIC_MEAN_SCORE).toBe("MeanScore");
    expect(METRIC_SAMPLE_COUNT).toBe("SampleCount");
    expect(METRIC_BASELINE_PASS_RATE).toBe("BaselinePassRate");
    expect(METRIC_BASELINE_MEAN_SCORE).toBe("BaselineMeanScore");
    expect(METRIC_DRIFT_DELTA).toBe("DriftDelta");
  });

  it("pins dimension key literals to {Environment, AgentId, Dimension}", () => {
    expect(DIMENSION_ENVIRONMENT_EVAL).toBe("Environment");
    expect(DIMENSION_AGENT_ID_EVAL).toBe("AgentId");
    expect(DIMENSION_DIMENSION).toBe("Dimension");
  });

  it("all metric name constants are distinct (no accidental collision)", () => {
    const names = [
      METRIC_PASS_RATE,
      METRIC_MEAN_SCORE,
      METRIC_SAMPLE_COUNT,
      METRIC_BASELINE_PASS_RATE,
      METRIC_BASELINE_MEAN_SCORE,
      METRIC_DRIFT_DELTA,
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});
