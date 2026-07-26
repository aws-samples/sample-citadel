/**
 * Tests for cost-budget.ts — pure budget-domain helpers: periodKey
 * derivation (UTC), threshold-crossing detection, and the notified-map
 * escalation logic used by the evaluator's dedupe mechanism.
 */
import {
  periodKeyFor,
  periodStartIso,
  crossedThresholds,
  highestNotifiedThreshold,
  shouldNotify,
} from "../cost-budget";

describe("periodKeyFor", () => {
  test("monthly periodKey is YYYY-MM (UTC)", () => {
    expect(periodKeyFor("monthly", new Date("2026-07-25T15:10:35.960Z"))).toBe(
      "2026-07",
    );
  });

  test("daily periodKey is YYYY-MM-DD (UTC)", () => {
    expect(periodKeyFor("daily", new Date("2026-07-25T15:10:35.960Z"))).toBe(
      "2026-07-25",
    );
  });

  test("monthly periodKey uses UTC even near a local-time month boundary", () => {
    // 2026-01-31T23:30Z is still January in UTC regardless of local tz.
    expect(periodKeyFor("monthly", new Date("2026-01-31T23:30:00.000Z"))).toBe(
      "2026-01",
    );
  });
});

describe("periodStartIso", () => {
  test("monthly period start is the 1st of the month at 00:00:00.000Z", () => {
    expect(periodStartIso("monthly", "2026-07")).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  test("daily period start is midnight UTC of that day", () => {
    expect(periodStartIso("daily", "2026-07-25")).toBe(
      "2026-07-25T00:00:00.000Z",
    );
  });
});

describe("crossedThresholds", () => {
  test("returns thresholds whose fraction of limit is met or exceeded by spend", () => {
    const result = crossedThresholds(800_000, 1_000_000, [0.5, 0.8, 1.0]);
    expect(result).toEqual([0.5, 0.8]);
  });

  test("returns all thresholds when spend meets/exceeds the limit", () => {
    const result = crossedThresholds(1_200_000, 1_000_000, [0.5, 0.8, 1.0]);
    expect(result).toEqual([0.5, 0.8, 1.0]);
  });

  test("returns empty array when spend is below every threshold", () => {
    const result = crossedThresholds(100_000, 1_000_000, [0.5, 0.8, 1.0]);
    expect(result).toEqual([]);
  });

  test("handles an empty thresholds list", () => {
    expect(crossedThresholds(1_000_000, 1_000_000, [])).toEqual([]);
  });
});

describe("highestNotifiedThreshold", () => {
  test("returns undefined when the period key is absent from the notified map", () => {
    expect(highestNotifiedThreshold({}, "2026-07")).toBeUndefined();
  });

  test("returns the stored value for the given period key", () => {
    expect(highestNotifiedThreshold({ "2026-07": 0.8 }, "2026-07")).toBe(0.8);
  });
});

describe("shouldNotify (escalation semantics)", () => {
  test("true when nothing has been notified yet for the period", () => {
    expect(shouldNotify(undefined, 0.8)).toBe(true);
  });

  test("true when the crossed threshold escalates past the last notified one", () => {
    expect(shouldNotify(0.8, 1.0)).toBe(true);
  });

  test("false when the crossed threshold was already notified", () => {
    expect(shouldNotify(0.8, 0.8)).toBe(false);
  });

  test("false when the crossed threshold is lower than what was already notified", () => {
    expect(shouldNotify(1.0, 0.8)).toBe(false);
  });
});
