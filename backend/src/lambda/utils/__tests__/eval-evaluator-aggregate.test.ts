/**
 * eval-evaluator-aggregate.ts tests (CIT-107) — run-level aggregation for
 * CUSTOM (non-canonical) dimensions, composing alongside the unmodified
 * aggregateScoreVectors() (eval-score-aggregate.ts), which continues to
 * only ever iterate the fixed DIMENSION_ORDER and is not touched by this
 * story. This module discovers whatever custom dimension names actually
 * appear across a run's composed vectors and produces one
 * DimensionAggregate-shaped rollup per custom name — same aggregation
 * rules (boolean passRate vs score meanScore) as the canonical
 * aggregator, minus the latency/cost special-casing (those are reserved
 * canonical names and can never appear here).
 */
import { aggregateCustomDimensions } from "../eval-evaluator-aggregate";
import type { EvaluatorDimensionScore } from "../eval-evaluator-registry";

function row(
  dimension: string,
  overrides: Partial<EvaluatorDimensionScore> = {},
) {
  return {
    dimension,
    status: "SCORED" as const,
    basis: "DETERMINISTIC" as const,
    detail: "d",
    ...overrides,
  };
}

describe("aggregateCustomDimensions", () => {
  it("returns no aggregates when no custom dimensions appear in any row", () => {
    const result = aggregateCustomDimensions([
      { caseId: "c1", scores: [row("task_success")] },
    ]);
    expect(result).toEqual([]);
  });

  it("computes passRate for a boolean-verdict custom dimension", () => {
    const result = aggregateCustomDimensions([
      {
        caseId: "c1",
        scores: [
          row("org.acme.tone", { verdict: { kind: "boolean", pass: true } }),
        ],
      },
      {
        caseId: "c2",
        scores: [
          row("org.acme.tone", { verdict: { kind: "boolean", pass: false } }),
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dimension: "org.acme.tone",
      scoredCount: 2,
      passedCount: 1,
      passRate: 0.5,
    });
  });

  it("computes meanScore for a score-verdict custom dimension", () => {
    const result = aggregateCustomDimensions([
      {
        caseId: "c1",
        scores: [
          row("org.acme.tone", { verdict: { kind: "score", score: 0.2 } }),
        ],
      },
      {
        caseId: "c2",
        scores: [
          row("org.acme.tone", { verdict: { kind: "score", score: 0.8 } }),
        ],
      },
    ]);
    expect(result[0].meanScore).toBeCloseTo(0.5);
  });

  it("excludes NOT_APPLICABLE/UNKNOWN/PENDING rows from scoredCount and rate computation", () => {
    const result = aggregateCustomDimensions([
      {
        caseId: "c1",
        scores: [row("org.acme.tone", { status: "NOT_APPLICABLE" })],
      },
      { caseId: "c2", scores: [row("org.acme.tone", { status: "UNKNOWN" })] },
      {
        caseId: "c3",
        scores: [
          row("org.acme.tone", { verdict: { kind: "boolean", pass: true } }),
        ],
      },
    ]);
    expect(result[0]).toMatchObject({
      dimension: "org.acme.tone",
      notApplicableCount: 1,
      unknownCount: 1,
      scoredCount: 1,
      passRate: 1,
    });
  });

  it("aggregates multiple distinct custom dimensions independently", () => {
    const result = aggregateCustomDimensions([
      {
        caseId: "c1",
        scores: [
          row("org.acme.tone", { verdict: { kind: "boolean", pass: true } }),
          row("org.acme.brevity", { verdict: { kind: "score", score: 0.9 } }),
        ],
      },
    ]);
    const names = result.map((r) => r.dimension).sort();
    expect(names).toEqual(["org.acme.brevity", "org.acme.tone"]);
  });

  it("never crashes on an empty rows array", () => {
    expect(aggregateCustomDimensions([])).toEqual([]);
  });
});
