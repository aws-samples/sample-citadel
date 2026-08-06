/**
 * eval-score-aggregate.test.ts (CIT-103 Pass A) — unit tests for the pure
 * aggregateScoreVectors() run-level rollup. Mirrors cost-aggregate.ts's
 * priced-only/UNKNOWN-excluded discipline (design §4).
 */
import {
  aggregateScoreVectors,
  type CaseScoreRowForAggregation,
} from "../src/lambda/utils/eval-score-aggregate";
import type { DimensionScore } from "../src/lambda/utils/eval-scoring";

function dim(overrides: Partial<DimensionScore>): DimensionScore {
  return {
    dimension: "task_success",
    status: "SCORED",
    basis: "DETERMINISTIC",
    detail: "",
    ...overrides,
  } as DimensionScore;
}

function caseRow(scoreVector: DimensionScore[]): CaseScoreRowForAggregation {
  return { caseId: "c", scoreVector };
}

describe("aggregateScoreVectors — boolean dimensions (passRate)", () => {
  it("computes passRate over SCORED cases only, excluding UNKNOWN/NOT_APPLICABLE/PENDING", () => {
    const rows = [
      caseRow([
        dim({
          dimension: "task_success",
          verdict: { kind: "boolean", pass: true },
        }),
      ]),
      caseRow([
        dim({
          dimension: "task_success",
          verdict: { kind: "boolean", pass: false },
        }),
      ]),
      caseRow([dim({ dimension: "task_success", status: "NOT_APPLICABLE" })]),
      caseRow([dim({ dimension: "task_success", status: "UNKNOWN" })]),
      caseRow([
        dim({ dimension: "task_success", status: "PENDING", basis: "JUDGE" }),
      ]),
    ];
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "task_success")!;
    expect(agg.scoredCount).toBe(2);
    expect(agg.passedCount).toBe(1);
    expect(agg.passRate).toBeCloseTo(0.5, 6);
    expect(agg.notApplicableCount).toBe(1);
    expect(agg.unknownCount).toBe(1);
    expect(agg.pendingCount).toBe(1);
  });

  it("passRate is undefined when zero SCORED cases exist for the dimension", () => {
    const rows = [
      caseRow([dim({ dimension: "task_success", status: "NOT_APPLICABLE" })]),
    ];
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "task_success")!;
    expect(agg.passRate).toBeUndefined();
    expect(agg.scoredCount).toBe(0);
  });
});

describe("aggregateScoreVectors — score dimensions (meanScore)", () => {
  it("computes meanScore over SCORED cases for tool_accuracy", () => {
    const rows = [
      caseRow([
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 1 },
        }),
      ]),
      caseRow([
        dim({
          dimension: "tool_accuracy",
          verdict: { kind: "score", score: 0.5 },
        }),
      ]),
      caseRow([dim({ dimension: "tool_accuracy", status: "NOT_APPLICABLE" })]),
    ];
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "tool_accuracy")!;
    expect(agg.meanScore).toBeCloseTo(0.75, 6);
    expect(agg.scoredCount).toBe(2);
    expect(agg.notApplicableCount).toBe(1);
  });
});

describe("aggregateScoreVectors — latency (p50/p95)", () => {
  it("computes p50/p95 over SCORED measurements, excluding UNKNOWN", () => {
    const measurements = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const rows = measurements.map((m) =>
      caseRow([
        dim({ dimension: "latency", status: "SCORED", measurement: m }),
      ]),
    );
    rows.push(caseRow([dim({ dimension: "latency", status: "UNKNOWN" })]));
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "latency")!;
    expect(agg.p50).toBe(500);
    expect(agg.p95).toBe(1000);
    expect(agg.scoredCount).toBe(10);
    expect(agg.unknownCount).toBe(1);
  });
});

describe("aggregateScoreVectors — cost (sumUsd/meanUsd/unpricedCount)", () => {
  it("sums/means only priced (SCORED) rows and separately counts UNKNOWN (unpriced)", () => {
    const rows = [
      caseRow([dim({ dimension: "cost", status: "SCORED", measurement: 0.1 })]),
      caseRow([dim({ dimension: "cost", status: "SCORED", measurement: 0.2 })]),
      caseRow([dim({ dimension: "cost", status: "UNKNOWN" })]),
    ];
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "cost")!;
    expect(agg.sumUsd).toBeCloseTo(0.3, 6);
    expect(agg.meanUsd).toBeCloseTo(0.15, 6);
    expect(agg.unknownCount).toBe(1);
    expect(agg.scoredCount).toBe(2);
  });

  it("sumUsd/meanUsd are undefined when every row is UNKNOWN (never fabricate zero)", () => {
    const rows = [caseRow([dim({ dimension: "cost", status: "UNKNOWN" })])];
    const result = aggregateScoreVectors(rows);
    const agg = result.find((a) => a.dimension === "cost")!;
    expect(agg.sumUsd).toBeUndefined();
    expect(agg.meanUsd).toBeUndefined();
    expect(agg.unknownCount).toBe(1);
  });
});

describe("aggregateScoreVectors — no rows for a dimension across the whole run", () => {
  it("still emits a zeroed aggregate entry for every DIMENSION_ORDER dimension", () => {
    const result = aggregateScoreVectors([]);
    expect(result.map((a) => a.dimension)).toEqual([
      "task_success",
      "policy_compliance",
      "tool_accuracy",
      "latency",
      "cost",
      "groundedness_citation",
      "groundedness_faithfulness",
      "trajectory",
    ]);
    for (const agg of result) {
      expect(agg.scoredCount).toBe(0);
      expect(agg.notApplicableCount).toBe(0);
      expect(agg.unknownCount).toBe(0);
      expect(agg.pendingCount).toBe(0);
    }
  });
});

describe("aggregateScoreVectors — purity", () => {
  it("does not mutate input case rows", () => {
    const rows = [
      caseRow([
        dim({
          dimension: "task_success",
          verdict: { kind: "boolean", pass: true },
        }),
      ]),
    ];
    const before = JSON.stringify(rows);
    aggregateScoreVectors(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
