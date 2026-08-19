/**
 * Tests for resolveRollbackPolicy (decision D1) — the rollbackPolicy
 * sub-object on the SAME promotion-policy row, resolved with the same
 * field-level merge + fail-closed discipline. Fail-SAFE direction: an
 * UNREADABLE policy resolves ok:false so the evaluator does NOTHING.
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { resolveRollbackPolicy } from "../promotion-policy-store";
import { DEFAULT_ROLLBACK_POLICY } from "../rollback-policy";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.PROMOTION_POLICY_CONFIG_TABLE = "test-policy";
});
afterEach(() => {
  delete process.env.PROMOTION_POLICY_CONFIG_TABLE;
});

describe("resolveRollbackPolicy", () => {
  it("returns DEFAULT_ROLLBACK_POLICY (opt-in, disabled) when no row exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await resolveRollbackPolicy("org-1", "agent-1", "staging");
    expect(res).toEqual({ ok: true, policy: DEFAULT_ROLLBACK_POLICY });
  });

  it("merges rollbackPolicy DEFAULT ← org ← agent ← env (env wins)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        rollbackPolicy: { enabled: true, costPerInvocationMaxMicros: 1000 },
        perAgentRollbackOverrides: {
          "agent-1": { costPerInvocationMaxMicros: 2000 },
        },
        perEnvironmentRollbackOverrides: {
          staging: { costPerInvocationMaxMicros: 3000 },
        },
      },
    });
    const res = await resolveRollbackPolicy("org-1", "agent-1", "staging");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.enabled).toBe(true);
      expect(res.policy.costPerInvocationMaxMicros).toBe(3000); // env override wins
    }
  });

  it("fails closed UNREADABLE on a wrong-primitive-type rollback field", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { orgId: "org-1", rollbackPolicy: { enabled: "yes" } }, // boolean expected
    });
    const res = await resolveRollbackPolicy("org-1", "agent-1", "staging");
    expect(res).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  it("fails closed UNREADABLE when GetItem throws", async () => {
    ddbMock.on(GetCommand).rejects(new Error("boom"));
    const res = await resolveRollbackPolicy("org-1", "agent-1", "staging");
    expect(res).toEqual({ ok: false, reason: "UNREADABLE" });
  });

  it("drops an out-of-range typed field per-field (not whole-row UNREADABLE)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        // errorRateMax > 1 is out of range but correctly typed → dropped
        // per-field, falling back to DEFAULT (null); the row stays readable.
        rollbackPolicy: {
          enabled: true,
          errorRateMax: 5,
          costPerInvocationMaxMicros: 1000,
        },
      },
    });
    const res = await resolveRollbackPolicy("org-1", "agent-1", "staging");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.errorRateMax).toBeNull(); // dropped → DEFAULT
      expect(res.policy.costPerInvocationMaxMicros).toBe(1000); // kept
      expect(res.policy.enabled).toBe(true);
    }
  });

  it("accepts an explicit null threshold (not evaluated)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        rollbackPolicy: { enabled: true, latencyP95MaxMs: null },
      },
    });
    const res = await resolveRollbackPolicy("org-1", "agent-1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.policy.latencyP95MaxMs).toBeNull();
  });
});
