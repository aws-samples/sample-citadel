/**
 * release-gate.test.ts — pure gate-evaluator + promotion-policy unit
 * tests.
 *
 * Red-Green-Refactor: written before release-gate.ts exists.
 *
 * Consumes existing verdict/aggregate types verbatim — never recomputes
 * regression or scoring:
 *   - EvalComparisonVerdict.{verdictStatus,anyMaterialRegression,
 *     materiallyRegressedDimensions}
 *   - EvalComparisonDimension.materialRegression
 *   - DimensionAggregate fields (eval-score-aggregate.ts)
 *   - EvalSuite.{gateClass,version,status}
 *
 * Fail-closed discipline: missing/unreadable/stale evidence must never
 * read as a pass. NO_BASELINE is a distinct outcome from a regression —
 * never conflated — and the policy decides whether NO_BASELINE may pass
 * on absolute floors alone.
 */
import {
  assessStaleness,
  evaluateReleaseGate,
  DEFAULT_PROMOTION_POLICY,
  type PromotionPolicy,
  type ReleaseGateInputs,
} from "../release-gate";
import type {
  EvalComparisonDimension,
  EvalComparisonVerdict,
} from "../eval-comparison";
import type { DimensionAggregate } from "../eval-score-aggregate";
import type { EvalSuite, EvalSuiteStatusLiteral } from "../../../types";

function dimension(
  overrides: Partial<EvalComparisonDimension>,
): EvalComparisonDimension {
  return {
    dimension: "task_success",
    direction: "unchanged",
    materialRegression: false,
    unstable: false,
    baselineStat: 0.95,
    candidateStat: 0.95,
    delta: 0,
    caseCounts: {
      improved: 0,
      regressed: 0,
      unstable: 0,
      unchanged: 10,
      incomparable: 0,
      new: 0,
      dropped: 0,
    },
    perCase: [],
    ...overrides,
  };
}

function verdict(
  overrides: Partial<EvalComparisonVerdict>,
): EvalComparisonVerdict {
  return {
    baselineEvalRunId: "baseline-run",
    baselineAgentTargetVersion: "v1",
    candidateEvalRunIds: ["candidate-run"],
    candidateAgentTargetVersion: "v2",
    repeatCount: 1,
    scorerVersions: ["v1"],
    thresholds: {
      passRateDropThreshold: 0.15,
      meanScoreDropThreshold: 0.15,
      latencyP95IncreaseMsThreshold: 500,
      costIncreaseThreshold: 0.05,
      minSampleCount: 10,
      scoreStabilityBand: 0.05,
    },
    dimensions: [dimension({})],
    anyMaterialRegression: false,
    materiallyRegressedDimensions: [],
    unstableDimensions: [],
    verdictStatus: "PASS",
    ...overrides,
  };
}

function aggregate(overrides: Partial<DimensionAggregate>): DimensionAggregate {
  return {
    dimension: "task_success",
    scoredCount: 10,
    notApplicableCount: 0,
    unknownCount: 0,
    pendingCount: 0,
    passedCount: 10,
    passRate: 1.0,
    ...overrides,
  };
}

