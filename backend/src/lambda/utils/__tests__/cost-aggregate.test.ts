/**
 * Tests for cost-aggregate.ts — pure in-Lambda rollup helpers for
 * /cost/summary (groupBy) and /cost/series (time bucketing). No AWS SDK
 * imports; callers pass already-Queried ledger rows in.
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
    appId: "app-1",
    agentId: "agent-1",
    projectId: "proj-1",
    modelKey: "anthropic.claude-3",
    capturedAt: "2026-07-01T10:15:00.000Z",
    totalTokens: 100,
    costMicros: 5_000_000,
    tokenCost: 5,
    currency: "USD",
    priced: true,
    ...overrides,
  };
}

describe("aggregateSummary", () => {
  test("groups by app, summing costMicros/tokens and counting rows", () => {
    const rows = [
      row({ appId: "app-a", costMicros: 1_000_000, totalTokens: 10 }),
      row({ appId: "app-a", costMicros: 2_000_000, totalTokens: 20 }),
      row({ appId: "app-b", costMicros: 3_000_000, totalTokens: 30 }),
    ];

    const result = aggregateSummary(rows, "app");

    expect(result.totalCostMicros).toBe(6_000_000);
    expect(result.pricedRows).toBe(3);
    expect(result.unpricedRows).toBe(0);
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b]));
    expect(byKey["app-a"].costMicros).toBe(3_000_000);
    expect(byKey["app-a"].rows).toBe(2);
    expect(byKey["app-b"].costMicros).toBe(3_000_000);
    expect(byKey["app-b"].rows).toBe(1);
  });

  test("groupBy=model uses modelKey (no ModelIndex GSI needed — in-Lambda only)", () => {
    const rows = [
      row({ modelKey: "model-x", costMicros: 1_000_000 }),
      row({ modelKey: "model-y", costMicros: 4_000_000 }),
    ];
    const result = aggregateSummary(rows, "model");
    const keys = result.buckets.map((b) => b.key).sort();
    expect(keys).toEqual(["model-x", "model-y"]);
  });

  test("counts unpriced rows separately and excludes them from costMicros sums", () => {
    const rows = [
      row({ appId: "app-a", costMicros: 1_000_000, priced: true }),
      row({
        appId: "app-a",
        costMicros: null,
        tokenCost: null,
        currency: null,
        priced: false,
      }),
    ];
    const result = aggregateSummary(rows, "app");
    expect(result.totalCostMicros).toBe(1_000_000);
    expect(result.pricedRows).toBe(1);
    expect(result.unpricedRows).toBe(1);
    const bucket = result.buckets[0];
    expect(bucket.costMicros).toBe(1_000_000);
    expect(bucket.unpricedRows).toBe(1);
    expect(bucket.rows).toBe(2);
  });

  test("rows missing the requested dimension are grouped under 'unassigned'", () => {
    const rows = [row({ appId: undefined })];
    const result = aggregateSummary(rows, "app");
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].key).toBe("unassigned");
  });

  test("empty input yields zeroed totals and no buckets", () => {
    const result = aggregateSummary([], "app");
    expect(result.totalCostMicros).toBe(0);
    expect(result.pricedRows).toBe(0);
    expect(result.unpricedRows).toBe(0);
    expect(result.buckets).toEqual([]);
  });
});

describe("aggregateSeries", () => {
  test("buckets by day (UTC) and sums costMicros per bucket", () => {
    const rows = [
      row({ capturedAt: "2026-07-01T01:00:00.000Z", costMicros: 1_000_000 }),
      row({ capturedAt: "2026-07-01T23:59:00.000Z", costMicros: 2_000_000 }),
      row({ capturedAt: "2026-07-02T00:00:01.000Z", costMicros: 3_000_000 }),
    ];
    const result = aggregateSeries(rows, "day");
    const byT = Object.fromEntries(result.points.map((p) => [p.t, p]));
    expect(byT["2026-07-01"].costMicros).toBe(3_000_000);
    expect(byT["2026-07-02"].costMicros).toBe(3_000_000);
  });

  test("buckets by hour (UTC), zero-padded", () => {
    const rows = [
      row({ capturedAt: "2026-07-01T05:12:00.000Z", costMicros: 1_000_000 }),
      row({ capturedAt: "2026-07-01T05:59:59.000Z", costMicros: 1_000_000 }),
      row({ capturedAt: "2026-07-01T06:00:00.000Z", costMicros: 1_000_000 }),
    ];
    const result = aggregateSeries(rows, "hour");
    const byT = Object.fromEntries(result.points.map((p) => [p.t, p]));
    expect(byT["2026-07-01T05"].costMicros).toBe(2_000_000);
    expect(byT["2026-07-01T06"].costMicros).toBe(1_000_000);
  });

  test("points are sorted ascending by bucket key", () => {
    const rows = [
      row({ capturedAt: "2026-07-03T00:00:00.000Z" }),
      row({ capturedAt: "2026-07-01T00:00:00.000Z" }),
      row({ capturedAt: "2026-07-02T00:00:00.000Z" }),
    ];
    const result = aggregateSeries(rows, "day");
    expect(result.points.map((p) => p.t)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  test("tracks unpricedCount across all points without summing null costMicros", () => {
    const rows = [
      row({ capturedAt: "2026-07-01T00:00:00.000Z", costMicros: 1_000_000 }),
      row({
        capturedAt: "2026-07-01T00:00:00.000Z",
        costMicros: null,
        priced: false,
      }),
    ];
    const result = aggregateSeries(rows, "day");
    expect(result.unpricedCount).toBe(1);
    expect(result.points[0].costMicros).toBe(1_000_000);
    expect(result.points[0].unpricedRows).toBe(1);
  });

  test("empty input yields no points and zero unpricedCount", () => {
    const result = aggregateSeries([], "day");
    expect(result.points).toEqual([]);
    expect(result.unpricedCount).toBe(0);
  });
});
