/**
 * Tests for rollback-policy.ts — the PURE post-deploy rollback evaluator.
 * Every assertion pins the fail-safe direction (decision D3): missing,
 * thin, or unattributed data must NEVER produce a rollback.
 */
import {
  DEFAULT_ROLLBACK_POLICY,
  evaluateRollback,
  type CandidateArmMetrics,
  type RollbackPolicy,
} from "../rollback-policy";

function policy(overrides: Partial<RollbackPolicy> = {}): RollbackPolicy {
  return {
    ...DEFAULT_ROLLBACK_POLICY,
    enabled: true,
    minSampleCount: 20,
    ...overrides,
  };
}

function metrics(
  overrides: Partial<CandidateArmMetrics> = {},
): CandidateArmMetrics {
  return {
    costPerInvocationMicros: null,
    modelCallLatencyP95Ms: null,
    errorRate: null,
    policyViolationFindingRate: null,
    driftScore: null,
    sampleCount: 100,
    ...overrides,
  };
}

describe("evaluateRollback", () => {
  it("flags a candidate cost-per-invocation breach over threshold", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 1500 }),
      policy({ costPerInvocationMaxMicros: 1000 }),
    );
    expect(result).toEqual({
      shouldRollback: true,
      breachedMetric: "costPerInvocation",
      observedValue: 1500,
      threshold: 1000,
      sampleCount: 100,
      action: "ABORT_CANARY",
    });
  });

  it("flags a candidate model-call p95 latency breach over threshold", () => {
    const result = evaluateRollback(
      metrics({ modelCallLatencyP95Ms: 8000 }),
      policy({ latencyP95MaxMs: 5000 }),
    );
    expect(result).toMatchObject({
      shouldRollback: true,
      breachedMetric: "modelCallLatencyP95",
      observedValue: 8000,
      threshold: 5000,
    });
  });

  it("does not breach on exact-threshold equality (fail-safe)", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 1000 }),
      policy({ costPerInvocationMaxMicros: 1000 }),
    );
    expect(result).toEqual({ shouldRollback: false, insufficientData: false });
  });

  it("returns insufficientData below minSampleCount (never triggers)", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 999999, sampleCount: 5 }),
      policy({ costPerInvocationMaxMicros: 1, minSampleCount: 20 }),
    );
    expect(result).toEqual({
      shouldRollback: false,
      insufficientData: true,
      reason: "BELOW_MIN_SAMPLE_COUNT",
    });
  });

  it("never triggers when the policy is disabled, however bad the metric", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 999999 }),
      policy({ enabled: false, costPerInvocationMaxMicros: 1 }),
    );
    expect(result).toEqual({
      shouldRollback: false,
      insufficientData: true,
      reason: "POLICY_DISABLED",
    });
  });

  it("never evaluates a null threshold (not-configured is distinct from 0)", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 999999 }),
      policy({ costPerInvocationMaxMicros: null }),
    );
    expect(result).toEqual({ shouldRollback: false, insufficientData: false });
  });

  it("never triggers errorRate/findingRate/drift when arm attribution is absent (null observed)", () => {
    // D3/D7/D9: these three carry configured ceilings but the reader
    // supplies null observed values today, so they must never fire even
    // over a sufficient sample.
    const result = evaluateRollback(
      metrics({
        errorRate: null,
        policyViolationFindingRate: null,
        driftScore: null,
      }),
      policy({
        errorRateMax: 0.01,
        policyViolationFindingRateMax: 0.01,
        driftScoreMax: 0.1,
      }),
    );
    expect(result).toEqual({ shouldRollback: false, insufficientData: false });
  });

  it("evaluates cost before latency when both breach (deterministic order)", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 2000, modelCallLatencyP95Ms: 9000 }),
      policy({ costPerInvocationMaxMicros: 1000, latencyP95MaxMs: 5000 }),
    );
    expect(result).toMatchObject({ breachedMetric: "costPerInvocation" });
  });

  it("does not roll back a healthy candidate arm", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 500, modelCallLatencyP95Ms: 2000 }),
      policy({ costPerInvocationMaxMicros: 1000, latencyP95MaxMs: 5000 }),
    );
    expect(result).toEqual({ shouldRollback: false, insufficientData: false });
  });

  it("DEFAULT_ROLLBACK_POLICY is opt-in and never triggers", () => {
    const result = evaluateRollback(
      metrics({ costPerInvocationMicros: 999999 }),
      DEFAULT_ROLLBACK_POLICY,
    );
    expect(result).toMatchObject({
      shouldRollback: false,
      insufficientData: true,
    });
  });
});
