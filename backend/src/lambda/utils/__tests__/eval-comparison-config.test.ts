/**
 * eval-comparison-config.test.ts (CIT-105) — layered threshold-resolver
 * unit tests. Red-Green-Refactor: written before eval-comparison-config.ts
 * exists. Mirrors the model-selection resolver's global -> slot ->
 * fallback discipline (bulletproof: never throws, always degrades to
 * DEFAULT_COMPARISON_THRESHOLDS on missing/malformed input).
 */
import {
  resolveComparisonThresholds,
  DEFAULT_COMPARISON_THRESHOLDS,
  type ComparisonThresholdConfigRow,
} from "../eval-comparison-config";

describe("resolveComparisonThresholds — layered precedence", () => {
  const orgDefault: ComparisonThresholdConfigRow = {
    orgId: "org1",
    suiteId: "__default__",
    thresholds: { passRateDropThreshold: 0.2 },
  };
  const perSuite: ComparisonThresholdConfigRow = {
    orgId: "org1",
    suiteId: "suite1",
    thresholds: { passRateDropThreshold: 0.1 },
  };

  it("request override wins over per-suite, per-org, and defaults", () => {
    const resolved = resolveComparisonThresholds({
      overrides: { passRateDropThreshold: 0.5 },
      perSuiteConfig: perSuite,
      perOrgDefaultConfig: orgDefault,
    });
    expect(resolved.passRateDropThreshold).toBe(0.5);
  });

  it("per-suite config wins over per-org default when no override supplied", () => {
    const resolved = resolveComparisonThresholds({
      perSuiteConfig: perSuite,
      perOrgDefaultConfig: orgDefault,
    });
    expect(resolved.passRateDropThreshold).toBe(0.1);
  });

  it("per-org default wins over hardcoded defaults when no override/per-suite supplied", () => {
    const resolved = resolveComparisonThresholds({
      perOrgDefaultConfig: orgDefault,
    });
    expect(resolved.passRateDropThreshold).toBe(0.2);
  });

  it("falls back to DEFAULT_COMPARISON_THRESHOLDS when nothing is supplied", () => {
    const resolved = resolveComparisonThresholds({});
    expect(resolved).toEqual(DEFAULT_COMPARISON_THRESHOLDS);
  });

  it("fills unset fields from the next layer down (partial per-suite config)", () => {
    const partialPerSuite: ComparisonThresholdConfigRow = {
      orgId: "org1",
      suiteId: "suite1",
      thresholds: { meanScoreDropThreshold: 0.33 },
    };
    const resolved = resolveComparisonThresholds({
      perSuiteConfig: partialPerSuite,
      perOrgDefaultConfig: orgDefault,
    });
    expect(resolved.meanScoreDropThreshold).toBe(0.33);
    // passRateDropThreshold falls through to the org default layer.
    expect(resolved.passRateDropThreshold).toBe(0.2);
  });
});

describe("resolveComparisonThresholds — bulletproof fallback", () => {
  it("never throws and degrades to defaults on malformed per-suite config", () => {
    const malformed = {
      orgId: "org1",
      suiteId: "suite1",
      thresholds: { passRateDropThreshold: "not-a-number" },
    } as unknown as ComparisonThresholdConfigRow;

    expect(() =>
      resolveComparisonThresholds({ perSuiteConfig: malformed }),
    ).not.toThrow();
    const resolved = resolveComparisonThresholds({ perSuiteConfig: malformed });
    expect(resolved.passRateDropThreshold).toBe(
      DEFAULT_COMPARISON_THRESHOLDS.passRateDropThreshold,
    );
  });

  it("never throws and degrades to defaults on a null/undefined config layer", () => {
    expect(() =>
      resolveComparisonThresholds({
        perSuiteConfig: null as unknown as ComparisonThresholdConfigRow,
        perOrgDefaultConfig: undefined,
      }),
    ).not.toThrow();
    const resolved = resolveComparisonThresholds({
      perSuiteConfig: null as unknown as ComparisonThresholdConfigRow,
    });
    expect(resolved).toEqual(DEFAULT_COMPARISON_THRESHOLDS);
  });

  it("never throws on a config layer with a missing thresholds object entirely", () => {
    const noThresholds = {
      orgId: "org1",
      suiteId: "suite1",
    } as unknown as ComparisonThresholdConfigRow;
    expect(() =>
      resolveComparisonThresholds({ perSuiteConfig: noThresholds }),
    ).not.toThrow();
  });
});

describe("resolveComparisonThresholds — reproducibility", () => {
  it("the resolved thresholds are a complete ResolvedComparisonThresholds object suitable for echoing into a verdict", () => {
    const resolved = resolveComparisonThresholds({
      overrides: { latencyP95IncreaseMsThreshold: 250 },
    });
    expect(resolved).toEqual({
      ...DEFAULT_COMPARISON_THRESHOLDS,
      latencyP95IncreaseMsThreshold: 250,
    });
  });
});
