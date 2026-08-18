/**
 * promotion-ladder.property.test.ts — property-based coverage of the PURE
 * ladder + monotonicity helpers (design §10 "Property-based" item).
 *
 *  (a) predecessorEnvironment totality/acyclicity.
 *  (b) comparePolicyStrictness reflexivity/antisymmetry/transitivity per
 *      field direction.
 *  (c) comparePolicyStrictness/monotonicity is monotonic IFF every field
 *      satisfies its direction, and never throws.
 */
import * as fc from "fast-check";
import {
  ENVIRONMENT_ORDER,
  predecessorEnvironment,
  comparePolicyStrictness,
} from "../promotion-ladder";
import {
  DEFAULT_PROMOTION_POLICY,
  type PromotionPolicy,
} from "../release-gate";
import type { EnvironmentLiteral } from "../../../types";

const environmentArb: fc.Arbitrary<EnvironmentLiteral> = fc.constantFrom(
  ...ENVIRONMENT_ORDER,
);

/** A PromotionPolicy with all-independent, in-range field values so the
 * comparison exercises each direction rather than always tying. */
const policyArb: fc.Arbitrary<PromotionPolicy> = fc.record({
  taskSuccessMin: fc.double({ min: 0, max: 1, noNaN: true }),
  policyComplianceMin: fc.double({ min: 0, max: 1, noNaN: true }),
  latencyP95TargetMs: fc.integer({ min: 0, max: 60000 }),
  avgCostBudgetUsd: fc.double({ min: 0, max: 100, noNaN: true }),
  minSampleCount: fc.integer({ min: 0, max: 1000 }),
  requiredGateClasses: fc.uniqueArray(
    fc.constantFrom("safety", "latency", "cost", "quality"),
    { maxLength: 4 },
  ),
  maxEvidenceAgeDays: fc.integer({ min: 0, max: 365 }),
  allowNoBaselineOnAbsoluteFloors: fc.boolean(),
});

describe("predecessorEnvironment — totality and acyclicity", () => {
  it("is total over every EnvironmentLiteral and returns null or a strictly-lower env", () => {
    fc.assert(
      fc.property(environmentArb, (env) => {
        const predecessor = predecessorEnvironment(env);
        if (predecessor === null) {
          // Only the ladder entry (DEV) has no predecessor.
          expect(env).toBe("DEV");
          return;
        }
        // A predecessor must be strictly lower in the ladder order.
        expect(ENVIRONMENT_ORDER.indexOf(predecessor)).toBeLessThan(
          ENVIRONMENT_ORDER.indexOf(env),
        );
      }),
    );
  });

  it("following predecessors always terminates at DEV (acyclic, no infinite chain)", () => {
    fc.assert(
      fc.property(environmentArb, (env) => {
        let current: EnvironmentLiteral | null = env;
        let steps = 0;
        while (current !== null) {
          current = predecessorEnvironment(current);
          steps += 1;
          expect(steps).toBeLessThanOrEqual(ENVIRONMENT_ORDER.length);
        }
      }),
    );
  });
});

describe("comparePolicyStrictness — algebraic properties", () => {
  it("is reflexive: a policy is always monotonic against itself", () => {
    fc.assert(
      fc.property(policyArb, (policy) => {
        expect(comparePolicyStrictness(policy, policy).monotonic).toBe(true);
      }),
    );
  });

  it("never throws for any pair of in-range policies", () => {
    fc.assert(
      fc.property(policyArb, policyArb, (higher, lower) => {
        expect(() => comparePolicyStrictness(higher, lower)).not.toThrow();
        const result = comparePolicyStrictness(higher, lower);
        expect(typeof result.monotonic).toBe("boolean");
        expect(result.monotonic).toBe(result.violations.length === 0);
      }),
    );
  });

  it("antisymmetry: if higher≥lower AND lower≥higher then all comparable fields are equal", () => {
    fc.assert(
      fc.property(policyArb, policyArb, (a, b) => {
        const ab = comparePolicyStrictness(a, b).monotonic;
        const ba = comparePolicyStrictness(b, a).monotonic;
        if (ab && ba) {
          // Both directions monotonic ⇒ every ordered field must be equal.
          expect(a.taskSuccessMin).toBe(b.taskSuccessMin);
          expect(a.policyComplianceMin).toBe(b.policyComplianceMin);
          expect(a.minSampleCount).toBe(b.minSampleCount);
          expect(a.latencyP95TargetMs).toBe(b.latencyP95TargetMs);
          expect(a.avgCostBudgetUsd).toBe(b.avgCostBudgetUsd);
          expect(a.maxEvidenceAgeDays).toBe(b.maxEvidenceAgeDays);
          expect(a.allowNoBaselineOnAbsoluteFloors).toBe(
            b.allowNoBaselineOnAbsoluteFloors,
          );
          expect([...a.requiredGateClasses].sort()).toEqual(
            [...b.requiredGateClasses].sort(),
          );
        }
      }),
    );
  });

  it("transitivity: higher≥mid and mid≥lower ⇒ higher≥lower", () => {
    fc.assert(
      fc.property(policyArb, policyArb, policyArb, (higher, mid, lower) => {
        const hm = comparePolicyStrictness(higher, mid).monotonic;
        const ml = comparePolicyStrictness(mid, lower).monotonic;
        if (hm && ml) {
          expect(comparePolicyStrictness(higher, lower).monotonic).toBe(true);
        }
      }),
    );
  });

  it("monotonic IFF every field satisfies its direction (derived oracle)", () => {
    fc.assert(
      fc.property(policyArb, policyArb, (higher, lower) => {
        const expected =
          higher.taskSuccessMin >= lower.taskSuccessMin &&
          higher.policyComplianceMin >= lower.policyComplianceMin &&
          higher.minSampleCount >= lower.minSampleCount &&
          higher.latencyP95TargetMs <= lower.latencyP95TargetMs &&
          higher.avgCostBudgetUsd <= lower.avgCostBudgetUsd &&
          higher.maxEvidenceAgeDays <= lower.maxEvidenceAgeDays &&
          lower.requiredGateClasses.every((p) =>
            higher.requiredGateClasses.includes(p),
          ) &&
          (!higher.allowNoBaselineOnAbsoluteFloors ||
            lower.allowNoBaselineOnAbsoluteFloors);
        expect(comparePolicyStrictness(higher, lower).monotonic).toBe(expected);
      }),
    );
  });

  it("DEFAULT_PROMOTION_POLICY is monotonic against itself (sanity anchor)", () => {
    expect(
      comparePolicyStrictness(
        DEFAULT_PROMOTION_POLICY,
        DEFAULT_PROMOTION_POLICY,
      ).monotonic,
    ).toBe(true);
  });
});
