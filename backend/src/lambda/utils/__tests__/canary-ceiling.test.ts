/**
 * Canary ceiling (canaryMaxBasisPoints, decision D5) behaviour in the two
 * pure/merge layers: promotion-ladder.ts's prod≤staging monotonicity
 * (canaryMaxBasisPoints is a TIGHTENING ceiling) and promotion-policy-store.ts's
 * field-level merge + fail-closed type validation.
 */
import { comparePolicyStrictness } from "../promotion-ladder";
import {
  DEFAULT_PROMOTION_POLICY,
  type PromotionPolicy,
} from "../release-gate";
import { resolvePromotionPolicy } from "../promotion-policy-store";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);
process.env.PROMOTION_POLICY_CONFIG_TABLE =
  "citadel-promotion-policy-config-test";

function policy(overrides: Partial<PromotionPolicy> = {}): PromotionPolicy {
  return { ...DEFAULT_PROMOTION_POLICY, ...overrides };
}

beforeEach(() => ddbMock.reset());

describe("comparePolicyStrictness — canaryMaxBasisPoints is a tightening ceiling (D5)", () => {
  it("flags a prod canary ceiling WIDER than staging as non-monotonic", () => {
    const higher = policy({ canaryMaxBasisPoints: 5000 }); // prod
    const lower = policy({ canaryMaxBasisPoints: 2500 }); // staging
    const result = comparePolicyStrictness(higher, lower);
    expect(result.monotonic).toBe(false);
    expect(result.violations.map((v) => v.field)).toContain(
      "canaryMaxBasisPoints",
    );
  });

  it("accepts a prod canary ceiling TIGHTER than (or equal to) staging", () => {
    expect(
      comparePolicyStrictness(
        policy({ canaryMaxBasisPoints: 1000 }),
        policy({ canaryMaxBasisPoints: 2500 }),
      ).monotonic,
    ).toBe(true);
    expect(
      comparePolicyStrictness(
        policy({ canaryMaxBasisPoints: 2500 }),
        policy({ canaryMaxBasisPoints: 2500 }),
      ).monotonic,
    ).toBe(true);
  });
});

describe("resolvePromotionPolicy — canaryMaxBasisPoints field (D5)", () => {
  it("defaults to 2500 when no config row exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await resolvePromotionPolicy("org-1", "agent-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.policy.canaryMaxBasisPoints).toBe(2500);
  });

  it("merges an org-supplied canaryMaxBasisPoints override", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({
        Item: { orgId: "org-1", policy: { canaryMaxBasisPoints: 1000 } },
      });
    const res = await resolvePromotionPolicy("org-1", "agent-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.policy.canaryMaxBasisPoints).toBe(1000);
  });

  it("fails closed (UNREADABLE) on a wrong-typed canaryMaxBasisPoints", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({
        Item: { orgId: "org-1", policy: { canaryMaxBasisPoints: "lots" } },
      });
    const res = await resolvePromotionPolicy("org-1", "agent-1");
    expect(res.ok).toBe(false);
  });

  it("drops an out-of-range (but correctly typed) canaryMaxBasisPoints, falling back to default", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({
        Item: { orgId: "org-1", policy: { canaryMaxBasisPoints: 20000 } },
      });
    const res = await resolvePromotionPolicy("org-1", "agent-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.policy.canaryMaxBasisPoints).toBe(2500);
  });
});