function suite(overrides: Partial<EvalSuite>): EvalSuite {
  return {
    suiteId: "suite-1",
    orgId: "org-1",
    agentTargetId: "agent-1",
    name: "Suite",
    description: "",
    semver: "1.0.0",
    status: "FROZEN",
    version: 1,
    references: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "tester",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function basePolicy(overrides: Partial<PromotionPolicy> = {}): PromotionPolicy {
  return {
    ...DEFAULT_PROMOTION_POLICY,
    ...overrides,
  };
}

function baseInputs(
  overrides: Partial<ReleaseGateInputs> = {},
): ReleaseGateInputs {
  return {
    hasBaseline: true,
    comparisonVerdict: verdict({}),
    candidateAggregates: [aggregate({})],
    pinnedSuiteVersion: 1,
    liveSuite: suite({}),
    runCompletedAt: "2026-01-01T00:00:00.000Z",
    now: "2026-01-01T01:00:00.000Z",
    policy: basePolicy(),
    ...overrides,
  };
}

describe("assessStaleness", () => {
  const policy = basePolicy({ maxEvidenceAgeDays: 7 });

  it("is not stale when pinned version matches live version, suite is frozen, and run is within max age", () => {
    const result = assessStaleness(
      1,
      suite({ version: 1, status: "FROZEN" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.stale).toBe(false);
  });

  it("is stale when pinned suite version is behind the live suite version", () => {
    const result = assessStaleness(
      1,
      suite({ version: 2, status: "FROZEN" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("SUITE_VERSION_SUPERSEDED");
  });

  it("is stale when the live suite is no longer FROZEN (e.g. ARCHIVED)", () => {
    const notFrozen: EvalSuiteStatusLiteral = "ARCHIVED";
    const result = assessStaleness(
      1,
      suite({ version: 1, status: notFrozen }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("SUITE_NOT_FROZEN");
  });

  it("is stale when the run completed longer ago than maxEvidenceAgeDays", () => {
    const result = assessStaleness(
      1,
      suite({ version: 1, status: "FROZEN" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-10T00:00:00.000Z",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("EVIDENCE_TOO_OLD");
  });

  it("reports both reasons when superseded AND aged", () => {
    const result = assessStaleness(
      1,
      suite({ version: 5, status: "ARCHIVED" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-10T00:00:00.000Z",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "SUITE_VERSION_SUPERSEDED",
        "SUITE_NOT_FROZEN",
        "EVIDENCE_TOO_OLD",
      ]),
    );
  });

  it("age boundary: exactly maxEvidenceAgeDays old is not stale (strictly-greater-than breaches)", () => {
    const result = assessStaleness(
      1,
      suite({ version: 1, status: "FROZEN" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "2026-01-08T00:00:00.000Z",
    );
    expect(result.stale).toBe(false);
  });

  it("is stale (EVIDENCE_UNREADABLE) when runCompletedAt is a malformed timestamp, never a silent pass", () => {
    const result = assessStaleness(
      1,
      suite({ version: 1, status: "FROZEN" }),
      "not-a-timestamp",
      policy,
      "2026-01-02T00:00:00.000Z",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("EVIDENCE_UNREADABLE");
    expect(result.reasons).not.toContain("EVIDENCE_TOO_OLD");
  });

  it("is stale (EVIDENCE_UNREADABLE) when now is a malformed timestamp, never a silent pass", () => {
    const result = assessStaleness(
      1,
      suite({ version: 1, status: "FROZEN" }),
      "2026-01-01T00:00:00.000Z",
      policy,
      "not-a-timestamp",
    );
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("EVIDENCE_UNREADABLE");
    expect(result.reasons).not.toContain("EVIDENCE_TOO_OLD");
  });
});

describe("evaluateReleaseGate — regression consumed from verdict, never recomputed", () => {
  it("passes when verdictStatus is PASS, thresholds are met, and not stale", () => {
    const result = evaluateReleaseGate(baseInputs());
    expect(result.status).toBe("PASS");
  });

  it("fails when verdictStatus is REGRESSED, even if a fixture's raw deltas would look fine", () => {
    // The dimension's own delta/stat fields look like an improvement,
    // but verdictStatus (the thing the gate must defer to) says
    // REGRESSED — the gate must fail on verdictStatus, not re-derive
    // from delta.
    const result = evaluateReleaseGate(
      baseInputs({
        comparisonVerdict: verdict({
          verdictStatus: "REGRESSED",
          anyMaterialRegression: true,
          materiallyRegressedDimensions: ["task_success"],
          dimensions: [
            dimension({
              dimension: "task_success",
              materialRegression: true,
              delta: 0.5, // looks like an improvement if you only read delta
            }),
          ],
        }),
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("MATERIAL_REGRESSION");
  });

  it("fails when verdictStatus is UNSTABLE", () => {
    const result = evaluateReleaseGate(
      baseInputs({ comparisonVerdict: verdict({ verdictStatus: "UNSTABLE" }) }),
    );
    expect(result.status).toBe("FAIL");
  });

  it("fails when verdictStatus is INCOMPARABLE", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        comparisonVerdict: verdict({ verdictStatus: "INCOMPARABLE" }),
      }),
    );
    expect(result.status).toBe("FAIL");
  });

  it("fails closed on NOTHING_TO_COMPARE (not the same code path as NO_BASELINE)", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        comparisonVerdict: verdict({ verdictStatus: "NOTHING_TO_COMPARE" }),
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("NOTHING_TO_COMPARE");
  });
});

describe("evaluateReleaseGate — absolute thresholds", () => {
  it("fails when a gated dimension's passRate is below the policy minimum", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        candidateAggregates: [aggregate({ passRate: 0.5, passedCount: 5 })],
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.failedThresholds).toContain("task_success");
  });

  it("fails when a gated dimension has fewer scored cases than minSampleCount (no evidence for that dim)", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        candidateAggregates: [
          aggregate({ scoredCount: 1, passedCount: 1, passRate: 1 }),
        ],
      }),
    );
    expect(result.status).toBe("FAIL");
  });

  it("fails when latency p95 exceeds the policy target", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        candidateAggregates: [
          aggregate({}),
          aggregate({ dimension: "latency", p95: 99999, scoredCount: 10 }),
        ],
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.failedThresholds).toContain("latency");
  });

  it("fails when mean cost exceeds the policy budget", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        candidateAggregates: [
          aggregate({}),
          aggregate({ dimension: "cost", meanUsd: 999, scoredCount: 10 }),
        ],
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.failedThresholds).toContain("cost");
  });
});

describe("evaluateReleaseGate — gateClass required packs", () => {
  it("fails when a required gateClass pack is missing from the resolved suite", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        policy: basePolicy({ requiredGateClasses: ["adversarial-injection"] }),
        liveSuite: suite({ gateClass: undefined }),
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.requiredPacksSatisfied).toBe(false);
  });

  it("passes the pack check when the resolved suite's gateClass matches a required class", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        policy: basePolicy({ requiredGateClasses: ["adversarial-injection"] }),
        liveSuite: suite({ gateClass: "adversarial-injection" }),
      }),
    );
    expect(result.requiredPacksSatisfied).toBe(true);
    expect(result.status).toBe("PASS");
  });
});

