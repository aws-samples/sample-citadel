/**
 * Tests for xray-filter.ts — pure `buildCorrelationFilter(id)` expression
 * builder + id allowlist/escape (design §3 "filterExpression builder").
 *
 * Invariant 6 (binding): filter expression is exactly
 * `annotation.correlation_id = "<allowlisted-id>"`. Ids that don't match
 * `^[A-Za-z0-9\-:_.]+$` (e.g. containing a `"` or control chars) must be
 * rejected before a filter expression is ever built — this is the
 * injection-rejection half of invariant coverage.
 */
import { buildCorrelationFilter, isAllowlistedId } from "../xray-filter";

describe("isAllowlistedId", () => {
  test("accepts a v4 UUID", () => {
    expect(isAllowlistedId("6cf2ffa6-a2d6-48da-a195-33e3effd1c51")).toBe(true);
  });

  test("accepts an X-Ray trace-id shape (1-<8hex>-<24hex>)", () => {
    expect(isAllowlistedId("1-5f84c7c1-000000000000000000000001")).toBe(true);
  });

  test("accepts alnum with dots and underscores", () => {
    expect(isAllowlistedId("exec_123.abc")).toBe(true);
  });

  test("rejects an id containing a double-quote (injection attempt)", () => {
    expect(isAllowlistedId('exec-1" OR annotation.foo = "bar')).toBe(false);
  });

  test("rejects an id containing a control character", () => {
    expect(isAllowlistedId('exec-1\nannotation.x="y"')).toBe(false);
  });

  test("rejects an id containing whitespace", () => {
    expect(isAllowlistedId("exec 1")).toBe(false);
  });

  test("rejects the empty string", () => {
    expect(isAllowlistedId("")).toBe(false);
  });
});

describe("buildCorrelationFilter", () => {
  test('builds exactly annotation.correlation_id = "<id>" for a valid id', () => {
    const id = "6cf2ffa6-a2d6-48da-a195-33e3effd1c51";
    expect(buildCorrelationFilter(id)).toEqual({
      ok: true,
      expression: `annotation.correlation_id = "${id}"`,
    });
  });

  test("rejects a double-quote-bearing id instead of building an expression", () => {
    const malicious = 'x" OR annotation.correlation_id = "y';
    const result = buildCorrelationFilter(malicious);
    expect(result.ok).toBe(false);
  });

  test("rejects a non-allowlisted id and the rejection carries no expression field", () => {
    const result = buildCorrelationFilter("bad id!");
    expect(result).toEqual({ ok: false });
  });
});
