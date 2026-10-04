/**
 * Tests for tag-policy-check.ts — CIT-042 PR2 enforcement adapter.
 *
 * Mocks: governance-flag (SSM), @aws-sdk/lib-dynamodb (GetCommand),
 * ../utils/emf (emitMetrics).
 */

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
}));

jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn().mockImplementation(() => ({
        send: mockSend,
      })),
    },
    GetCommand: jest.fn().mockImplementation((input: unknown) => input),
  };
});

jest.mock("../../utils/governance-flag", () => ({
  getGovernanceEnforce: jest.fn(),
}));

jest.mock("../../utils/emf", () => ({
  emitMetrics: jest.fn(),
}));

import {
  enforceTagPolicy,
  TagPolicyViolationError,
  TagPolicyLookupError,
  __resetPolicyCacheForTest,
} from "../tag-policy-check";
import { getGovernanceEnforce } from "../../utils/governance-flag";
import { emitMetrics } from "../../utils/emf";
import type { TagPolicy } from "../../utils/tag-policy";

const mockGetGovernanceEnforce = getGovernanceEnforce as jest.MockedFunction<
  typeof getGovernanceEnforce
>;
const mockEmitMetrics = emitMetrics as jest.MockedFunction<typeof emitMetrics>;

// ─── Helpers ────────────────────────────────────────────────────────────

const TEST_ORG = "org-123";

