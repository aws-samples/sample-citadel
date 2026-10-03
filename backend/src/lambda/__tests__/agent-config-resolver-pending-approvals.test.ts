/**
 * Tests for the listPendingApprovals dispatch path in agent-config-resolver.ts.
 *
 * Covers:
 *   - admin caller → items returned from registryService.listPendingApprovals
 *   - non-admin caller → Unauthorized error, service not called
 *   - pagination passthrough (limit + nextToken forwarded to service)
 */

const mockListPendingApprovals = jest.fn();

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listPendingApprovals: mockListPendingApprovals,
    // Stubs for other methods the module initialisation may reference:
    listResources: jest.fn(),
    getResource: jest.fn(),
    mapToAgentConfig: jest.fn(),
    searchResources: jest.fn(),
    createResource: jest.fn(),
    updateResource: jest.fn(),
    updateResourceStatus: jest.fn(),
    submitForApproval: jest.fn(),
    deleteResource: jest.fn(),
    resolveRecordId: jest.fn(),
    serializeCustomMetadata: jest.fn(),
    deserializeCustomMetadata: jest.fn(
      (_json: string | null, defaults: Record<string, unknown>) => defaults,
    ),
    toRegistryStatus: jest.fn(),
    toInternalState: jest.fn(),
  })),
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
}));

// The governance-flag + trust-path + events modules must be mocked so the
// module can be imported without hitting SSM/IAM/EventBridge at load time.
jest.mock("../../utils/governance-flag", () => ({
  getGovernanceEnforce: jest.fn().mockResolvedValue("shadow"),
}));
jest.mock("../../utils/trust-path", () => ({
  ...jest.requireActual("../../utils/trust-path"),
  computeTrustPath: jest.fn(),
  assumeAnalysisRoleClient: jest.fn(),
}));
jest.mock("../../utils/events", () => ({
  publishEvent: jest.fn(),
}));
jest.mock("../../utils/project-org-access", () => ({
  assertProjectOrgAccess: jest.fn(),
}));

import { handler, _resetRegistryService } from "../agent-config-resolver";

function adminEvent(args: Record<string, unknown> = {}) {
  return {
    info: { fieldName: "listPendingApprovals" },
    arguments: args,
    identity: {
      claims: {
        "custom:organization": "org-admin",
        "cognito:groups": "admin",
      },
    },
  };
}

function nonAdminEvent(args: Record<string, unknown> = {}) {
  return {
    info: { fieldName: "listPendingApprovals" },
    arguments: args,
    identity: {
      claims: {
        "custom:organization": "org-regular",
        "cognito:groups": "user",
      },
    },
  };
}

describe("listPendingApprovals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetRegistryService();
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "test-registry";
    process.env.AGENT_CONFIG_TABLE = "test-agent-config";
  });

  afterEach(() => {
    delete process.env.REGISTRY_ENABLED;
    delete process.env.REGISTRY_ID;
  });

  test("admin caller receives items from the service", async () => {
    const items = [
      {
        recordId: "rec-001",
        recordType: "agent",
        name: "my-agent",
        displayName: "My Agent",
        orgId: "org-1",
        submittedAt: "2026-10-01T00:00:00Z",
        createdBy: "user-a",
        status: "PENDING_APPROVAL",
      },
    ];
    mockListPendingApprovals.mockResolvedValue({
      items,
      nextToken: undefined,
    });

    const result = await handler(adminEvent());

    expect(result).toEqual({ items, nextToken: undefined });
    expect(mockListPendingApprovals).toHaveBeenCalledTimes(1);
    expect(mockListPendingApprovals).toHaveBeenCalledWith({});
  });

  test("non-admin caller receives Unauthorized error and service is not called", async () => {
    await expect(handler(nonAdminEvent())).rejects.toThrow(
      "Unauthorized: admin role required",
    );
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  test("pagination arguments are forwarded to the service", async () => {
    mockListPendingApprovals.mockResolvedValue({
      items: [],
      nextToken: "page-2-token",
    });

    const result = await handler(
      adminEvent({ limit: 10, nextToken: "page-1-token" }),
    );

    expect(result).toEqual({ items: [], nextToken: "page-2-token" });
    expect(mockListPendingApprovals).toHaveBeenCalledWith({
      limit: 10,
      nextToken: "page-1-token",
    });
  });
});
