/**
 * eval-sampling-config.ts unit + property tests (Phase 2 §2.2).
 *
 * shouldSample(runId, rate) must be:
 *  - deterministic: same (runId, rate) always returns the same boolean
 *    (idempotent under EventBridge redelivery — design §2.2).
 *  - a pure function of its inputs (no Date.now/Math.random/IO).
 *  - statistically uniform: across many distinct runIds, a rate of r
 *    yields an empirical sample fraction close to r (acceptance #1).
 *  - clamped: rate<=0 never samples, rate>=1 always samples.
 */
import fc from "fast-check";
import {
  shouldSample,
  resolveEffectiveRate,
  hashToUnitFloat,
} from "../eval-sampling-config";

describe("hashToUnitFloat", () => {
  it("returns a value in [0, 1) for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const v = hashToUnitFloat(s);
        return v >= 0 && v < 1;
      }),
    );
  });

  it("is deterministic for the same input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        return hashToUnitFloat(s) === hashToUnitFloat(s);
      }),
    );
  });
});

describe("shouldSample", () => {
  it("is deterministic across repeated calls with identical inputs (idempotent redelivery)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (runId, rate) => {
          const first = shouldSample(runId, rate);
          const second = shouldSample(runId, rate);
          return first === second;
        },
      ),
    );
  });

  it("never samples at rate 0", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (runId) => {
        return shouldSample(runId, 0) === false;
      }),
    );
  });

  it("always samples at rate 1", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (runId) => {
        return shouldSample(runId, 1) === true;
      }),
    );
  });

  it("clamps a negative rate to never-sample", () => {
    expect(shouldSample("run-abc", -0.5)).toBe(false);
  });

  it("clamps a >1 rate to always-sample", () => {
    expect(shouldSample("run-abc", 5)).toBe(true);
  });

  it("yields an empirical sample fraction close to the requested rate over many distinct runIds", () => {
    const rate = 0.05;
    const N = 20_000;
    let sampled = 0;
    for (let i = 0; i < N; i++) {
      if (shouldSample(`run-${i}-${"x".repeat(i % 7)}`, rate)) sampled++;
    }
    const empirical = sampled / N;
    // Generous tolerance band — this is a statistical property test, not
    // an exact-count assertion; +/-0.02 absolute around 0.05 is a wide,
    // stable band for N=20000 with a good hash.
    expect(empirical).toBeGreaterThan(0.03);
    expect(empirical).toBeLessThan(0.07);
  });

  it("is a pure function: never reaches for Date.now or Math.random", () => {
    const src = shouldSample.toString() + hashToUnitFloat.toString();
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/Math\.random/);
  });
});

describe("resolveEffectiveRate", () => {
  it("returns 0 when optIn is false regardless of configured rates", () => {
    expect(
      resolveEffectiveRate(
        {
          optIn: false,
          defaultSampleRate: 0.5,
          perAgentSampleRate: { a1: 0.9 },
        },
        "a1",
      ),
    ).toBe(0);
  });

  it("returns the per-agent rate when present and optIn is true", () => {
    expect(
      resolveEffectiveRate(
        {
          optIn: true,
          defaultSampleRate: 0.1,
          perAgentSampleRate: { a1: 0.9 },
        },
        "a1",
      ),
    ).toBe(0.9);
  });

  it("falls back to the default rate when no per-agent rate is set", () => {
    expect(
      resolveEffectiveRate(
        { optIn: true, defaultSampleRate: 0.1, perAgentSampleRate: {} },
        "a1",
      ),
    ).toBe(0.1);
  });

  it("clamps an out-of-range configured rate into [0,1]", () => {
    expect(
      resolveEffectiveRate(
        { optIn: true, defaultSampleRate: 5, perAgentSampleRate: {} },
        "a1",
      ),
    ).toBe(1);
    expect(
      resolveEffectiveRate(
        { optIn: true, defaultSampleRate: -5, perAgentSampleRate: {} },
        "a1",
      ),
    ).toBe(0);
  });

  it("treats a missing config (undefined) as opted-out", () => {
    expect(resolveEffectiveRate(undefined, "a1")).toBe(0);
  });
});
