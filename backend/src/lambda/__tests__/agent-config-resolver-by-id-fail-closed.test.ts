/**
 * PR-3 follow-up (verify round 1) — getAgentConfigRegistry's by-id read path
 * and its legacy DynamoDB fallback (getAgentConfig) were the same fail-open
 * class the rest of PR-3 removed from the list/search pre-filters:
 *
 *   if (!admin && mapped.orgId && mapped.orgId !== callerOrgId) return null;
 *
 * `mapped.orgId` is falsy for both the deprecated blank string `""` and the
 * new `undefined` (orgUnknown) shape, so the gate was skipped for exactly
 * the records PR-3 set out to lock down, and any non-admin caller in any
 * org could read an unstamped or orgUnknown agent config directly by id —
 * no isRecordVisible/status check on this path at all. The tool-side twin
 * (getToolConfigRegistry) was already fail-closed (`!mapped.orgId ||`); the
 * agent side is fixed here to use the same `callerMayConsiderOrg` helper
 * the list/search pre-filters use.
 */
import { GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ── Mock RegistryService ───────────────────────────────────────────────
const mockGetResource = jest.fn();

interface RegistryRecordFixture {
  recordId: string;
  name?: string;
  description?: string;
  status?: string;
  customDescriptorContent?: string;
}

const mockMapToAgentConfig = jest.fn((record: RegistryRecordFixture) => {
  const meta = record.customDescriptorContent
    ? (() => {
        try {
          return JSON.parse(record.customDescriptorContent!) as {
            orgId?: string;
          };
        } catch {
          return {};
        }
      })()
    : {};
  return {
    agentId: record.recordId,
    // Mirrors the real mapToAgentConfig post-PR-3: absent orgId stays
    // absent and carries orgUnknown instead of collapsing to "".
    ...(typeof meta.orgId === "string"
      ? { orgId: meta.orgId }
      : { orgUnknown: true }),
    config: record.description ?? "",
    state: "active",
    categories: [] as string[],
  };
});

jest.mock("../../services/registry-service", () => {
  const MockRS = jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    mapToAgentConfig: mockMapToAgentConfig,
  }));
  MockRS.isThrottlingError = () => false;
  return {
    RegistryService: MockRS,
    RegistryRecordStatusValues: {
      DRAFT: "DRAFT",
      PENDING_APPROVAL: "PENDING_APPROVAL",
      APPROVED: "APPROVED",
      REJECTED: "REJECTED",
      DEPRECATED: "DEPRECATED",
      CREATING: "CREATING",
      UPDATING: "UPDATING",
      CREATE_FAILED: "CREATE_FAILED",
      UPDATE_FAILED: "UPDATE_FAILED",
    },
    RegistryThrottledError: class RegistryThrottledError extends Error {
      retryable = true;
    },
  };
});

import {
  getAgentConfigRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

const recordWithOrgId = (agentId: string, orgId: string) => ({
  recordId: agentId,
  name: "TestAgent",
  description: '{"name":"TestAgent"}',
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({ citadelKind: "agent", orgId }),
});

const recordWithBlankOrgId = (agentId: string) => ({
  recordId: agentId,
  name: "TestAgent",
  description: '{"name":"TestAgent"}',
  status: "DRAFT",
  customDescriptorContent: JSON.stringify({ citadelKind: "agent", orgId: "" }),
});

const recordWithAbsentOrgId = (agentId: string) => ({
  recordId: agentId,
  name: "TestAgent",
  description: '{"name":"TestAgent"}',
  status: "DRAFT",
  customDescriptorContent: JSON.stringify({ citadelKind: "agent" }),
});

const orgAEvent = {
  identity: { claims: { "custom:organization": "org-a" } },
};
const adminEvent = {
  identity: {
    claims: { "cognito:groups": ["admin"], "custom:organization": "org-a" },
  },
};

describe("getAgentConfigRegistry — by-id fail-closed on blank/absent/orgUnknown orgId (PR-3 follow-up)", () => {
  beforeEach(() => {
    process.env.AGENT_CONFIG_TABLE = "test-agents";
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "test-registry";
    _resetRegistryService();
    jest.clearAllMocks();
    dynamoMock.reset();
  });

  test('registry-path record with blank orgId ("") is rejected for a non-admin caller in a different org', async () => {
    mockGetResource.mockResolvedValue(recordWithBlankOrgId("agent-1"));

    const result = await getAgentConfigRegistry("agent-1", orgAEvent);

    expect(result).toBeNull();
  });

  test("registry-path record with absent orgId (orgUnknown) is rejected for a non-admin caller", async () => {
    mockGetResource.mockResolvedValue(recordWithAbsentOrgId("agent-1"));

    const result = await getAgentConfigRegistry("agent-1", orgAEvent);

    expect(result).toBeNull();
  });

  test("registry-path record with ALL_ORGS orgId is returned to a non-admin caller in a different org", async () => {
    mockGetResource.mockResolvedValue(
      recordWithOrgId("agent-1", "All Organizations"),
    );

    const result = await getAgentConfigRegistry("agent-1", orgAEvent);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
  });

  test("registry-path record with the caller's own orgId is returned", async () => {
    mockGetResource.mockResolvedValue(recordWithOrgId("agent-1", "org-a"));

    const result = await getAgentConfigRegistry("agent-1", orgAEvent);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
  });

  test("registry-path record with a foreign non-empty orgId is rejected", async () => {
    mockGetResource.mockResolvedValue(recordWithOrgId("agent-1", "org-b"));

    const result = await getAgentConfigRegistry("agent-1", orgAEvent);

    expect(result).toBeNull();
  });

  test("admin bypasses the org gate even for a foreign-org record", async () => {
    mockGetResource.mockResolvedValue(recordWithOrgId("agent-1", "org-b"));

    const result = await getAgentConfigRegistry("agent-1", adminEvent);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
  });

  describe("legacy DynamoDB fallback (Registry getResource error → getAgentConfig)", () => {
    beforeEach(() => {
      mockGetResource.mockRejectedValue(new Error("Registry unavailable"));
    });

    test('legacy row with blank orgId ("") is rejected for a non-admin caller in a different org', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "agent-1", orgId: "", config: "{}", state: "active" },
      });

      const result = await getAgentConfigRegistry("agent-1", orgAEvent);

      expect(result).toBeNull();
    });

    test("legacy row with absent orgId is rejected for a non-admin caller", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "agent-1", config: "{}", state: "active" },
      });

      const result = await getAgentConfigRegistry("agent-1", orgAEvent);

      expect(result).toBeNull();
    });

    test("legacy row with ALL_ORGS orgId is returned to a non-admin caller in a different org", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "agent-1",
          orgId: "All Organizations",
          config: "{}",
          state: "active",
        },
      });

      const result = await getAgentConfigRegistry("agent-1", orgAEvent);

      expect(result).not.toBeNull();
    });

    test("legacy row with the caller's own orgId is returned", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "agent-1",
          orgId: "org-a",
          config: "{}",
          state: "active",
        },
      });

      const result = await getAgentConfigRegistry("agent-1", orgAEvent);

      expect(result).not.toBeNull();
    });

    test("admin bypasses the org gate on the legacy fallback too", async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: "agent-1",
          orgId: "org-b",
          config: "{}",
          state: "active",
        },
      });

      const result = await getAgentConfigRegistry("agent-1", adminEvent);

      expect(result).not.toBeNull();
    });
  });
});
