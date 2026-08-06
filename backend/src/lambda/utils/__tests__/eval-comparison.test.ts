/**
 * eval-comparison.test.ts (CIT-105) — pure baseline-vs-candidate
 * regression-comparison unit tests.
 *
 * Red-Green-Refactor: written before eval-comparison.ts exists. Mirrors
 * eval-drift.test.ts's boundary-test discipline (exact-threshold drop
 * does NOT breach; improvement never breaches; below minSampleCount is
 * insufficient_sample) extended with per-dimension direction-awareness
 * (latency/cost invert — higher is worse), per-case classification,
 * unstable-repeat detection (flagged, never averaged away), and the
 * hard no-composite constraint (no numeric total anywhere in the
 * output).
 */
import * as fc from "fast-check";
import {
  compareRuns,
  DEFAULT_COMPARISON_THRESHOLDS,
  type EvalComparisonCaseRow,
  type EvalComparisonRunInput,
  type ResolvedComparisonThresholds,
} from "../eval-comparison";
import { DIMENSION_ORDER, type DimensionScore } from "../eval-scoring";

function dim(overrides: Partial<DimensionScore>): DimensionScore {
  return {
    dimension: "task_success",
    status: "SCORED",
    basis: "DETERMINISTIC",
    detail: "",
    ...overrides,
  } as DimensionScore;
}

function caseRow(
  caseId: string,
  scores: DimensionScore[],
): EvalComparisonCaseRow {
  return { caseId, scoreVector: scores };
}

function runInput(
  evalRunId: string,
  agentTargetVersion: string,
  cases: EvalComparisonCaseRow[],
  scorerVersion = "v1",
): EvalComparisonRunInput {
  return { evalRunId, agentTargetVersion, scorerVersion, cases };
}

const THRESHOLDS: ResolvedComparisonThresholds = {
  ...DEFAULT_COMPARISON_THRESHOLDS,
  passRateDropThreshold: 0.15,
  meanScoreDropThreshold: 0.15,
  latencyP95IncreaseMsThreshold: 100,
  costIncreaseThreshold: 0.01,
  minSampleCount: 1,
  scoreStabilityBand: 0.05,
};

describe("compareRuns — per-case boolean dimension classification", () => {
  it("classifies pass -> fail as regressed", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.caseCounts.regressed).toBe(1);
    expect(taskSuccess.caseCounts.improved).toBe(0);
  });

  it("classifies fail -> pass as improved", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.caseCounts.improved).toBe(1);
    expect(taskSuccess.caseCounts.regressed).toBe(0);
  });

  it("classifies pass -> pass as unchanged", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.caseCounts.unchanged).toBe(1);
  });
});

describe("compareRuns — score dimension boundary (mirrors eval-drift boundary contract)", () => {
  function scoreDimRun(evalRunId: string, score: number) {
    return runInput(evalRunId, "v", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score },
          measurement: score,
        }),
      ]),
    ]);
  }

  it("regression ONLY when drop strictly > threshold (exact-threshold drop does NOT breach)", () => {
    const baseline = scoreDimRun("base-1", 0.9);
    const candidate = scoreDimRun("cand-1", 0.75); // delta = 0.15 exactly
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const toolAcc = verdict.dimensions.find(
      (d) => d.dimension === "tool_accuracy",
    )!;
    expect(toolAcc.materialRegression).toBe(false);
    expect(toolAcc.direction).toBe("unchanged");
  });

  it("regression when drop is strictly greater than threshold", () => {
    const baseline = scoreDimRun("base-1", 0.9);
    const candidate = scoreDimRun("cand-1", 0.749); // delta = 0.151 > 0.15
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const toolAcc = verdict.dimensions.find(
      (d) => d.dimension === "tool_accuracy",
    )!;
    expect(toolAcc.materialRegression).toBe(true);
    expect(toolAcc.direction).toBe("regressed");
  });

  it("improvement NEVER trips materialRegression regardless of magnitude", () => {
    const baseline = scoreDimRun("base-1", 0.2);
    const candidate = scoreDimRun("cand-1", 0.99);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const toolAcc = verdict.dimensions.find(
      (d) => d.dimension === "tool_accuracy",
    )!;
    expect(toolAcc.materialRegression).toBe(false);
    expect(toolAcc.direction).toBe("improved");
  });
});

