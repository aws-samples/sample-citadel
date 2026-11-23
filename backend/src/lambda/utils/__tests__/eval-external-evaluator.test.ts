/**
 * eval-external-evaluator.ts tests (CIT-107) — validation of untrusted
 * external-evaluator responses. Every malformed shape must be REJECTED
 * (never partially merged into the persisted vector): unknown/invalid
 * dimension names, out-of-range or non-finite scores, missing required
 * fields, and oversized payloads.
 */
import {
  validateExternalDimensionScore,
  validateExternalScoreVector,
  MAX_EXTERNAL_DETAIL_LENGTH,
  MAX_EXTERNAL_DIMENSION_NAME_LENGTH,
  MAX_EXTERNAL_SCORES_PER_RESPONSE,
} from "../eval-external-evaluator";
import { sanitizeUntrustedJson } from "../../../utils/sanitize-untrusted-json";

function validScore(overrides: Record<string, unknown> = {}) {
  return {
    dimension: "org.acme.tone",
    status: "SCORED",
    basis: "DETERMINISTIC",
    verdict: { kind: "score", score: 0.75 },
    detail: "tone check passed",
    ...overrides,
  };
}

describe("validateExternalDimensionScore", () => {
  it("accepts a well-formed SCORED score-verdict dimension", () => {
    const result = validateExternalDimensionScore(validScore());
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed SCORED boolean-verdict dimension", () => {
    const result = validateExternalDimensionScore(
      validScore({ verdict: { kind: "boolean", pass: false } }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts NOT_APPLICABLE/UNKNOWN/PENDING statuses without a verdict", () => {
    for (const status of ["NOT_APPLICABLE", "UNKNOWN", "PENDING"]) {
      const { verdict: _verdict, ...rest } = validScore({ status });
      const result = validateExternalDimensionScore(rest);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a non-object payload", () => {
    expect(validateExternalDimensionScore(null).ok).toBe(false);
    expect(validateExternalDimensionScore("not an object").ok).toBe(false);
    expect(validateExternalDimensionScore(42).ok).toBe(false);
    expect(validateExternalDimensionScore([1, 2]).ok).toBe(false);
  });

  it("rejects a missing dimension field", () => {
    const { dimension: _dimension, ...rest } = validScore();
    expect(validateExternalDimensionScore(rest).ok).toBe(false);
  });

  it("rejects an empty-string dimension name", () => {
    expect(
      validateExternalDimensionScore(validScore({ dimension: "" })).ok,
    ).toBe(false);
  });

  it("rejects a dimension name colliding with a reserved builtin name unless it is a builtin evaluator", () => {
    expect(
      validateExternalDimensionScore(validScore({ dimension: "task_success" }))
        .ok,
    ).toBe(false);
  });

  it("rejects an oversized dimension name", () => {
    const longName = "x".repeat(MAX_EXTERNAL_DIMENSION_NAME_LENGTH + 1);
    expect(
      validateExternalDimensionScore(validScore({ dimension: longName })).ok,
    ).toBe(false);
  });

  it("rejects a dimension name with invalid characters", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ dimension: "org acme; drop table" }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an invalid status value", () => {
    expect(
      validateExternalDimensionScore(validScore({ status: "MAYBE" })).ok,
    ).toBe(false);
  });

  it("rejects an invalid basis value", () => {
    expect(
      validateExternalDimensionScore(validScore({ basis: "VIBES" })).ok,
    ).toBe(false);
  });

  it("rejects SCORED status with a missing verdict", () => {
    const { verdict: _verdict, ...rest } = validScore();
    expect(validateExternalDimensionScore(rest).ok).toBe(false);
  });

  it("rejects a score verdict outside [0,1]", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: 1.5 } }),
      ).ok,
    ).toBe(false);
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: -0.1 } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a non-finite score (NaN, Infinity)", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: NaN } }),
      ).ok,
    ).toBe(false);
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: Infinity } }),
      ).ok,
    ).toBe(false);
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: -Infinity } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a non-numeric score", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "score", score: "0.5" } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a boolean verdict with a non-boolean pass field", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "boolean", pass: "yes" } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an unknown verdict kind", () => {
    expect(
      validateExternalDimensionScore(
        validScore({ verdict: { kind: "vibes", score: 1 } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a non-finite measurement", () => {
    expect(
      validateExternalDimensionScore(validScore({ measurement: NaN })).ok,
    ).toBe(false);
    expect(
      validateExternalDimensionScore(validScore({ measurement: Infinity })).ok,
    ).toBe(false);
  });

  it("accepts a null measurement", () => {
    expect(
      validateExternalDimensionScore(validScore({ measurement: null })).ok,
    ).toBe(true);
  });

  it("on the WIRE path, a non-finite measurement is coerced to null by sanitizeUntrustedJson first and accepted as 'not measured' — this directly-called in-process rejection branch only fires for callers that skip sanitization", () => {
    const rawEntry = validScore({ measurement: NaN });

    // Direct call (no sanitizer): rejected, per the test above this one.
    expect(validateExternalDimensionScore(rawEntry).ok).toBe(false);

    // Wire path: validateExternalScoreVector runs sanitizeUntrustedJson
    // first, same as it does internally. NaN has no valid JSON
    // representation, so the sanitizer coerces it to null before
    // field-level validation ever sees it.
    const sanitized = sanitizeUntrustedJson([rawEntry]);
    expect(sanitized.truncated).toBe(false);
    const sanitizedEntry = (sanitized.value as unknown[])[0] as {
      measurement: unknown;
    };
    expect(sanitizedEntry.measurement).toBeNull();

    const result = validateExternalScoreVector([rawEntry]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].measurement).toBeNull();
  });

  it("by contrast, a verdict score coerced to null by the same sanitizer IS rejected on the wire path — null is not a valid score", () => {
    const rawEntry = validScore({
      verdict: { kind: "score", score: Infinity },
    });

    const result = validateExternalScoreVector([rawEntry]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a missing detail field", () => {
    const { detail: _detail, ...rest } = validScore();
    expect(validateExternalDimensionScore(rest).ok).toBe(false);
  });

  it("rejects a non-string detail field", () => {
    expect(validateExternalDimensionScore(validScore({ detail: 123 })).ok).toBe(
      false,
    );
  });

  it("rejects an oversized detail field", () => {
    const longDetail = "x".repeat(MAX_EXTERNAL_DETAIL_LENGTH + 1);
    expect(
      validateExternalDimensionScore(validScore({ detail: longDetail })).ok,
    ).toBe(false);
  });

  it("rejects JUDGE basis missing required judge stamp fields when SCORED", () => {
    expect(
      validateExternalDimensionScore(validScore({ basis: "JUDGE" })).ok,
    ).toBe(false);
  });

  it("accepts JUDGE basis with all stamp fields present", () => {
    expect(
      validateExternalDimensionScore(
        validScore({
          basis: "JUDGE",
          judgeModelId: "model-1",
          judgeModelVersion: "v1",
          judgePromptHash: "hash1",
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects unexpected extra fields (strict shape)", () => {
    expect(
      validateExternalDimensionScore(validScore({ unexpectedField: "x" })).ok,
    ).toBe(false);
  });

  it("treats a benign unknown-looking key the same as any other unrecognized field", () => {
    expect(
      validateExternalDimensionScore(validScore({ notAKnownField: "x" })).ok,
    ).toBe(false);
  });

  it("rejects a __proto__ key via JSON-parsed input without polluting Object.prototype", () => {
    const hostile = JSON.parse(
      '{"dimension":"org.acme.tone","status":"SCORED","basis":"DETERMINISTIC","verdict":{"kind":"score","score":0.5},"detail":"d","__proto__":{"polluted":true}}',
    );
    const result = validateExternalDimensionScore(hostile);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("validateExternalScoreVector", () => {
  it("returns all valid scores when every entry validates", () => {
    const result = validateExternalScoreVector([
      validScore(),
      validScore({ dimension: "org.acme.other" }),
    ]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects the whole payload when input is not an array", () => {
    const result = validateExternalScoreVector({ not: "an array" });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it("partitions valid entries from invalid ones — one bad entry never poisons the good ones", () => {
    const result = validateExternalScoreVector([
      validScore(),
      validScore({ verdict: { kind: "score", score: 99 } }),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects the entire vector when the array exceeds the max entry count (oversized payload)", () => {
    const many = Array.from(
      { length: MAX_EXTERNAL_SCORES_PER_RESPONSE + 1 },
      (_, i) => validScore({ dimension: `org.acme.d${i}` }),
    );
    const result = validateExternalScoreVector(many);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it("rejects duplicate dimension names within the same response", () => {
    const result = validateExternalScoreVector([
      validScore({ dimension: "org.acme.dup" }),
      validScore({ dimension: "org.acme.dup" }),
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });
});
