/**
 * Org-scoping regression test for listIntegrations (sweep finding under
 * 615aa5bb): the handler dispatched `event.arguments.orgId` straight into
 * listIntegrations() with no identity validation — any authenticated
 * caller could pass another org's orgId and receive that org's
 * integrations list (names, types, connection status).
 *
 * Fix mirrors the read-path precedent (listApps in
 * registry-agent-record-resolver.ts / listProjects in project-resolver.ts):
 * a non-admin caller's own server-derived org silently WINS over a
 * mismatched requested orgId (coerce, not reject) — reads use the
 * "you only ever see your own org" tenant gate. This differs from the
 * mutation-path decision in testTool/decideToolApproval (explicit reject
 * on mismatch) because a read has no side effect to block; silently
 * scoping to the caller's real org is sufficient and matches every other
 * list* query in this codebase.
 */
import { handler } from "../integration-resolver";

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
}));

import { extractOrgFromEvent, isAdminFromEvent } from "../../utils/auth-event";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.Mock;
const mockIsAdminFromEvent = isAdminFromEvent as jest.Mock;

jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: () => ({
        send: jest.fn(async (command: unknown) => {
          const input = (
            command as {
              input: { ExpressionAttributeValues?: Record<string, string> };
            }
          ).input;
          const pk = input.ExpressionAttributeValues?.[":pk"];
          // Simulate DynamoDB partition isolation: only ever returns rows
          // matching the exact PK requested.
          if (pk === "ORG#org-real") {
            return {
              Items: [
                {
                  integrationId: "int-1",
                  integrationType: "SLACK",
                  status: "CONNECTED",
                  orgId: "org-real",
                },
              ],
            };
          }
          return { Items: [] };
        }),
      }),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listIntegrations — org scoping (sweep finding under 615aa5bb)", () => {
  it("ignores a cross-org orgId argument and scopes to the caller's own server-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listIntegrations" },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-spoofed" }, // attacker-supplied, does not match identity
    };

    const result = await handler(event as never);

    // Caller's real org's integration is returned, never the spoofed org's
    // (which the mock would return empty for since it queries a different PK).
    expect(result).toEqual([
      expect.objectContaining({ integrationId: "int-1" }),
    ]);
  });

  it("admin callers may pass an explicit orgId to list any org's integrations", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(true);

    const event = {
      info: { fieldName: "listIntegrations" },
      identity: { sub: "admin-1", "custom:role": "admin" },
      arguments: { orgId: "org-real" },
    };

    const result = await handler(event as never);
    expect(result).toEqual([
      expect.objectContaining({ integrationId: "int-1" }),
    ]);
  });
});
