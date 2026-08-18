/**
 * promotion-policy-store.test.ts — decision ada70113 (promotion policy
 * becomes per-org config). Mocked DDB client, structural mirror of
 * eval-sampling-config.test.ts's conventions.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

process.env.PROMOTION_POLICY_CONFIG_TABLE =
  "citadel-promotion-policy-config-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import { resolvePromotionPolicy } from "../promotion-policy-store";
import { DEFAULT_PROMOTION_POLICY } from "../release-gate";

beforeEach(() => {
  ddbMock.reset();
});

describe("resolvePromotionPolicy — absent row", () => {
  test("resolves to DEFAULT_PROMOTION_POLICY when no config row exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: true, policy: DEFAULT_PROMOTION_POLICY });
  });
});

describe("resolvePromotionPolicy — org-only override", () => {
  test("applies org-level policy fields over the default floor", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.99, latencyP95TargetMs: 2000 },
        perAgentPolicyOverrides: {},
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.99);
    expect(result.policy.latencyP95TargetMs).toBe(2000);
    // Untouched fields still come from the default floor.
    expect(result.policy.policyComplianceMin).toBe(
      DEFAULT_PROMOTION_POLICY.policyComplianceMin,
    );
    expect(result.policy.avgCostBudgetUsd).toBe(
      DEFAULT_PROMOTION_POLICY.avgCostBudgetUsd,
    );
  });
});

describe("resolvePromotionPolicy — agent-level override", () => {
  test("agent override wins over org policy for the SAME field", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perAgentPolicyOverrides: {
          "agent-1": { taskSuccessMin: 0.99 },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.99);
  });

  test("agent override for a DIFFERENT agentTargetId does not apply", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perAgentPolicyOverrides: {
          "agent-2": { taskSuccessMin: 0.99 },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.9);
  });

  test("merge is FIELD-LEVEL, not whole-object: org supplies fields the agent override omits", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: {
          taskSuccessMin: 0.9,
          latencyP95TargetMs: 3000,
          avgCostBudgetUsd: 0.5,
        },
        perAgentPolicyOverrides: {
          // Only overrides ONE field — the other org-level fields must
          // still apply, proving this is not a whole-object replace.
          "agent-1": { taskSuccessMin: 0.99 },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.99); // from agent
    expect(result.policy.latencyP95TargetMs).toBe(3000); // from org
    expect(result.policy.avgCostBudgetUsd).toBe(0.5); // from org
    expect(result.policy.policyComplianceMin).toBe(
      DEFAULT_PROMOTION_POLICY.policyComplianceMin,
    ); // from default floor
  });
});

describe("resolvePromotionPolicy — malformed row -> UNREADABLE", () => {
  test("missing orgId on the row resolves to UNREADABLE", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { policy: { taskSuccessMin: 0.9 } },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("non-object policy container resolves to UNREADABLE", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { orgId: "org-1", policy: "not-an-object" },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("non-object perAgentPolicyOverrides container resolves to UNREADABLE", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { orgId: "org-1", perAgentPolicyOverrides: ["not", "a", "map"] },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("a single malformed FIELD (NaN) is dropped, not fatal — falls through to default", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: Number.NaN, latencyP95TargetMs: 2000 },
        perAgentPolicyOverrides: {},
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // NaN dropped -> falls back to the default floor for this field only.
    expect(result.policy.taskSuccessMin).toBe(
      DEFAULT_PROMOTION_POLICY.taskSuccessMin,
    );
    // The sibling valid field still applies.
    expect(result.policy.latencyP95TargetMs).toBe(2000);
  });

  test("a negative value for a rate-like field is dropped, not fatal", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { policyComplianceMin: -0.5 },
        perAgentPolicyOverrides: {},
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.policyComplianceMin).toBe(
      DEFAULT_PROMOTION_POLICY.policyComplianceMin,
    );
  });

  test("a present field with the WRONG PRIMITIVE TYPE (string where number expected) resolves to UNREADABLE for the whole row, not a per-field drop", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: "0.99" },
        perAgentPolicyOverrides: {},
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("a wrong-primitive-type field inside a per-agent override resolves to UNREADABLE for the whole row", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perAgentPolicyOverrides: {
          "agent-1": { latencyP95TargetMs: "2000" },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("boolean field with wrong primitive type (number instead of boolean) resolves to UNREADABLE", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { allowNoBaselineOnAbsoluteFloors: 1 },
        perAgentPolicyOverrides: {},
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });
});

describe("resolvePromotionPolicy — thrown GetItem -> UNREADABLE", () => {
  test("a thrown SDK error resolves to UNREADABLE, never falls back to defaults", async () => {
    ddbMock.on(GetCommand).rejects(new Error("DynamoDB unavailable"));

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });
});

describe("resolvePromotionPolicy — merged numerics stay sane", () => {
  test("merged policy numerics are always finite and within their documented floors", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: {
          taskSuccessMin: 0.95,
          policyComplianceMin: 1.0,
          latencyP95TargetMs: 4000,
          avgCostBudgetUsd: 2.0,
          minSampleCount: 10,
          maxEvidenceAgeDays: 3,
        },
        perAgentPolicyOverrides: {
          "agent-1": { taskSuccessMin: 0.97 },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBeGreaterThanOrEqual(0);
    expect(result.policy.taskSuccessMin).toBeLessThanOrEqual(1);
    expect(result.policy.policyComplianceMin).toBeGreaterThanOrEqual(0);
    expect(result.policy.policyComplianceMin).toBeLessThanOrEqual(1);
    expect(result.policy.latencyP95TargetMs).toBeGreaterThanOrEqual(0);
    expect(result.policy.avgCostBudgetUsd).toBeGreaterThanOrEqual(0);
    expect(result.policy.minSampleCount).toBeGreaterThanOrEqual(0);
    expect(result.policy.maxEvidenceAgeDays).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.policy.taskSuccessMin)).toBe(true);
  });
});

describe("resolvePromotionPolicy — perEnvironmentPolicyOverrides (G2)", () => {
  test("per-environment override wins over per-agent AND org for the SAME field, when an environment is supplied", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perAgentPolicyOverrides: { "agent-1": { taskSuccessMin: 0.93 } },
        perEnvironmentPolicyOverrides: { PROD: { taskSuccessMin: 0.99 } },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1", "PROD");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.99);
  });

  test("a field only the per-env override supplies falls through per-agent/org to the env value", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: {},
        perAgentPolicyOverrides: {},
        perEnvironmentPolicyOverrides: {
          STAGING: { latencyP95TargetMs: 2500 },
        },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1", "STAGING");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.latencyP95TargetMs).toBe(2500);
  });

  test("the per-env override for a DIFFERENT environment is not applied", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perEnvironmentPolicyOverrides: { PROD: { taskSuccessMin: 0.99 } },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1", "DEV");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // DEV has no override -> org floor 0.9, NOT PROD's 0.99.
    expect(result.policy.taskSuccessMin).toBe(0.9);
  });

  test("omitting the environment reproduces the pre-G2 merge (per-env override ignored)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        policy: { taskSuccessMin: 0.9 },
        perEnvironmentPolicyOverrides: { PROD: { taskSuccessMin: 0.99 } },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.policy.taskSuccessMin).toBe(0.9);
  });

  test("a wrong-primitive-type field inside a per-env override fails the whole row closed (UNREADABLE)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        perEnvironmentPolicyOverrides: { PROD: { taskSuccessMin: "0.99" } },
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1", "PROD");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  test("a non-object per-env override container fails the whole row closed (UNREADABLE)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        perEnvironmentPolicyOverrides: "not-an-object",
      },
    });

    const result = await resolvePromotionPolicy("org-1", "agent-1", "PROD");

    expect(result).toEqual({ ok: false, reason: "UNREADABLE" });
  });
});
