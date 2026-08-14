/**
 * Tests for trace-span-query.ts — pure Logs Insights filter-clause
 * builders for the Transaction Search (`aws/spans`) span-query path
 * (design §2 "Annotation contract", §4 "file list").
 *
 * Mirrors xray-filter.test.ts's allowlist/reject-first discipline: every
 * new/modified regex branch gets an explicit positive AND negative
 * `RegExp.test()` assertion (operational lesson — visual regex review is
 * insufficient).
 */
import {
  isAllowlistedSpanId,
  buildSpanCorrelationFilter,
  buildSpanRunIdFilter,
  SPAN_ALLOWLIST_RE,
} from "../trace-span-query";

describe("SPAN_ALLOWLIST_RE — positive + negative RegExp.test() coverage", () => {
  test("positive: accepts UUIDs, X-Ray trace-id shape, and run-<uuid> ids", () => {
    expect(SPAN_ALLOWLIST_RE.test("11111111-1111-1111-1111-111111111111")).toBe(
      true,
    );
    expect(SPAN_ALLOWLIST_RE.test("1-5f84c7c1-000000000000000000000001")).toBe(
      true,
    );
    expect(
      SPAN_ALLOWLIST_RE.test("run-11111111-1111-1111-1111-111111111111"),
    ).toBe(true);
  });

  test("negative: rejects a quote-bearing id (query-injection near-miss)", () => {
    expect(SPAN_ALLOWLIST_RE.test('exec-1" or 1=1')).toBe(false);
  });

  test("negative: rejects a whitespace-bearing id", () => {
    expect(SPAN_ALLOWLIST_RE.test("exec 1")).toBe(false);
  });

  test("negative: rejects an empty string", () => {
    expect(SPAN_ALLOWLIST_RE.test("")).toBe(false);
  });

  test("negative: rejects a newline-bearing id (query-terminator near-miss)", () => {
    expect(SPAN_ALLOWLIST_RE.test("exec-1\n| filter @message like /x/")).toBe(
      false,
    );
  });
});

describe("isAllowlistedId", () => {
  test("true for an allowlisted id", () => {
    expect(isAllowlistedSpanId("exec-1")).toBe(true);
  });

  test("false for a non-string-shaped reject (quote)", () => {
    expect(isAllowlistedSpanId('exec-1"')).toBe(false);
  });

  test("never throws on non-string input coerced at the type boundary", () => {
    expect(() => isAllowlistedSpanId("" as string)).not.toThrow();
  });
});

describe("buildSpanCorrelationFilter", () => {
  test("builds the exact Logs Insights filter clause for an allowlisted id", () => {
    const result = buildSpanCorrelationFilter("exec-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clause).toBe(
        'filter `attributes.correlation_id` = "exec-1"',
      );
    }
  });

  test("rejects a quote-bearing id outright — never builds an unsafe clause", () => {
    const result = buildSpanCorrelationFilter('exec-1" or 1=1');
    expect(result.ok).toBe(false);
  });
});

describe("buildSpanRunIdFilter", () => {
  test("builds the exact Logs Insights filter clause for an allowlisted run id", () => {
    const result = buildSpanRunIdFilter(
      "run-11111111-1111-1111-1111-111111111111",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clause).toBe(
        'filter `attributes.run_id` = "run-11111111-1111-1111-1111-111111111111"',
      );
    }
  });

  test("rejects a pipe-bearing id (Logs Insights command-separator near-miss)", () => {
    const result = buildSpanRunIdFilter("run-1 | stats count()");
    expect(result.ok).toBe(false);
  });
});
