/**
 * Org-scoping regression test for listIntegrations (finding f0ce2b00,
 * high — supersedes the sweep finding under 615aa5bb coerce-based fix
 * that shipped here previously).
 *
 * The coerce-based fix (`callerOrgId || event.arguments.orgId`) inverted
 * the trust direction it looked like it was enforcing: when a non-admin
 * caller had NO resolvable `custom:organization` claim (reachable —
 * `adminCreateUser` never sets that attribute, finding cbbc3be1),
 * `callerOrgId` was `null`/`""`, so `||` fell through to the
 * CLIENT-SUPPLIED `event.arguments.orgId` — handing that caller another
 * tenant's full integrations list (names, types, connection status) on
 * request, since `orgId` is a required argument on this query per
 * schema.graphql.
 *
 * Fixed shape (mirrors `requireCallerOrg` in user-management-resolver.ts):
 *   - Admin: use the supplied argument explicitly.
 *   - Non-admin: use ONLY the caller's own resolved org.
 *   - Unresolved effective org (non-admin, no claim): DENY via
 *     PermissionError — never fall through to the client argument.
 */
const mockSend = jest.fn();
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
  assertRowOrg: jest.fn(),
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({ send: mockSend }),
    },
    QueryCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Query", input })),
  };
});

import { handler } from "../integration-resolver";
import { extractOrgFromEvent, isAdminFromEvent } from "../../utils/auth-event";
import { PermissionError } from "../adapters/errors";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.Mock;
const mockIsAdminFromEvent = isAdminFromEvent as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockImplementation(async (command: unknown) => {
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
  });
});

describe("listIntegrations — fail-closed org scoping (finding f0ce2b00)", () => {
  it("DENIES a non-admin caller with no resolvable org claim, regardless of the orgId argument supplied — no rows leak", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listIntegrations" },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-real" },
    };

    await expect(handler(event as never)).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("DENIES a non-admin caller passing another tenant's orgId rather than returning that tenant's records", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-mine");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listIntegrations" },
      identity: { sub: "user-2" },
      arguments: { orgId: "org-real" }, // attacker-supplied
    };

    const result = await handler(event as never);
    expect(result).toEqual([]);
    const call = mockSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":pk"]).toBe("ORG#org-mine");
  });

  it("admin callers may still list a specified org's integrations explicitly", async () => {
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

  it("a normal non-admin caller still sees their own org's integrations", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listIntegrations" },
      identity: { sub: "user-3" },
      arguments: { orgId: "org-real" },
    };

    const result = await handler(event as never);
    expect(result).toEqual([
      expect.objectContaining({ integrationId: "int-1" }),
    ]);
  });
});
