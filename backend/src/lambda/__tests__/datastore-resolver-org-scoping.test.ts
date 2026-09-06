/**
 * Org-scoping regression tests for datastore-resolver.ts (sweep finding
 * under 615aa5bb, filed against getDataStoreStats and re-swept across the
 * whole file).
 *
 * Before the fix: getDataStoreStats/listDataStores/listAvailableDataSources
 * all dispatched `event.arguments.orgId` straight into an OrgIndex query
 * with no identity validation — any authenticated caller could pass another
 * org's orgId and read that org's data store inventory / connection stats.
 *
 * Fix mirrors the read-path tenant gate used by listIntegrations
 * (integration-resolver.ts, same sweep) / listApps
 * (registry-agent-record-resolver.ts) / listProjects (project-resolver.ts):
 * a non-admin caller's server-derived org always wins over a mismatched
 * requested orgId (coerce, not reject). Admins may still pass an explicit
 * orgId.
 */
// ---- Mock setup ----
const mockDynamoSend = jest.fn();
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
  isAdminFromEvent: jest.fn(),
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

describe("getDataStoreStats — org scoping (sweep finding 615aa5bb)", () => {
  it("ignores a cross-org orgId argument and scopes stats to the caller server-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "getDataStoreStats" },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-spoofed" },
    };

    const result = await handler(event as never);

    expect(result.total).toBe(1);
    expect(result.connected).toBe(1);

    // Verify the query was actually built with the caller's real org, not
    // the spoofed argument — no unscoped/cross-org scan remains.
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-real");
  });

  it("returns empty stats for a cross-org caller instead of leaking the spoofed org data", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-empty");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "getDataStoreStats" },
      identity: { sub: "user-2" },
      arguments: { orgId: "org-real" }, // attacker-supplied, does not match identity
    };

    const result = await handler(event as never);

    expect(result.total).toBe(0);
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-empty");
  });

  it("admin callers may pass an explicit orgId to read any org stats", async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    mockIsAdminFromEvent.mockReturnValue(true);

    const event = {
      info: { fieldName: "getDataStoreStats" },
      identity: { sub: "admin-1", "custom:role": "admin" },
      arguments: { orgId: "org-real" },
    };

    const result = await handler(event as never);
    expect(result.total).toBe(1);
  });
});

describe("listDataStores — org scoping (re-sweep, same mechanical shape)", () => {
  it("ignores a cross-org orgId argument and scopes to the caller server-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listDataStores" },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-spoofed" },
    };

    const result = await handler(event as never);
    expect(result).toEqual([expect.objectContaining({ dataStoreId: "ds-1" })]);
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-real");
  });
});

describe("listAvailableDataSources — org scoping (re-sweep, same mechanical shape)", () => {
  it("ignores a cross-org orgId argument and scopes to the caller server-derived org", async () => {
    mockExtractOrgFromEvent.mockResolvedValue("org-real");
    mockIsAdminFromEvent.mockReturnValue(false);

    const event = {
      info: { fieldName: "listAvailableDataSources" },
      identity: { sub: "user-1" },
      arguments: { orgId: "org-spoofed" },
    };

    await handler(event as never);
    const call = mockDynamoSend.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[":orgId"]).toBe("org-real");
  });
});
