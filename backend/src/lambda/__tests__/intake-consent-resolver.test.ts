/**
 * Tests for the intake consent gate resolver.
 *
 * Contract:
 * - Writes a consent record to SESSION_MEMORY_TABLE with 10-min TTL
 * - Cross-org callers are rejected (org reconciliation)
 * - Invalid actions are rejected
 * - Returns {ok, action, expiresAt} on success
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// ── DynamoDB mocks ──────────────────────────────────────────────────────
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  GetCommand: jest.fn((args: unknown) => ({
    _tag: "Get",
    ...((args as Record<string, unknown>) ?? {}),
  })),
  PutCommand: jest.fn((args: unknown) => ({
    _tag: "Put",
    ...((args as Record<string, unknown>) ?? {}),
  })),
  ScanCommand: jest.fn((args: unknown) => ({
    _tag: "Scan",
    ...((args as Record<string, unknown>) ?? {}),
  })),
}));

// ── Auth mocks ──────────────────────────────────────────────────────────
const mockExtractOrg =
  jest.fn<(...args: unknown[]) => Promise<string | null>>();
const mockRequireCallerOrg = jest.fn<(...args: unknown[]) => Promise<string>>();
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrg(...args),
  requireCallerOrg: (...args: unknown[]) => mockRequireCallerOrg(...args),
  OrgUnresolvedError: class OrgUnresolvedError extends Error {
    constructor(
      message = "Organisation could not be determined for this account",
    ) {
      super(message);
      this.name = "OrgUnresolvedError";
    }
  },
}));

const mockLookupOwnerOrg =
  jest.fn<(...args: unknown[]) => Promise<string | null>>();
jest.mock("../../utils/org-membership", () => ({
  lookupOwnerOrganization: (...args: unknown[]) => mockLookupOwnerOrg(...args),
}));

// ── Env ─────────────────────────────────────────────────────────────────
process.env.SESSION_MEMORY_TABLE = "test-session-memory";
process.env.PROJECTS_TABLE = "test-projects";
process.env.CONVERSATIONS_TABLE = "test-conversations";

import { handler, CONSENT_TTL_SECONDS } from "../intake-consent-resolver";
import type { AppSyncResolverEvent } from "aws-lambda";

function makeEvent(
  args: Record<string, unknown>,
  org: string | null = "org-1",
): AppSyncResolverEvent<Record<string, unknown>> {
  mockExtractOrg.mockResolvedValue(org);
  if (org) {
    mockRequireCallerOrg.mockResolvedValue(org);
  } else {
    mockRequireCallerOrg.mockRejectedValue(
      new Error("Organisation could not be determined for this account"),
    );
  }
  return {
    arguments: args,
    identity: { claims: { sub: "user-1", "custom:organization": org ?? "" } },
    info: { fieldName: "recordIntakeConsent" },
  } as unknown as AppSyncResolverEvent<Record<string, unknown>>;
}

describe("intake-consent-resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: project exists with matching org, no conversation linkage.
    mockSend.mockImplementation(async (cmd: unknown) => {
      const tag = (cmd as Record<string, unknown>)?._tag;
      if (tag === "Scan") return { Items: [] };
      if (tag === "Get")
        return {
          Item: { id: "proj-1", organization: "org-1", owner: "user-1" },
        };
      if (tag === "Put") return {};
      return {};
    });
  });

  it("writes a consent record with correct TTL and returns ok", async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await handler(
      makeEvent({ projectId: "proj-1", action: "activate_agents" }),
    );
    const after = Math.floor(Date.now() / 1000);

    expect(result).toMatchObject({
      ok: true,
      action: "activate_agents",
    });
    expect((result as Record<string, unknown>).expiresAt).toBeDefined();

    // Verify PutCommand was called
    const putCall = mockSend.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>)?._tag === "Put",
    );
    expect(putCall).toBeDefined();
    const putArgs = putCall![0] as Record<string, unknown>;
    const item = (putArgs as Record<string, unknown>).Item as Record<
      string,
      unknown
    >;
    expect(item.p_key).toBe("proj-1");
    expect(item.s_key).toBe("consent#activate_agents");
    expect(item.ttl).toBeGreaterThanOrEqual(before + CONSENT_TTL_SECONDS);
    expect(item.ttl).toBeLessThanOrEqual(after + CONSENT_TTL_SECONDS);
  });

  it("accepts all four valid actions", async () => {
    for (const action of [
      "activate_agents",
      "create_agent_app",
      "generate_process_blueprint",
      "import_blueprint_to_app",
    ]) {
      mockSend.mockClear();
      const result = await handler(makeEvent({ projectId: "proj-1", action }));
      expect((result as Record<string, unknown>).ok).toBe(true);
      expect((result as Record<string, unknown>).action).toBe(action);
    }
  });

  it("rejects an invalid action", async () => {
    await expect(
      handler(makeEvent({ projectId: "proj-1", action: "delete_everything" })),
    ).rejects.toThrow("Invalid action");
  });

  it("rejects missing projectId", async () => {
    await expect(
      handler(makeEvent({ action: "activate_agents" })),
    ).rejects.toThrow("projectId is required");
  });

  it("rejects cross-org callers", async () => {
    // Caller org = different-org, session org = org-1
    await expect(
      handler(
        makeEvent(
          { projectId: "proj-1", action: "activate_agents" },
          "different-org",
        ),
      ),
    ).rejects.toThrow("Access denied");
  });

  it("uses owner-org fallback when project has no organization", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      const tag = (cmd as Record<string, unknown>)?._tag;
      if (tag === "Scan") return { Items: [] };
      if (tag === "Get") return { Item: { id: "proj-1", owner: "owner-sub" } };
      if (tag === "Put") return {};
      return {};
    });
    mockLookupOwnerOrg.mockResolvedValue("org-1");

    const result = await handler(
      makeEvent({ projectId: "proj-1", action: "activate_agents" }),
    );
    expect((result as Record<string, unknown>).ok).toBe(true);
    expect(mockLookupOwnerOrg).toHaveBeenCalledWith("owner-sub");
  });

  it("rejects an org-less caller (fail-closed, no 'default' sentinel)", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      const tag = (cmd as Record<string, unknown>)?._tag;
      if (tag === "Scan") return { Items: [] };
      if (tag === "Get") return { Item: { id: "proj-1" } }; // no org, no owner
      if (tag === "Put") return {};
      return {};
    });
    mockLookupOwnerOrg.mockResolvedValue(null);

    // Caller has no org → requireCallerOrg throws
    await expect(
      handler(
        makeEvent({ projectId: "proj-1", action: "activate_agents" }, null),
      ),
    ).rejects.toThrow(/organisation could not be determined/i);
  });

  it("rejects an org-less session even when the caller has an org", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      const tag = (cmd as Record<string, unknown>)?._tag;
      if (tag === "Scan") return { Items: [] };
      if (tag === "Get") return { Item: { id: "proj-1" } }; // no org, no owner
      if (tag === "Put") return {};
      return {};
    });
    mockLookupOwnerOrg.mockResolvedValue(null);

    // Caller has org-1 but session org is unresolvable → OrgUnresolvedError
    await expect(
      handler(
        makeEvent({ projectId: "proj-1", action: "activate_agents" }, "org-1"),
      ),
    ).rejects.toThrow(/organisation could not be determined/i);
  });

  // ─── cross-org isolation ──────────────────────────────────────────────

  it("rejects org-A caller writing consent for org-B session", async () => {
    // Session belongs to org-B; caller belongs to org-A.
    mockSend.mockImplementation(async (cmd: unknown) => {
      const tag = (cmd as Record<string, unknown>)?._tag;
      if (tag === "Scan") return { Items: [] };
      if (tag === "Get")
        return {
          Item: { id: "proj-1", organization: "org-B", owner: "user-B" },
        };
      if (tag === "Put") return {};
      return {};
    });

    await expect(
      handler(
        makeEvent({ projectId: "proj-1", action: "activate_agents" }, "org-A"),
      ),
    ).rejects.toThrow("Access denied");
  });
});