describe("compareRuns — direction-aware measurement dimensions (latency/cost, higher=worse)", () => {
  it("latency: p95 increase strictly > threshold is a material regression", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ dimension: "latency", measurement: 500 })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ dimension: "latency", measurement: 650 })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const latency = verdict.dimensions.find((d) => d.dimension === "latency")!;
    expect(latency.materialRegression).toBe(true);
    expect(latency.direction).toBe("regressed");
  });

  it("latency: a decrease is an improvement, never a regression", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ dimension: "latency", measurement: 900 })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ dimension: "latency", measurement: 100 })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const latency = verdict.dimensions.find((d) => d.dimension === "latency")!;
    expect(latency.materialRegression).toBe(false);
    expect(latency.direction).toBe("improved");
  });

  it("cost: meanUsd increase strictly > threshold is a material regression", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ dimension: "cost", measurement: 0.1 })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ dimension: "cost", measurement: 0.15 })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const cost = verdict.dimensions.find((d) => d.dimension === "cost")!;
    expect(cost.materialRegression).toBe(true);
    expect(cost.direction).toBe("regressed");
  });
});

describe("compareRuns — insufficient_sample", () => {
  it("below minSampleCount => materialRegression=false, direction=insufficient_sample", () => {
    const strictThresholds: ResolvedComparisonThresholds = {
      ...THRESHOLDS,
      minSampleCount: 5,
    };
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], strictThresholds);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.materialRegression).toBe(false);
    expect(taskSuccess.direction).toBe("insufficient_sample");
  });
});

describe("compareRuns — incomparable", () => {
  it("baseline SCORED vs candidate UNKNOWN => incomparable, delta null, materialRegression=false", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({ status: "UNKNOWN", verdict: undefined, detail: "unknown" }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.direction).toBe("incomparable");
    expect(taskSuccess.delta).toBeNull();
    expect(taskSuccess.materialRegression).toBe(false);
    expect(taskSuccess.caseCounts.incomparable).toBe(1);
  });

  it("differing verdict kinds (boolean vs score) => incomparable", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({
          dimension: "trajectory",
          verdict: { kind: "boolean", pass: true },
        }),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({
          dimension: "trajectory",
          verdict: { kind: "score", score: 0.8 },
          measurement: 0.8,
        }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const trajectory = verdict.dimensions.find(
      (d) => d.dimension === "trajectory",
    )!;
    expect(trajectory.direction).toBe("incomparable");
  });
});

describe("compareRuns — unstable / flaky repeats (flagged, never averaged away)", () => {
  it("boolean verdict disagreement across repeats => unstable=true, direction=unstable, materialRegression withheld", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat1 = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat2 = runInput("cand-2", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const verdict = compareRuns(baseline, [repeat1, repeat2], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.unstable).toBe(true);
    expect(taskSuccess.direction).toBe("unstable");
    expect(taskSuccess.materialRegression).toBe(false);
    expect(verdict.unstableDimensions).toContain("task_success");
  });

  it("mixed measurability across repeats (SCORED vs UNKNOWN) => unstable=true", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat1 = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat2 = runInput("cand-2", "v2", [
      caseRow("c1", [
        dim({ status: "UNKNOWN", verdict: undefined, detail: "" }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [repeat1, repeat2], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.unstable).toBe(true);
  });

  it("stable repeats (agreeing within band) ARE combined and NOT flagged", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.9 },
          measurement: 0.9,
        }),
      ]),
    ]);
    const repeat1 = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.91 },
          measurement: 0.91,
        }),
      ]),
    ]);
    const repeat2 = runInput("cand-2", "v2", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.89 },
          measurement: 0.89,
        }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [repeat1, repeat2], THRESHOLDS);
    const toolAcc = verdict.dimensions.find(
      (d) => d.dimension === "tool_accuracy",
    )!;
    expect(toolAcc.unstable).toBe(false);
    expect(toolAcc.direction).toBe("unchanged");
  });
});

describe("compareRuns — per-case new/dropped counts", () => {
  it("counts a case present only in candidate as new, and one present only in baseline as dropped", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c2", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c3", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.caseCounts.new).toBe(1);
    expect(taskSuccess.caseCounts.dropped).toBe(1);
    expect(taskSuccess.caseCounts.unchanged).toBe(1);
  });
});

