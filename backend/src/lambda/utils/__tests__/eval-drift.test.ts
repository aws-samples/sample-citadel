/**
 * eval-drift.test.ts (Phase 3 §3.1) — pure drift-math unit tests.
 *
 * Red-Green-Refactor: written before eval-drift.ts exists. Covers
 * baseline-vs-current comparison for both passRate (boolean-verdict
 * dimensions) and meanScore (score-verdict dimensions), the exact
 * threshold boundary (delta === threshold must NOT breach; only a
 * delta STRICTLY GREATER than threshold breaches — dev-calibrated,
 * TUNE with prod baseline), the sampleCount floor guard, and full
 * determinism (same inputs -> byte-identical output, no Date.now/
 * Math.random anywhere in the pure module).
 */
import * as fc from "fast-check";
import {
  computeDrift,
  aggregateDimStat,
  DEFAULT_DRIFT_THRESHOLDS,
  DEFAULT_MIN_SAMPLE_COUNT,
  type DimStat,
  type ProdSampleDimensionRow,
} from "../eval-drift";

describe("computeDrift", () => {
  it("reports no breach when current matches baseline exactly", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 50 };
    const current: DimStat = { passRate: 0.95, sampleCount: 50 };
    const result = computeDrift(baseline, current);
    expect(result.breached).toBe(false);
    expect(result.delta).toBe(0);
    expect(result.direction).toBe("none");
  });

  it("detects a regression (current passRate below baseline) as a breach past threshold", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 50 };
    const current: DimStat = { passRate: 0.7, sampleCount: 50 };
    const result = computeDrift(baseline, current, { passRate: 0.15 });
    expect(result.breached).toBe(true);
    expect(result.direction).toBe("regression");
    expect(result.delta).toBeCloseTo(0.25, 6);
  });

  it("does not breach when the drop is within threshold", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 50 };
    const current: DimStat = { passRate: 0.85, sampleCount: 50 };
    const result = computeDrift(baseline, current, { passRate: 0.15 });
    expect(result.breached).toBe(false);
    expect(result.delta).toBeCloseTo(0.1, 6);
  });

  it("treats an IMPROVEMENT (current above baseline) as non-breaching regardless of magnitude", () => {
    const baseline: DimStat = { passRate: 0.5, sampleCount: 50 };
    const current: DimStat = { passRate: 0.99, sampleCount: 50 };
    const result = computeDrift(baseline, current, { passRate: 0.15 });
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("improvement");
  });

  it("exact threshold boundary: delta === threshold does NOT breach (strictly greater required)", () => {
    const baseline: DimStat = { passRate: 0.9, sampleCount: 50 };
    const current: DimStat = { passRate: 0.75, sampleCount: 50 }; // delta = 0.15 exactly
    const result = computeDrift(baseline, current, { passRate: 0.15 });
    expect(result.delta).toBeCloseTo(0.15, 6);
    expect(result.breached).toBe(false);
  });

  it("exact threshold boundary: delta just above threshold DOES breach", () => {
    const baseline: DimStat = { passRate: 0.9, sampleCount: 50 };
    const current: DimStat = { passRate: 0.749, sampleCount: 50 }; // delta = 0.151 > 0.15
    const result = computeDrift(baseline, current, { passRate: 0.15 });
    expect(result.delta).toBeCloseTo(0.151, 6);
    expect(result.breached).toBe(true);
  });

  it("exact threshold boundary for the meanScore kind: delta === threshold does NOT breach (per-kind threshold resolution)", () => {
    const baseline: DimStat = { meanScore: 0.9, sampleCount: 50 };
    const current: DimStat = { meanScore: 0.75, sampleCount: 50 }; // delta = 0.15 exactly
    const result = computeDrift(baseline, current, { meanScore: 0.15 });
    expect(result.delta).toBeCloseTo(0.15, 6);
    expect(result.breached).toBe(false);
  });

  it("exact threshold boundary for the meanScore kind: delta just above threshold DOES breach", () => {
    const baseline: DimStat = { meanScore: 0.9, sampleCount: 50 };
    const current: DimStat = { meanScore: 0.749, sampleCount: 50 }; // delta = 0.151 > 0.15
    const result = computeDrift(baseline, current, { meanScore: 0.15 });
    expect(result.delta).toBeCloseTo(0.151, 6);
    expect(result.breached).toBe(true);
  });

  it("uses meanScore (not passRate) when the stat carries meanScore", () => {
    const baseline: DimStat = { meanScore: 0.8, sampleCount: 50 };
    const current: DimStat = { meanScore: 0.5, sampleCount: 50 };
    const result = computeDrift(baseline, current, { meanScore: 0.15 });
    expect(result.breached).toBe(true);
    expect(result.delta).toBeCloseTo(0.3, 6);
  });

  it("never breaches when current.sampleCount is below the minimum floor (small-N noise guard)", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 50 };
    const current: DimStat = { passRate: 0.1, sampleCount: 3 };
    const result = computeDrift(baseline, current, { passRate: 0.05 }, 10);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("insufficient_sample");
  });

  it("never breaches when baseline.sampleCount is below the minimum floor", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 2 };
    const current: DimStat = { passRate: 0.1, sampleCount: 50 };
    const result = computeDrift(baseline, current, { passRate: 0.05 }, 10);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("insufficient_sample");
  });

  it("uses DEFAULT_MIN_SAMPLE_COUNT when no floor is supplied", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 1 };
    const current: DimStat = { passRate: 0.1, sampleCount: 1 };
    const result = computeDrift(baseline, current);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("insufficient_sample");
    expect(DEFAULT_MIN_SAMPLE_COUNT).toBeGreaterThan(1);
  });

  it("is UNKNOWN (never breaches, never fabricates a delta) when neither stat has a comparable measurement", () => {
    const baseline: DimStat = { sampleCount: 50 };
    const current: DimStat = { sampleCount: 50 };
    const result = computeDrift(baseline, current);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("unknown");
    expect(result.delta).toBeNull();
  });

  it("is UNKNOWN when baseline has passRate but current has meanScore (incomparable measurement kinds)", () => {
    const baseline: DimStat = { passRate: 0.9, sampleCount: 50 };
    const current: DimStat = { meanScore: 0.5, sampleCount: 50 };
    const result = computeDrift(baseline, current);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("unknown");
    expect(result.delta).toBeNull();
  });

  it("falls back to DEFAULT_DRIFT_THRESHOLDS when no threshold override is supplied", () => {
    const baseline: DimStat = { passRate: 0.95, sampleCount: 50 };
    const current: DimStat = {
      passRate: 0.95 - DEFAULT_DRIFT_THRESHOLDS.passRate - 0.01,
      sampleCount: 50,
    };
    const result = computeDrift(baseline, current);
    expect(result.breached).toBe(true);
  });

  it("is deterministic: identical inputs produce byte-identical (JSON-equal) output across repeated calls", () => {
    const baseline: DimStat = { passRate: 0.833333, sampleCount: 42 };
    const current: DimStat = { passRate: 0.611111, sampleCount: 37 };
    const a = computeDrift(baseline, current, { passRate: 0.1 });
    const b = computeDrift(baseline, current, { passRate: 0.1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("computeDrift — property-based", () => {
  it("delta is always the absolute difference between comparable measurements when both are present", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (baselineRate, currentRate, baselineCount, currentCount) => {
          const result = computeDrift(
            { passRate: baselineRate, sampleCount: baselineCount },
            { passRate: currentRate, sampleCount: currentCount },
          );
          if (result.delta !== null) {
            expect(result.delta).toBeCloseTo(
              Math.abs(baselineRate - currentRate),
              5,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("breached is always false when currentRate >= baselineRate (never flags an improvement)", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (baselineRate, delta) => {
          const currentRate = Math.min(1, baselineRate + Math.abs(delta));
          const result = computeDrift(
            { passRate: baselineRate, sampleCount: 100 },
            { passRate: currentRate, sampleCount: 100 },
            { passRate: 0 },
          );
          expect(result.breached).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is purely deterministic across repeated invocations for any input pair", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (baselineRate, currentRate, baselineCount, currentCount) => {
          const baseline: DimStat = {
            passRate: baselineRate,
            sampleCount: baselineCount,
          };
          const current: DimStat = {
            passRate: currentRate,
            sampleCount: currentCount,
          };
          const a = computeDrift(baseline, current);
          const b = computeDrift(baseline, current);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("aggregateDimStat", () => {
  it("computes passRate from boolean-verdict SCORED rows only", () => {
    const rows: ProdSampleDimensionRow[] = [
      { status: "SCORED", verdict: { kind: "boolean", pass: true } },
      { status: "SCORED", verdict: { kind: "boolean", pass: true } },
      { status: "SCORED", verdict: { kind: "boolean", pass: false } },
      { status: "SCORED", verdict: { kind: "boolean", pass: true } },
    ];
    const stat = aggregateDimStat(rows);
    expect(stat.passRate).toBeCloseTo(0.75, 6);
    expect(stat.meanScore).toBeUndefined();
    expect(stat.sampleCount).toBe(4);
  });

  it("computes meanScore from score-verdict SCORED rows only", () => {
    const rows: ProdSampleDimensionRow[] = [
      { status: "SCORED", verdict: { kind: "score", score: 1 } },
      { status: "SCORED", verdict: { kind: "score", score: 0.5 } },
      { status: "SCORED", verdict: { kind: "score", score: 0 } },
    ];
    const stat = aggregateDimStat(rows);
    expect(stat.meanScore).toBeCloseTo(0.5, 6);
    expect(stat.passRate).toBeUndefined();
    expect(stat.sampleCount).toBe(3);
  });

  it("excludes UNKNOWN/NOT_APPLICABLE/PENDING rows from the measurement but they still count toward sampleCount denominator context", () => {
    const rows: ProdSampleDimensionRow[] = [
      { status: "SCORED", verdict: { kind: "boolean", pass: true } },
      { status: "UNKNOWN" },
      { status: "NOT_APPLICABLE" },
      { status: "PENDING" },
    ];
    const stat = aggregateDimStat(rows);
    expect(stat.passRate).toBe(1);
    expect(stat.sampleCount).toBe(1);
  });

  it("returns sampleCount 0 and no measurement when zero rows are SCORED", () => {
    const rows: ProdSampleDimensionRow[] = [
      { status: "UNKNOWN" },
      { status: "PENDING" },
    ];
    const stat = aggregateDimStat(rows);
    expect(stat.sampleCount).toBe(0);
    expect(stat.passRate).toBeUndefined();
    expect(stat.meanScore).toBeUndefined();
  });

  it("returns sampleCount 0 for an empty row list", () => {
    const stat = aggregateDimStat([]);
    expect(stat.sampleCount).toBe(0);
  });

  it("is deterministic regardless of row order (same set -> same stat)", () => {
    const rowsA: ProdSampleDimensionRow[] = [
      { status: "SCORED", verdict: { kind: "score", score: 1 } },
      { status: "SCORED", verdict: { kind: "score", score: 0 } },
    ];
    const rowsB = [...rowsA].reverse();
    expect(JSON.stringify(aggregateDimStat(rowsA))).toBe(
      JSON.stringify(aggregateDimStat(rowsB)),
    );
  });
});
