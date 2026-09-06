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

  it("allows execution of an org-less (shared) tool config for any authenticated org", async () => {
    // Legacy/shared tool configs may have no orgId — treated as visible to
    // every org-scoped caller, mirroring getToolConfigRegistry's
    // `mapped.orgId && mapped.orgId !== callerOrgId` guard (only enforced
    // when the config actually carries an orgId).
    const deps = makeDeps({ state: "active" } as SandboxToolConfig);

    const result = await executeTool(
      "tool-shared",
      { a: 1 },
      makeAuthContext({ roles: ["architect"] }),
      "org-any",
      deps,
    );

    expect(result.success).toBe(true);
  });
});

describe("handler — server-derives org from identity, never trusts the argument (finding 615aa5bb)", () => {
  it("rejects when the client-supplied orgId argument does not match the caller-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasPermission.mockReturnValue(true);

    const event = {
      identity: { sub: "user-1", "custom:role": "architect" },
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
