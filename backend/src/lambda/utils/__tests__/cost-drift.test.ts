/**
 * Unit + property tests for the pure cost-drift helpers used by the
 * cost-ledger reconciler (Tier A aggregate drift).
 *
 * Covers: drift-percentage math (never Infinity/NaN, null on unmatched),
 * hour alignment idempotency, window enumeration boundaries/cap, and
 * per-model ledger aggregation.
 */

import fc from "fast-check";
import {
  computeDriftPct,
  alignToHour,
  enumerateWindows,
  aggregateLedgerWindow,
} from "../cost-drift";
import type { LedgerRowProjection } from "../cost-reconciler-types";

describe("computeDriftPct", () => {
  test("returns 0 when ledger equals metric, for any positive value", () => {
    fc.assert(
      fc.property(fc.float({ min: 1, max: 1_000_000, noNaN: true }), (x) => {
        expect(computeDriftPct(x, x)).toBe(0);
      }),
    );
  });

  test("returns null when metric is exactly 0 (divide-by-zero guard)", () => {
    expect(computeDriftPct(100, 0)).toBeNull();
  });

  test("returns null when metric is negative (never fabricates from a bad denom)", () => {
    expect(computeDriftPct(100, -5)).toBeNull();
  });

  test("positive drift when ledger overcounts vs metric", () => {
    const result = computeDriftPct(150, 100);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThan(0);
  });

  test("negative drift when ledger undercounts vs metric", () => {
    const result = computeDriftPct(50, 100);
    expect(result).not.toBeNull();
    expect(result as number).toBeLessThan(0);
  });

  test("exact math: ledger=150, metric=100 => driftPct=50", () => {
    expect(computeDriftPct(150, 100)).toBe(50);
  });

  test("rounds to 4 decimal places", () => {
    // (100.00005 - 100) / 100 * 100 = 0.00005 -> rounds to 4dp = 0.0001 (half-up) or 0
    const result = computeDriftPct(100.00005, 100);
    expect(result).not.toBeNull();
    expect(Math.round((result as number) * 10000) / 10000).toBe(result);
  });

  test("property: never returns Infinity or NaN for any finite non-negative ledger and any finite metric", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true }),
        (ledgerTok, metricTok) => {
          const result = computeDriftPct(ledgerTok, metricTok);
          if (result !== null) {
            expect(Number.isFinite(result)).toBe(true);
            expect(Number.isNaN(result)).toBe(false);
          }
        },
      ),
    );
  });

  test("property: metric<=0 always yields null", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: -1_000_000, max: 0, noNaN: true }),
        (ledgerTok, metricTok) => {
          expect(computeDriftPct(ledgerTok, metricTok)).toBeNull();
        },
      ),
    );
  });
});

describe("alignToHour", () => {
  test("is idempotent: f(f(x)) === f(x)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2_000_000_000 }), (x) => {
        const once = alignToHour(x);
        expect(alignToHour(once)).toBe(once);
      }),
    );
  });

  test("result is always <= input", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2_000_000_000 }), (x) => {
        expect(alignToHour(x)).toBeLessThanOrEqual(x);
      }),
    );
  });

  test("result is always a multiple of 3600", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2_000_000_000 }), (x) => {
        expect(alignToHour(x) % 3600).toBe(0);
      }),
    );
  });

  test("exact: 3661 aligns to 3600", () => {
    expect(alignToHour(3661)).toBe(3600);
  });
});

describe("enumerateWindows", () => {
  test("empty array when watermark >= targetEnd (boundary edge)", () => {
    expect(enumerateWindows(7200, 7200, 6)).toEqual([]);
    expect(enumerateWindows(7200, 3600, 6)).toEqual([]);
  });

  test("produces contiguous hour-aligned half-open windows ascending", () => {
    const windows = enumerateWindows(0, 3 * 3600, 10);
    expect(windows).toEqual([
      { startSec: 0, endSec: 3600 },
      { startSec: 3600, endSec: 7200 },
      { startSec: 7200, endSec: 10800 },
    ]);
  });

  test("respects the maxWindows cap on catch-up", () => {
    const windows = enumerateWindows(0, 10 * 3600, 6);
    expect(windows).toHaveLength(6);
    expect(windows[0]).toEqual({ startSec: 0, endSec: 3600 });
    expect(windows[5]).toEqual({ startSec: 5 * 3600, endSec: 6 * 3600 });
  });

  test("a value exactly on an hour boundary is not double-counted (half-open)", () => {
    const windows = enumerateWindows(3600, 7200, 6);
    expect(windows).toEqual([{ startSec: 3600, endSec: 7200 }]);
  });

  test("property: never exceeds maxWindows and each window is exactly 3600s", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100 }),
        fc.nat({ max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (wmHours, spanHours, maxWindows) => {
          const watermark = wmHours * 3600;
          const targetEnd = watermark + spanHours * 3600;
          const windows = enumerateWindows(watermark, targetEnd, maxWindows);
          expect(windows.length).toBeLessThanOrEqual(maxWindows);
          for (const w of windows) {
            expect(w.endSec - w.startSec).toBe(3600);
          }
        },
      ),
    );
  });
});

describe("aggregateLedgerWindow", () => {
  test("groups rows by modelKey, sums tokens, collects rowKeys", () => {
    const rows: LedgerRowProjection[] = [
      {
        PK: "ORG#a",
        SK: "s1",
        modelKey: "claude-sonnet",
        modelId: "anthropic.claude-sonnet-5",
        inputTokens: 100,
        outputTokens: 50,
      },
      {
        PK: "ORG#a",
        SK: "s2",
        modelKey: "claude-sonnet",
        modelId: "anthropic.claude-sonnet-5",
        inputTokens: 20,
        outputTokens: 10,
      },
      {
        PK: "ORG#b",
        SK: "s3",
        modelKey: "claude-haiku",
        modelId: "anthropic.claude-haiku-5",
        inputTokens: 5,
        outputTokens: 5,
      },
    ];

    const agg = aggregateLedgerWindow(rows);
    expect(agg.size).toBe(2);
    const sonnet = agg.get("claude-sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet?.inputTokens).toBe(120);
    expect(sonnet?.outputTokens).toBe(60);
    expect(sonnet?.rowKeys).toHaveLength(2);
    expect(sonnet?.modelId).toBe("anthropic.claude-sonnet-5");

    const haiku = agg.get("claude-haiku");
    expect(haiku?.inputTokens).toBe(5);
  });

  test("coerces missing/non-numeric tokens to 0 without throwing", () => {
    const rows: LedgerRowProjection[] = [
      {
        PK: "ORG#a",
        SK: "s1",
        modelKey: "claude-sonnet",
        modelId: "anthropic.claude-sonnet-5",
        inputTokens: undefined,
        outputTokens: "not-a-number",
      },
    ];
    const agg = aggregateLedgerWindow(rows);
    const sonnet = agg.get("claude-sonnet");
    expect(sonnet?.inputTokens).toBe(0);
    expect(sonnet?.outputTokens).toBe(0);
  });

  test("empty input yields empty map", () => {
    expect(aggregateLedgerWindow([]).size).toBe(0);
  });

  test("rows with missing modelKey are skipped (never fabricate a model bucket)", () => {
    const rows: LedgerRowProjection[] = [
      { PK: "ORG#a", SK: "s1", modelId: "x", inputTokens: 10, outputTokens: 5 },
    ];
    expect(aggregateLedgerWindow(rows).size).toBe(0);
  });
});