describe("compareRuns — hard no-composite constraint", () => {
  it("never emits a numeric total/composite/overall field anywhere in the verdict", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.9 },
          measurement: 0.9,
        }),
        dim({ dimension: "latency", measurement: 500 }),
        dim({ dimension: "cost", measurement: 0.05 }),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: false } }),
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.5 },
          measurement: 0.5,
        }),
        dim({ dimension: "latency", measurement: 900 }),
        dim({ dimension: "cost", measurement: 0.2 }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toMatch(
      /\b(composite[A-Z_]\w*|overallScore|weightedScore|totalScore)\b/,
    );
    expect(Array.isArray(verdict.dimensions)).toBe(true);
    // verdictStatus is categorical, never a number.
    expect(typeof verdict.verdictStatus).toBe("string");
  });
});

describe("compareRuns — determinism", () => {
  it("is byte-stable across repeated calls on identical input", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (baseScore, candScore) => {
          const baseline = runInput("base-1", "v1", [
            caseRow("c1", [
              dim({
                dimension: "tool_accuracy",
                verdict: { kind: "score", score: baseScore },
                measurement: baseScore,
              }),
            ]),
          ]);
          const candidate = runInput("cand-1", "v2", [
            caseRow("c1", [
              dim({
                dimension: "tool_accuracy",
                verdict: { kind: "score", score: candScore },
                measurement: candScore,
              }),
            ]),
          ]);
          const v1 = compareRuns(baseline, [candidate], THRESHOLDS);
          const v2 = compareRuns(baseline, [candidate], THRESHOLDS);
          expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
        },
      ),
    );
  });
});

describe("compareRuns — canonical ordering", () => {
  it("dimensions are always emitted in DIMENSION_ORDER regardless of input order", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({ dimension: "cost", measurement: 0.1 }),
        dim({
          dimension: "task_success",
          verdict: { kind: "boolean", pass: true },
        }),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({
          dimension: "task_success",
          verdict: { kind: "boolean", pass: true },
        }),
        dim({ dimension: "cost", measurement: 0.1 }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    expect(verdict.dimensions.map((d) => d.dimension)).toEqual(DIMENSION_ORDER);
  });

  it("candidateEvalRunIds are sorted regardless of input order", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candB = runInput("cand-b", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candA = runInput("cand-a", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candB, candA], THRESHOLDS);
    expect(verdict.candidateEvalRunIds).toEqual(["cand-a", "cand-b"]);
  });
});

describe("compareRuns — rollups", () => {
  it("anyMaterialRegression is the OR over all dimensions' materialRegression", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        dim({ dimension: "latency", measurement: 500 }),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        dim({ dimension: "latency", measurement: 700 }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    expect(verdict.anyMaterialRegression).toBe(true);
    expect(verdict.materiallyRegressedDimensions).toEqual(["latency"]);
  });

  it("verdictStatus derivation precedence: REGRESSED > UNSTABLE > INCOMPARABLE > PASS", () => {
    // regressed alone
    const baselineReg = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.9 },
          measurement: 0.9,
        }),
      ]),
    ]);
    const candidateReg = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.5 },
          measurement: 0.5,
        }),
      ]),
    ]);
    const regressedVerdict = compareRuns(
      baselineReg,
      [candidateReg],
      THRESHOLDS,
    );
    expect(regressedVerdict.verdictStatus).toBe("REGRESSED");

    // unstable alone (no regression elsewhere)
    const baselineUnstable = runInput("base-2", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat1 = runInput("cand-2", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const repeat2 = runInput("cand-3", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const unstableVerdict = compareRuns(
      baselineUnstable,
      [repeat1, repeat2],
      THRESHOLDS,
    );
    expect(unstableVerdict.verdictStatus).toBe("UNSTABLE");

    // pass (all unchanged/improved) — score every dimension identically
    // NOT_APPLICABLE so the whole vector agrees baseline<->candidate
    // (a case that legitimately opts out of every other dimension).
    const naVector = (): DimensionScore[] =>
      DIMENSION_ORDER.filter((d) => d !== "task_success").map((d) =>
        dim({ dimension: d, status: "NOT_APPLICABLE", verdict: undefined }),
      );
    const baselinePass = runInput("base-3", "v1", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        ...naVector(),
      ]),
    ]);
    const candidatePass = runInput("cand-4", "v2", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        ...naVector(),
      ]),
    ]);
    const passVerdict = compareRuns(baselinePass, [candidatePass], THRESHOLDS);
    expect(passVerdict.verdictStatus).toBe("PASS");
  });
});

