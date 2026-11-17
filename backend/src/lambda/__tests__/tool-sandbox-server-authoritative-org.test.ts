/**
 * Board task 663c0271: testTool must derive the org server-side and IGNORE
 * any client-supplied orgId. After the schema change, the `orgId` argument
 * no longer exists on the Mutation.testTool field, so the handler must
 * work without it.
 *
 * These tests are written RED-first against main (the orgId argument still
 * exists in the schema and the handler still reads it).
 */
import { handler } from "../tool-sandbox";

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
  requireCallerOrg: jest.fn(),
  deriveRoles: jest.fn(() => []),
}));
jest.mock("../../utils/auth", () => ({
  hasPermission: jest.fn(),
}));

import {
  extractOrgFromEvent,
  isAdminFromEvent,
  requireCallerOrg,
} from "../../utils/auth-event";
import { hasPermission } from "../../utils/auth";

const mockExtractOrg = extractOrgFromEvent as jest.Mock;
const mockIsAdmin = isAdminFromEvent as jest.Mock;
const mockRequireCallerOrg = requireCallerOrg as jest.Mock;
const mockHasPermission = hasPermission as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockHasPermission.mockReturnValue(true);
  mockIsAdmin.mockReturnValue(false);
});

describe("handler — server-authoritative org (board 663c0271)", () => {
  it("uses requireCallerOrg instead of extractOrgFromEvent for non-admin callers", async () => {
    mockRequireCallerOrg.mockResolvedValue("org-server");
    mockExtractOrg.mockResolvedValue("org-server");

    const event = {
      identity: { sub: "u1", "cognito:groups": ["architect"] },
      arguments: {
        toolId: "tool-1",
        inputs: JSON.stringify({ x: 1 }),
      },
    };

    await handler(event as Parameters<typeof handler>[0]);

    expect(mockRequireCallerOrg).toHaveBeenCalledWith(
      event,
      "ToolSandbox",
    );
  });

  it("succeeds even when event.arguments has no orgId property at all", async () => {
    mockRequireCallerOrg.mockResolvedValue("org-real");
    mockExtractOrg.mockResolvedValue("org-real");
    mockHasPermission.mockReturnValue(true);

    const event = {
      identity: { sub: "u1", "cognito:groups": ["architect"] },
      arguments: {
        toolId: "tool-1",
        inputs: JSON.stringify({ x: 1 }),
      },
    };

    const result = await handler(event as Parameters<typeof handler>[0]);
    expect(result.error).not.toMatch(/orgId/i);
  });

  it("admin without resolvable org falls back to extractOrgFromEvent, NOT a client argument", async () => {
    mockIsAdmin.mockReturnValue(true);
    mockExtractOrg.mockResolvedValue(null);

    const event = {
      identity: { sub: "admin1", "cognito:groups": ["admin"] },
      arguments: {
        toolId: "tool-1",
        inputs: JSON.stringify({}),
      },
    };

    const result = await handler(event as Parameters<typeof handler>[0]);

    // With no server-derived org and no fallback to client value, admin
    // hits the org gate — the handler MUST NOT use event.arguments.orgId
    expect(result.success).toBe(false);
  });
});
