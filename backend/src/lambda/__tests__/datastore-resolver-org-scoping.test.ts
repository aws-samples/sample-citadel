/**
 * Org-scoping regression tests for datastore-resolver.ts (finding f0ce2b00,
 * high — supersedes the sweep finding 615aa5bb coerce-based fix that
 * shipped here previously).
 *
 * The coerce-based fix (`callerOrgId || event.arguments.orgId`) inverted
 * the trust direction it looked like it was enforcing: when a non-admin
 * caller had NO resolvable `custom:organization` claim (reachable —
 * `adminCreateUser` never sets that attribute, finding cbbc3be1),
 * `callerOrgId` was `null`/`""`, so `||` fell through to the
 * CLIENT-SUPPLIED `event.arguments.orgId` — handing that caller any
 * tenant's full row set on request, since `orgId` is a required argument
 * on all four affected queries per schema.graphql.
 *
 * Fixed shape (mirrors `requireCallerOrg` in user-management-resolver.ts):
 *   - Admin: use the supplied argument explicitly (reachable only via an
 *     explicit `isAdminFromEvent` check, never via absence of a claim).
 *   - Non-admin: use ONLY the caller's own resolved org.
 *   - Unresolved effective org (non-admin, no claim): DENY via
 *     PermissionError — never fall through to the client argument.
 */
// ---- Mock setup ----
const mockDynamoSend = jest.fn();
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
      from: jest.fn().mockReturnValue({ send: mockDynamoSend }),
    },
    QueryCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Query", input })),
  };
});

import { handler } from "../datastore-resolver";
import { extractOrgFromEvent, isAdminFromEvent } from "../../utils/auth-event";
import { PermissionError } from "../adapters/errors";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.Mock;
const mockIsAdminFromEvent = isAdminFromEvent as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoSend.mockImplementation(
    async (command: {
      input: { ExpressionAttributeValues?: Record<string, string> };
    }) => {
      const orgId = command.input.ExpressionAttributeValues?.[":orgId"];
      // Simulate DynamoDB partition isolation: only ever returns rows for the
      // exact orgId the query was built with.
      if (orgId === "org-real") {
        return {
          Items: [
            {
              dataStoreId: "ds-1",
              category: "KNOWLEDGE_BASE",
              type: "S3",
              status: "CONNECTED",
              usage: "BOTH",
            },
          ],
        };
      }
      return { Items: [] };
    },
  );
});

describe.each([
  ["getDataStoreStats"],
  ["listDataStores"],
  ["listAvailableDataSources"],
])("%s — fail-closed org scoping (finding f0ce2b00)", (fieldName) => {
  it("DENIES a non-admin caller with no resolvable org claim, regardless of the orgId argument supplied — no rows leak", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-real" },
    };

    await expect(handler(event as never)).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("DENIES a non-admin caller passing another tenant's orgId rather than returning that tenant's records", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-mine");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName },
      identity: { sub: "user-2" },
      arguments: { orgId: "org-real" }, // attacker-supplied, does not match caller
    };

    const result = await handler(event as never);
    // Must be scoped to the caller's OWN org (which the mock returns empty
    // for), never the spoofed org-real — the caller receives nothing.
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-mine");
    if (Array.isArray(result)) {
      expect(result).toEqual([]);
    } else {
      expect(result.total).toBe(0);
    }
  });

  it("admin callers may still query a specified org explicitly", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(true);

    const event = {
      info: { fieldName },
      identity: { sub: "admin-1", "custom:role": "admin" },
      arguments: { orgId: "org-real" },
    };

    const result = await handler(event as never);
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-real");
    if (Array.isArray(result)) {
      expect(result.length).toBeGreaterThan(0);
    } else {
      expect(result.total).toBe(1);
    }
  });

  it("a normal non-admin caller still sees their own org's rows", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName },
      identity: { sub: "user-3" },
      arguments: { orgId: "org-real" },
    };

    const result = await handler(event as never);
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-real");
    if (Array.isArray(result)) {
      expect(result.length).toBeGreaterThan(0);
    } else {
      expect(result.total).toBe(1);
    }
  });
});
