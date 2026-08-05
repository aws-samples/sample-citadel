/**
 * eval-evaluator-compose.ts tests (CIT-107) — composes the registry's
 * combined EvaluatorDimensionScore[] (built-ins + custom/external
 * dimensions) into a final vector for persistence/reporting.
 *
 * Deliberately does NOT modify DIMENSION_ORDER or canonicalScoreVector()
 * (eval-scoring.ts) — those stay the fixed, unchanged source of truth for
 * the 8 canonical dimensions. Composition rule: canonical dimensions
 * sort first in DIMENSION_ORDER (via canonicalScoreVector, reused
 * verbatim), custom dimensions are APPENDED after them in stable
 * alphabetical order by dimension name — mirroring the existing
 * "trajectory is appended, not inserted" precedent in eval-scoring.ts, so
 * a consumer that only knows about DIMENSION_ORDER still sees an
 * additive-safe, deterministic ordering.
 */
import { composeScoreVector } from "../eval-evaluator-compose";
import { DIMENSION_ORDER } from "../eval-scoring";
import type { EvaluatorDimensionScore } from "../eval-evaluator-registry";

function d(dimension: string): EvaluatorDimensionScore {
  return {
    dimension,
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "score", score: 0.5 },
    detail: "x",
  };
}

describe("composeScoreVector", () => {
  it("orders canonical dimensions per DIMENSION_ORDER, custom dimensions appended alphabetically after", () => {
    const input: EvaluatorDimensionScore[] = [
      d("org.acme.zeta"),
      d("cost"),
      d("org.acme.alpha"),
      d("task_success"),
    ];
    const result = composeScoreVector(input);
    expect(result.map((r) => r.dimension)).toEqual([
      "task_success",
      "cost",
      "org.acme.alpha",
      "org.acme.zeta",
    ]);
  });

  it("preserves all 8 canonical dimensions in DIMENSION_ORDER when present", () => {
    const input = DIMENSION_ORDER.map((name) => d(name));
    const result = composeScoreVector(input);
    expect(result.map((r) => r.dimension)).toEqual([...DIMENSION_ORDER]);
  });

  it("is additive-safe: an empty custom-dimension set behaves identically to canonicalScoreVector alone", () => {
    const input = [d("cost"), d("task_success")];
    const result = composeScoreVector(input);
    expect(result.map((r) => r.dimension)).toEqual(["task_success", "cost"]);
  });

  it("drops duplicate custom dimension entries deterministically, keeping the first occurrence", () => {
    const input: EvaluatorDimensionScore[] = [
      { ...d("org.acme.tone"), detail: "first" },
      { ...d("org.acme.tone"), detail: "second" },
    ];
    const result = composeScoreVector(input);
    expect(result).toHaveLength(1);
    expect(result[0].detail).toBe("first");
  });

  it("a custom dimension can never overwrite a canonical dimension's entry", () => {
    // Two entries both named 'cost' — one from the builtin evaluator, one
    // (hypothetically) smuggled in by a misbehaving custom evaluator. The
    // first-occurrence-wins rule applies uniformly; validateExternalDimensionScore
    // already refuses reserved names for genuinely external responses, so
    // this only matters for defense-in-depth against a misconfigured
    // in-process custom evaluator.
    const input: EvaluatorDimensionScore[] = [
      { ...d("cost"), detail: "builtin" },
      { ...d("cost"), detail: "smuggled" },
    ];
    const result = composeScoreVector(input);
    const costEntries = result.filter((r) => r.dimension === "cost");
    expect(costEntries).toHaveLength(1);
    expect(costEntries[0].detail).toBe("builtin");
  });
});