function makePolicy(
  rules: TagPolicy["requiredKeys"] = [
    { key: "env", allowedValues: ["prod", "staging", "dev"] },
    { key: "team" },
  ],
): TagPolicy {
  return {
    requiredKeys: rules,
    version: 1,
    updatedBy: "admin",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function stubPolicyResponse(policy: TagPolicy | null): void {
  if (policy === null) {
    mockSend.mockResolvedValueOnce({ Item: undefined });
  } else {
    mockSend.mockResolvedValueOnce({
      Item: { orgId: `TAG_POLICY#${TEST_ORG}`, policy },
    });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("enforceTagPolicy", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetPolicyCacheForTest();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.ORGANIZATIONS_TABLE = "OrgTable";
    process.env.ENVIRONMENT = "dev";
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.ORGANIZATIONS_TABLE;
    delete process.env.ENVIRONMENT;
  });

  // ── Permissive mode ────────────────────────────────────────────────

  describe("permissive mode", () => {
    beforeEach(() => {
      mockGetGovernanceEnforce.mockResolvedValue("permissive");
    });

    it("returns ok without loading policy", async () => {
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: {},
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ── Shadow mode ────────────────────────────────────────────────────

  describe("shadow mode", () => {
    beforeEach(() => {
      mockGetGovernanceEnforce.mockResolvedValue("shadow");
    });

    it("returns ok when no policy exists for the org", async () => {
      stubPolicyResponse(null);
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod", team: "platform" },
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("returns ok when tags satisfy the policy", async () => {
      stubPolicyResponse(makePolicy());
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod", team: "platform" },
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("returns violations with would_block warning for missing keys", async () => {
      stubPolicyResponse(makePolicy());
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod" },
        action: "createAgent",
        subjectId: "agent-abc",
      });
      expect(result.ok).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toEqual({
        type: "MISSING_KEY",
        key: "team",
      });

      // Verify structured warn
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(logged.message).toBe("tag-policy-check: would_block");
      expect(logged.mode).toBe("shadow");
      expect(logged.orgId).toBe(TEST_ORG);
      expect(logged.violations).toHaveLength(1);
    });

    it("emits TagPolicyWouldBlock metric on violation", async () => {
      stubPolicyResponse(makePolicy());
      await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: {},
        action: "createTool",
      });
      expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
      expect(mockEmitMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "Citadel/Governance",
          metrics: [{ name: "TagPolicyWouldBlock", value: 1, unit: "Count" }],
          dimensions: expect.objectContaining({
            Action: "createTool",
            OrgId: TEST_ORG,
            Mode: "shadow",
          }),
        }),
      );
    });

    it("warns and proceeds when policy lookup fails", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB timeout"));
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: {},
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(logged.message).toBe("tag-policy-check: lookup_failure");
    });

    it("reports INVALID_VALUE for disallowed tag value", async () => {
      stubPolicyResponse(makePolicy());
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "oops", team: "platform" },
        action: "updateAgent",
      });
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        {
          type: "INVALID_VALUE",
          key: "env",
          suppliedValue: "oops",
          allowedValues: ["prod", "staging", "dev"],
        },
      ]);
    });
  });

  // ── Strict mode ────────────────────────────────────────────────────

  describe("strict mode", () => {
    beforeEach(() => {
      mockGetGovernanceEnforce.mockResolvedValue("strict");
    });

    it("returns ok when tags satisfy the policy", async () => {
      stubPolicyResponse(makePolicy());
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod", team: "platform" },
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    it("throws TagPolicyViolationError on violation", async () => {
      stubPolicyResponse(makePolicy());
      try {
        await enforceTagPolicy({
          orgId: TEST_ORG,
          tags: { env: "prod" },
          action: "importAgent",
        });
        fail("expected TagPolicyViolationError");
      } catch (err) {
        expect(err).toBeInstanceOf(TagPolicyViolationError);
        const tpve = err as TagPolicyViolationError;
        expect(tpve.code).toBe("TAG_POLICY_VIOLATION");
        expect(tpve.action).toBe("importAgent");
        expect(tpve.orgId).toBe(TEST_ORG);
        expect(tpve.violations).toHaveLength(1);
        expect(tpve.violations[0].type).toBe("MISSING_KEY");
        expect(tpve.message).toContain("missing required keys: team");
      }
    });

    it("throws TagPolicyViolationError with both missing and invalid keys", async () => {
      stubPolicyResponse(makePolicy());
      try {
        await enforceTagPolicy({
          orgId: TEST_ORG,
          tags: { env: "unknown" },
          action: "publish",
        });
        fail("expected TagPolicyViolationError");
      } catch (err) {
        expect(err).toBeInstanceOf(TagPolicyViolationError);
        const tpve = err as TagPolicyViolationError;
        expect(tpve.message).toContain("invalid values for keys: env");
        expect(tpve.message).toContain("missing required keys: team");
      }
    });

    it("throws TagPolicyLookupError when policy cannot be loaded", async () => {
      const cause = new Error("DynamoDB timeout");
      mockSend.mockRejectedValueOnce(cause);
      try {
        await enforceTagPolicy({
          orgId: TEST_ORG,
          tags: { env: "prod", team: "platform" },
          action: "createAgent",
        });
        fail("expected TagPolicyLookupError");
      } catch (err) {
        expect(err).toBeInstanceOf(TagPolicyLookupError);
        const tple = err as TagPolicyLookupError;
        expect(tple.code).toBe("TAG_POLICY_LOOKUP_FAILURE");
        expect(tple.orgId).toBe(TEST_ORG);
      }
    });

    it("returns ok when org has no tag policy", async () => {
      stubPolicyResponse(null);
      const result = await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: {},
        action: "createAgent",
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });
  });

  // ── Policy cache ──────────────────────────────────────────────────

  describe("policy memoisation", () => {
    it("re-uses cached policy on second call for same orgId", async () => {
      mockGetGovernanceEnforce.mockResolvedValue("shadow");
      stubPolicyResponse(makePolicy());

      await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod", team: "x" },
        action: "createAgent",
      });
      await enforceTagPolicy({
        orgId: TEST_ORG,
        tags: { env: "prod", team: "x" },
        action: "createTool",
      });

      // DynamoDB GetCommand called only once
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // ── TagPolicyViolationError shape ─────────────────────────────────

  describe("TagPolicyViolationError", () => {
    it("has the correct name and code", () => {
      const err = new TagPolicyViolationError(
        [{ type: "MISSING_KEY", key: "env" }],
        "createAgent",
        TEST_ORG,
      );
      expect(err.name).toBe("TagPolicyViolationError");
      expect(err.code).toBe("TAG_POLICY_VIOLATION");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("TagPolicyLookupError", () => {
    it("has the correct name, code, and orgId", () => {
      const err = new TagPolicyLookupError(TEST_ORG, new Error("timeout"));
      expect(err.name).toBe("TagPolicyLookupError");
      expect(err.code).toBe("TAG_POLICY_LOOKUP_FAILURE");
      expect(err.orgId).toBe(TEST_ORG);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
