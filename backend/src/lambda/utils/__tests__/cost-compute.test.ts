/**
 * Unit + property tests for the pure cost-compute helper.
 *
 * Covers: token-cost math, half-up 8dp rounding, drift-free integer
 * costMicros, currency propagation, and the unpriced fallback policy
 * (missing model / missing pricing → priced:false, never a fabricated price).
 */

import fc from "fast-check";
import { computeTokenCost, type PricingInfo } from "../cost-compute";

describe("computeTokenCost — priced path", () => {
  test("1000 in @ $3/1k + 500 out @ $15/1k => tokenCost 10.5, costMicros 10500000", () => {
    const pricing: PricingInfo = {
      inputPer1kTokens: 3,
      outputPer1kTokens: 15,
      currency: "USD",
    };
    const result = computeTokenCost(1000, 500, pricing);
    expect(result.priced).toBe(true);
    expect(result.tokenCost).toBeCloseTo(10.5, 8);
    expect(result.costMicros).toBe(10500000);
    expect(result.currency).toBe("USD");
    expect(result.unpricedReason).toBeUndefined();
  });

  test("zero tokens => zero cost, still priced", () => {
    const pricing: PricingInfo = {
      inputPer1kTokens: 3,
      outputPer1kTokens: 15,
      currency: "USD",
    };
    const result = computeTokenCost(0, 0, pricing);
    expect(result.priced).toBe(true);
    expect(result.tokenCost).toBe(0);
    expect(result.costMicros).toBe(0);
  });

  test("rounds tokenCost half-up to 8 decimal places", () => {
    const pricing: PricingInfo = {
      inputPer1kTokens: 0.333333335,
      outputPer1kTokens: 0,
      currency: "USD",
    };
    // 1000/1000 * 0.333333335 = 0.333333335 -> half-up 8dp = 0.33333334 (9th digit is 5, rounds up)
    const result = computeTokenCost(1000, 0, pricing);
    expect(result.tokenCost).toBe(0.33333334);
  });

  test("costMicros is an integer derived from rounded tokenCost (drift-free)", () => {
    const pricing: PricingInfo = {
      inputPer1kTokens: 1,
      outputPer1kTokens: 1,
      currency: "USD",
    };
    const result = computeTokenCost(333, 667, pricing);
    expect(Number.isInteger(result.costMicros)).toBe(true);
  });

  test("propagates the catalog currency verbatim (non-USD)", () => {
    const pricing: PricingInfo = {
      inputPer1kTokens: 2,
      outputPer1kTokens: 4,
      currency: "EUR",
    };
    const result = computeTokenCost(1000, 1000, pricing);
    expect(result.currency).toBe("EUR");
  });
});

describe("computeTokenCost — unpriced fallback policy", () => {
  test("missing pricing entirely => priced:false, null cost fields, reason pricing_absent", () => {
    const result = computeTokenCost(100, 50, undefined);
    expect(result.priced).toBe(false);
    expect(result.tokenCost).toBeNull();
    expect(result.costMicros).toBeNull();
    expect(result.currency).toBeNull();
    expect(result.unpricedReason).toBe("pricing_absent");
  });

  test("pricing object present but missing inputPer1kTokens => unpriced (never guesses)", () => {
    const pricing = {
      outputPer1kTokens: 15,
      currency: "USD",
    } as unknown as PricingInfo;
    const result = computeTokenCost(100, 50, pricing);
    expect(result.priced).toBe(false);
    expect(result.tokenCost).toBeNull();
    expect(result.costMicros).toBeNull();
    expect(result.unpricedReason).toBe("pricing_absent");
  });

  test("pricing object present but missing outputPer1kTokens => unpriced", () => {
    const pricing = {
      inputPer1kTokens: 3,
      currency: "USD",
    } as unknown as PricingInfo;
    const result = computeTokenCost(100, 50, pricing);
    expect(result.priced).toBe(false);
    expect(result.unpricedReason).toBe("pricing_absent");
  });

  test("missing currency => unpriced (never fabricates a currency either)", () => {
    const pricing = {
      inputPer1kTokens: 3,
      outputPer1kTokens: 15,
    } as unknown as PricingInfo;
    const result = computeTokenCost(100, 50, pricing);
    expect(result.priced).toBe(false);
    expect(result.unpricedReason).toBe("pricing_absent");
  });

  test("model_not_in_catalog reason is distinct from pricing_absent", () => {
    const result = computeTokenCost(100, 50, undefined, "model_not_in_catalog");
    expect(result.priced).toBe(false);
    expect(result.unpricedReason).toBe("model_not_in_catalog");
  });
});

describe("computeTokenCost — property-based invariants", () => {
  test("costMicros is always Math.round(tokenCost * 1e6) when priced", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        (inputTokens, outputTokens, inRate, outRate) => {
          const pricing: PricingInfo = {
            inputPer1kTokens: inRate,
            outputPer1kTokens: outRate,
            currency: "USD",
          };
          const result = computeTokenCost(inputTokens, outputTokens, pricing);
          expect(result.priced).toBe(true);
          expect(result.costMicros).toBe(
            Math.round((result.tokenCost as number) * 1e6),
          );
        },
      ),
    );
  });

  test("tokenCost is always non-negative for non-negative inputs", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        (inputTokens, outputTokens, inRate, outRate) => {
          const pricing: PricingInfo = {
            inputPer1kTokens: inRate,
            outputPer1kTokens: outRate,
            currency: "USD",
          };
          const result = computeTokenCost(inputTokens, outputTokens, pricing);
          expect((result.tokenCost as number) >= 0).toBe(true);
        },
      ),
    );
  });

  test("missing pricing always yields the unpriced shape regardless of token counts", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (inputTokens, outputTokens) => {
          const result = computeTokenCost(inputTokens, outputTokens, undefined);
          expect(result).toEqual({
            priced: false,
            tokenCost: null,
            costMicros: null,
            currency: null,
            unpricedReason: "pricing_absent",
          });
        },
      ),
    );
  });
});
