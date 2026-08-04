/**
 * cost-aggregate.eval-context.test.ts (Phase 2 §2.6) — costContext:"eval"
 * rows (judge invocation usage) must be excluded from customer-facing
 * summary/series aggregation, same discipline as the existing
 * evalContext===true exclusion (CIT-102 §5) but for the distinct
 * costContext attribute.
 */
import {
  aggregateSummary,
  aggregateSeries,
  type CostLedgerRowForAggregation,
} from "../cost-aggregate";

function row(
  overrides: Partial<CostLedgerRowForAggregation> = {},
): CostLedgerRowForAggregation {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    capturedAt: "2026-08-01T00:00:00.000Z",
    totalTokens: 100,
    costMicros: 5000,
    tokenCost: 0.005,
    currency: "USD",
    priced: true,
    ...overrides,
  };
}

describe("aggregateSummary — costContext:eval exclusion", () => {
  test("excludes a costContext:'eval' row from totals and buckets", () => {
    const result = aggregateSummary(
      [row({ costContext: "eval" }), row()],
      "agent",
    );
    expect(result.pricedRows).toBe(1);
    expect(result.totalCostMicros).toBe(5000);
  });

  test("a costContext:'eval' row never appears as unpriced either", () => {
    const result = aggregateSummary(
      [row({ costContext: "eval", priced: false, costMicros: null })],
      "agent",
    );
    expect(result.unpricedRows).toBe(0);
    expect(result.pricedRows).toBe(0);
  });
});

describe("aggregateSeries — costContext:eval exclusion", () => {
  test("excludes a costContext:'eval' row from the time series", () => {
    const result = aggregateSeries(
      [row({ costContext: "eval" }), row()],
      "day",
    );
    expect(result.points).toHaveLength(1);
    expect(result.points[0].costMicros).toBe(5000);
  });
});