describe("evaluateReleaseGate — fail-closed on stale evidence", () => {
  it("fails when the pinned suite version is behind the live suite version", () => {
    const result = evaluateReleaseGate(
      baseInputs({ pinnedSuiteVersion: 1, liveSuite: suite({ version: 2 }) }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.staleness.stale).toBe(true);
  });

  it("fails when the run completed longer ago than the policy's max evidence age", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        runCompletedAt: "2020-01-01T00:00:00.000Z",
        now: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.staleness.stale).toBe(true);
  });

  it("fails when the suite is no longer FROZEN even if the version matches", () => {
    const result = evaluateReleaseGate(
      baseInputs({ liveSuite: suite({ version: 1, status: "ARCHIVED" }) }),
    );
    expect(result.status).toBe("FAIL");
  });
});

describe("evaluateReleaseGate — NO_BASELINE (amendment)", () => {
  it("returns a distinct NO_BASELINE status, never FAIL, when hasBaseline is false", () => {
    const result = evaluateReleaseGate(baseInputs({ hasBaseline: false }));
    expect(result.status).toBe("NO_BASELINE");
  });

  it("NO_BASELINE is never reported as a regression", () => {
    const result = evaluateReleaseGate(baseInputs({ hasBaseline: false }));
    expect(result.status).not.toBe("FAIL");
    expect(result.reasons).not.toContain("MATERIAL_REGRESSION");
    expect(result.reasons).not.toContain("NOTHING_TO_COMPARE");
  });

  it("carries a machine-readable reason on the NO_BASELINE outcome", () => {
    const result = evaluateReleaseGate(baseInputs({ hasBaseline: false }));
    expect(result.reasons).toContain("NO_BASELINE");
  });

  it("policy setting allowNoBaselineOnAbsoluteFloors=false: NO_BASELINE never resolves to a pass, even with perfect absolute scores", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({ allowNoBaselineOnAbsoluteFloors: false }),
      }),
    );
    expect(result.status).toBe("NO_BASELINE");
    expect(result.reasons).toContain("NO_BASELINE_BOOTSTRAP_DISABLED");
  });

  it("policy setting allowNoBaselineOnAbsoluteFloors=true: NO_BASELINE with absolute floors met resolves to NO_BASELINE_PASS", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({ allowNoBaselineOnAbsoluteFloors: true }),
      }),
    );
    expect(result.status).toBe("NO_BASELINE_PASS");
  });

  it("policy setting allowNoBaselineOnAbsoluteFloors=true but absolute floors NOT met: stays NO_BASELINE, not a silent pass", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({ allowNoBaselineOnAbsoluteFloors: true }),
        candidateAggregates: [aggregate({ passRate: 0.1, passedCount: 1 })],
      }),
    );
    expect(result.status).toBe("NO_BASELINE");
    expect(result.status).not.toBe("NO_BASELINE_PASS");
  });

  it("policy setting allowNoBaselineOnAbsoluteFloors=true but required gateClass pack missing: stays NO_BASELINE", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({
          allowNoBaselineOnAbsoluteFloors: true,
          requiredGateClasses: ["adversarial-injection"],
        }),
        liveSuite: suite({ gateClass: undefined }),
      }),
    );
    expect(result.status).toBe("NO_BASELINE");
  });

  it("policy setting allowNoBaselineOnAbsoluteFloors=true but evidence is stale: fails closed, not NO_BASELINE_PASS", () => {
    const result = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({ allowNoBaselineOnAbsoluteFloors: true }),
        liveSuite: suite({ version: 2 }),
        pinnedSuiteVersion: 1,
      }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.staleness.stale).toBe(true);
  });

  it("NO_BASELINE_PASS is still distinguishable from an ordinary comparison PASS", () => {
    const noBaseline = evaluateReleaseGate(
      baseInputs({
        hasBaseline: false,
        policy: basePolicy({ allowNoBaselineOnAbsoluteFloors: true }),
      }),
    );
    const withBaseline = evaluateReleaseGate(baseInputs({ hasBaseline: true }));
    expect(noBaseline.status).toBe("NO_BASELINE_PASS");
    expect(withBaseline.status).toBe("PASS");
    expect(noBaseline.status).not.toBe(withBaseline.status);
  });
});

describe("evaluateReleaseGate — score vector always attached", () => {
  it("attaches the candidate aggregates as the scoreVector regardless of outcome", () => {
    const result = evaluateReleaseGate(baseInputs());
    expect(result.scoreVector).toEqual([aggregate({})]);
  });
});

describe("evaluateReleaseGate — property: PASS requires every gated condition", () => {
  it("PASS implies verdictStatus PASS AND not stale AND packs satisfied AND thresholds met", () => {
    const result = evaluateReleaseGate(baseInputs());
    expect(result.status).toBe("PASS");
    expect(result.staleness.stale).toBe(false);
    expect(result.requiredPacksSatisfied).toBe(true);
    expect(result.failedThresholds).toEqual([]);
  });
});
