/**
 * promotion-ladder.test.ts — explicit-example unit coverage for the pure
 * ladder helpers, complementing the property suite.
 */
import {
  predecessorEnvironment,
  comparePolicyStrictness,
} from "../promotion-ladder";
import {
  DEFAULT_PROMOTION_POLICY,
  type PromotionPolicy,
} from "../release-gate";

function policy(overrides: Partial<PromotionPolicy> = {}): PromotionPolicy {
  return { ...DEFAULT_PROMOTION_POLICY, ...overrides };
}

describe("predecessorEnvironment", () => {
  it("maps DEV to null (ladder entry point)", () => {
    expect(predecessorEnvironment("DEV")).toBeNull();
  });

  it("maps STAGING to DEV", () => {
    expect(predecessorEnvironment("STAGING")).toBe("DEV");
  });

  it("maps PROD to STAGING", () => {
    expect(predecessorEnvironment("PROD")).toBe("STAGING");
  });
});

describe("comparePolicyStrictness — per-field directions", () => {
  it("accepts a strictly-stricter higher policy (floors up, ceilings down, packs superset)", () => {
    const lower = policy({
      taskSuccessMin: 0.8,
      latencyP95TargetMs: 6000,
      requiredGateClasses: ["safety"],
    });
    const higher = policy({
      taskSuccessMin: 0.95,
      latencyP95TargetMs: 3000,
      requiredGateClasses: ["safety", "latency"],
    });
    expect(comparePolicyStrictness(higher, lower).monotonic).toBe(true);
  });

  it("rejects a lower floor at the higher env (taskSuccessMin decreased)", () => {
    const result = comparePolicyStrictness(
      policy({ taskSuccessMin: 0.8 }),
      policy({ taskSuccessMin: 0.9 }),
    );
    expect(result.monotonic).toBe(false);
    expect(result.violations.map((v) => v.field)).toContain("taskSuccessMin");
  });

  it("rejects a looser ceiling at the higher env (latencyP95TargetMs increased)", () => {
    const result = comparePolicyStrictness(
      policy({ latencyP95TargetMs: 8000 }),
      policy({ latencyP95TargetMs: 5000 }),
    );
    expect(result.monotonic).toBe(false);
    expect(result.violations.map((v) => v.field)).toContain(
      "latencyP95TargetMs",
    );
  });

  it("rejects a missing required pack at the higher env (not a superset)", () => {
    const result = comparePolicyStrictness(
      policy({ requiredGateClasses: ["safety"] }),
      policy({ requiredGateClasses: ["safety", "cost"] }),
    );
    expect(result.monotonic).toBe(false);
    expect(result.violations.map((v) => v.field)).toContain(
      "requiredGateClasses",
    );
  });

  it("rejects higher enabling no-baseline bootstrap while lower disables it", () => {
    const result = comparePolicyStrictness(
      policy({ allowNoBaselineOnAbsoluteFloors: true }),
      policy({ allowNoBaselineOnAbsoluteFloors: false }),
    );
    expect(result.monotonic).toBe(false);
    expect(result.violations.map((v) => v.field)).toContain(
      "allowNoBaselineOnAbsoluteFloors",
    );
  });

  it("reports every violating field at once", () => {
    const result = comparePolicyStrictness(
      policy({ taskSuccessMin: 0.5, latencyP95TargetMs: 9000 }),
      policy({ taskSuccessMin: 0.9, latencyP95TargetMs: 5000 }),
    );
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});
