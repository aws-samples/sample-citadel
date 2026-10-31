/**
 * Org-scoping regression tests for tool-sandbox.ts (finding 615aa5bb).
 *
 * Before the fix: `handler`/`executeTool` accepted a client-supplied orgId
 * argument, never validated it against the caller's identity or the tool
 * config's own orgId, and never required a permission — so any authenticated
 * caller could execute another org's tool with that org's scoped
 * credentials. These tests prove:
 *   1. A cross-org caller (identity org != tool config org) is rejected.
 *   2. A caller lacking the tool:execute permission is rejected even when
 *      the org matches.
 *   3. loadToolConfig is looked up by toolId alone (no org filter possible —
 *      ToolsConfigTable has no OrgIndex), so the org check MUST happen
 *      after load, comparing the loaded config's own orgId to the caller's
 *      server-derived org — never trusting the client-supplied orgId
 *      argument for the decision.
 */
import type { AuthContext } from "../../types";
import {
  executeTool,
  handler,
  type ExecuteToolDeps,
  type SandboxToolConfig,
} from "../tool-sandbox";

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
  deriveRoles: jest.fn(() => []),
}));
jest.mock("../../utils/auth", () => ({
  hasPermission: jest.fn(),
}));

import { extractOrgFromEvent, isAdminFromEvent } from "../../utils/auth-event";
import { hasPermission } from "../../utils/auth";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.Mock;
const mockIsAdminFromEvent = isAdminFromEvent as jest.Mock;
const mockHasPermission = hasPermission as jest.Mock;

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return { userId: "user-1", roles: ["architect"], ...overrides };
}

function makeDeps(toolConfig: SandboxToolConfig | null): ExecuteToolDeps {
  return {
    loadToolConfig: jest.fn(async () => toolConfig),
    loadToolCode: jest.fn(
      async () => "module.exports = async (inputs) => ({ result: inputs });",
    ),
    resolveCredentials: jest.fn(async () => ({})),
    executeCode: jest.fn(async (_code, inputs) => ({ output: inputs })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasPermission.mockReturnValue(true);
});

describe("executeTool — org scoping (finding 615aa5bb)", () => {
  it("rejects a cross-org caller when the tool config belongs to a different org", async () => {
    const deps = makeDeps({ orgId: "org-owner", state: "active" });

    const result = await executeTool(
      "tool-1",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-attacker", // server-derived caller org != tool config org
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
    // Never resolved credentials or executed code for the cross-org tool.
    expect(deps.resolveCredentials).not.toHaveBeenCalled();
    expect(deps.executeCode).not.toHaveBeenCalled();
  });

  it("allows a same-org caller with tool:execute permission to run the tool", async () => {
    const deps = makeDeps({ orgId: "org-owner", state: "active" });

    const result = await executeTool(
      "tool-1",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-owner",
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.executeCode).toHaveBeenCalled();
  });

  it("rejects a same-org caller lacking the tool:execute permission", async () => {
    mockHasPermission.mockReturnValue(false);
    const deps = makeDeps({ orgId: "org-owner", state: "active" });

    const result = await executeTool(
      "tool-1",
      { a: 1 },
      makeAuthContext({ roles: ["developer"] }), // no tool:execute
      "org-owner",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UnauthorizedError|permission/i);
    expect(deps.executeCode).not.toHaveBeenCalled();
  });

  it("rejects an org-less tool config (fail-closed, H19)", async () => {
    // H19: Legacy/shared tool configs with no orgId are now REJECTED
    // under fail-closed semantics — absent orgId is NOT shared.
    // Post-CIT-252 backfill, system-seeded tools carry
    // orgId: "All Organizations" instead.
    const deps = makeDeps({ state: "active" } as SandboxToolConfig);

    const result = await executeTool(
      "tool-shared",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-any",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
  });
});

describe("executeTool — H19 fail-closed org guard", () => {
  it("rejects tool with empty-string orgId", async () => {
    const deps = makeDeps({ orgId: "", state: "active" } as unknown as SandboxToolConfig);

    const result = await executeTool(
      "tool-empty-org",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-any",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
  });

  it('accepts tool with orgId "All Organizations" for any caller', async () => {
    const deps = makeDeps({
      orgId: "All Organizations",
      state: "active",
    } as unknown as SandboxToolConfig);

    const result = await executeTool(
      "tool-system",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-any",
      deps,
    );

    expect(result.success).toBe(true);
  });

  it('rejects tool with orgId "all organizations" (case-sensitive sentinel)', async () => {
    const deps = makeDeps({
      orgId: "all organizations",
      state: "active",
    } as unknown as SandboxToolConfig);

    const result = await executeTool(
      "tool-case",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-any",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not found");
  });

  it("produces identical error for missing tool vs absent orgId vs cross-org", async () => {
    const missingDeps = makeDeps(null);
    const missingResult = await executeTool(
      "missing",
      {},
      makeAuthContext({ roles: ["architect"] }),
      "org-a",
      missingDeps,
    );

    const noOrgDeps = makeDeps({ state: "active" } as SandboxToolConfig);
    const noOrgResult = await executeTool(
      "no-org",
      {},
      makeAuthContext({ roles: ["architect"] }),
      "org-a",
      noOrgDeps,
    );

    const crossOrgDeps = makeDeps({ orgId: "org-b", state: "active" } as unknown as SandboxToolConfig);
    const crossOrgResult = await executeTool(
      "cross",
      {},
      makeAuthContext({ roles: ["architect"] }),
      "org-a",
      crossOrgDeps,
    );

    expect(missingResult.error).toBe("Tool not found");
    expect(noOrgResult.error).toBe("Tool not found");
    expect(crossOrgResult.error).toBe("Tool not found");
  });
});

describe("handler — server-derives org from identity, never trusts the argument (finding 615aa5bb)", () => {
  it("rejects when the client-supplied orgId argument does not match the caller-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasPermission.mockReturnValue(true);

    const event = {
      identity: { sub: "user-1", "cognito:groups": ["architect"] },
      arguments: {
        toolId: "tool-1",
        inputs: JSON.stringify({ a: 1 }),
        orgId: "org-spoofed", // attacker-supplied, does not match identity
      },
    };

    const result = await handler(event);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UnauthorizedError|org/i);
  });

  it("rejects when no server-derivable org exists for the caller", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasPermission.mockReturnValue(true);

    const event = {
      identity: {},
      arguments: {
        toolId: "tool-1",
        inputs: JSON.stringify({ a: 1 }),
        orgId: "org-x",
      },
    };

    const result = await handler(event);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/UnauthorizedError|org/i);
  });
});