describe("compareRuns — per-case deltas exposed on the dimension (verify blocking-1)", () => {
  it("exposes a perCase array with caseId, classification, baselineValue, candidateValue for a score dimension", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.9 },
          measurement: 0.9,
        }),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.5 },
          measurement: 0.5,
        }),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const toolAcc = verdict.dimensions.find(
      (d) => d.dimension === "tool_accuracy",
    )!;
    expect(Array.isArray(toolAcc.perCase)).toBe(true);
    expect(toolAcc.perCase).toEqual([
      {
        caseId: "c1",
        classification: "regressed",
        baselineValue: 0.9,
        candidateValue: 0.5,
      },
    ]);
  });

  it("exposes perCase rows for new/dropped cases with null values", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c2", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c3", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    const byId = new Map(taskSuccess.perCase.map((p) => [p.caseId, p]));
    expect(byId.get("c2")).toEqual({
      caseId: "c2",
      classification: "dropped",
      baselineValue: null,
      candidateValue: null,
    });
    expect(byId.get("c3")).toEqual({
      caseId: "c3",
      classification: "new",
      baselineValue: null,
      candidateValue: null,
    });
  });

  it("perCase rows are sorted by caseId regardless of input case order", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("cZ", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("cA", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("cZ", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("cA", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.perCase.map((p) => p.caseId)).toEqual(["cA", "cZ"]);
  });

  it("perCase length equals the total joined case count for the dimension", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c2", [dim({ verdict: { kind: "boolean", pass: false } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
      caseRow("c2", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    const taskSuccess = verdict.dimensions.find(
      (d) => d.dimension === "task_success",
    )!;
    expect(taskSuccess.perCase).toHaveLength(2);
  });
});

describe("compareRuns — no false-green verdict on zero evidence (verify blocking-2)", () => {
  it("zero candidate repeats => verdictStatus is NOTHING_TO_COMPARE, not PASS", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [], THRESHOLDS);
    expect(verdict.verdictStatus).toBe("NOTHING_TO_COMPARE");
    expect(verdict.anyMaterialRegression).toBe(false);
  });

  it("empty baseline (first-ever run, all cases new) => verdictStatus is NOTHING_TO_COMPARE, not PASS", () => {
    const baseline = runInput("base-1", "v1", []);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    expect(verdict.verdictStatus).toBe("NOTHING_TO_COMPARE");
    expect(verdict.anyMaterialRegression).toBe(false);
  });

  it("both baseline and candidates entirely empty (no cases anywhere) => NOTHING_TO_COMPARE", () => {
    const baseline = runInput("base-1", "v1", []);
    const candidate = runInput("cand-1", "v2", []);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    expect(verdict.verdictStatus).toBe("NOTHING_TO_COMPARE");
  });

  it("a real overlapping-case comparison with genuine agreement still yields PASS (not falsely NOTHING_TO_COMPARE)", () => {
    const naVector = (): DimensionScore[] =>
      DIMENSION_ORDER.filter((d) => d !== "task_success").map((d) =>
        dim({ dimension: d, status: "NOT_APPLICABLE", verdict: undefined }),
      );
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        ...naVector(),
      ]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [
        dim({ verdict: { kind: "boolean", pass: true } }),
        ...naVector(),
      ]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    // task_success dimension has 1 genuinely joined+unchanged case, and
    // every other dimension agrees NOT_APPLICABLE on both sides — a
    // stable, honest agreement. repeatCount > 0 and a case is jointly
    // present, so this must NOT collapse to NOTHING_TO_COMPARE.
    expect(verdict.verdictStatus).toBe("PASS");
  });
});

describe("compareRuns — thresholds echoed for reproducibility", () => {
  it("echoes the resolved thresholds into the verdict", () => {
    const baseline = runInput("base-1", "v1", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const candidate = runInput("cand-1", "v2", [
      caseRow("c1", [dim({ verdict: { kind: "boolean", pass: true } })]),
    ]);
    const verdict = compareRuns(baseline, [candidate], THRESHOLDS);
    expect(verdict.thresholds).toEqual(THRESHOLDS);
  });
});
