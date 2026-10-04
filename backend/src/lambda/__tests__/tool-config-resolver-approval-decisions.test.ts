/**
 * Tests for tool record approval/rejection decision logic in
 * updateToolConfigRegistry (CIT-215).
 *
 * Mirrors the four required scenarios:
 *   1. Admin approves PENDING_APPROVAL → status call + metadata stamped
 *   2. Non-admin → UnauthorizedError, no registry calls
 *   3. Reject without statusReason → ValidationError
 *   4. Invalid transition (e.g. DRAFT → APPROVED) → RegistryLifecycleError
 */
import {
  updateToolConfigRegistry,
  _resetRegistryService,
} from "../tool-config-resolver";

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------

const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSubmitForApproval = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: unknown) =>
  JSON.stringify(meta),
);
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try {
      return { ...defaults, ...JSON.parse(json) };
    } catch {
      return defaults;
    }
  },
);
const mockToRegistryStatus = jest.fn((state: string) => {
  const map: Record<string, string> = {
    active: "APPROVED",
    maintenance: "DEPRECATED",
  };
  return map[state] || "DEPRECATED";
});
const mockToInternalState = jest.fn((status: string) => {
  const map: Record<string, string> = {
    APPROVED: "active",
    DEPRECATED: "inactive",
    DRAFT: "maintenance",
    PENDING_APPROVAL: "pending",
    REJECTED: "inactive",
  };
  return map[status] || "inactive";
});

interface RegistryRecordFixture {
  recordId: string;
  name?: string;
  description?: string;
  status: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const mockMapToToolConfig = jest.fn((record: RegistryRecordFixture) => {
  const meta = record.customDescriptorContent
    ? (() => {
        try {
          return JSON.parse(record.customDescriptorContent);
        } catch {
          return {};
        }
      })()
    : {};
  return {
    toolId: record.recordId,
    orgId: meta.orgId ?? "",
    config: meta.config ?? record.description ?? "",
    state: mockToInternalState(record.status),
    categories: meta.categories || [],
    integrationBindings: meta.integrationBindings || null,
    dataStoreBindings: meta.dataStoreBindings || null,
    registryStatus: record.status,
    decidedBy: meta.decidedBy ?? undefined,
    decidedAt: meta.decidedAt ?? undefined,
    statusReason: meta.statusReason ?? undefined,
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => "test-registry",
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    updateResourceStatus: mockUpdateResourceStatus,
    submitForApproval: mockSubmitForApproval,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    toInternalState: mockToInternalState,
    mapToToolConfig: mockMapToToolConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
  },
  RegistryLifecycleError: class RegistryLifecycleError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "RegistryLifecycleError";
      this.code = code;
    }
  },
}));

// Mock auth utilities
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("test-org-a"),
  isAdminFromEvent: jest.fn().mockReturnValue(true),
  assertRowOrg: jest.fn().mockResolvedValue(undefined),
  canCallerSeeRow: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("admin-user-123"),
}));

// We need access to mock controls
import { isAdminFromEvent } from "../../utils/auth-event";
import { getUserId } from "../../utils/appsync";

const mockedIsAdmin = isAdminFromEvent as jest.MockedFunction<
  typeof isAdminFromEvent
>;
const mockedGetUserId = getUserId as jest.MockedFunction<typeof getUserId>;

describe("Tool approval/rejection decisions (CIT-215)", () => {
  const originalEnv = process.env;

  const adminEvent = {
    identity: {
      sub: "admin-user-123",
      claims: {
        "custom:organization": "test-org-a",
        "cognito:groups": ["admin"],
      },
    },
  };

  const nonAdminEvent = {
    identity: {
      sub: "regular-user-456",
      claims: {
        "custom:organization": "test-org-a",
      },
    },
  };

  /** Fixture: a PENDING_APPROVAL tool record. */
  const pendingRecord: RegistryRecordFixture = {
    recordId: "tool-001",
    name: "My Tool",
    description: JSON.stringify({ name: "My Tool" }),
    status: "PENDING_APPROVAL",
    customDescriptorContent: JSON.stringify({
      categories: ["general"],
      icon: "",
      state: "active",
      orgId: "test-org-a",
      config: JSON.stringify({ name: "My Tool" }),
      createdBy: "creator-user",
    }),
  };

  /** Fixture: a DRAFT tool record. */
  const draftRecord: RegistryRecordFixture = {
    recordId: "tool-002",
    name: "Draft Tool",
    description: JSON.stringify({ name: "Draft Tool" }),
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      categories: ["general"],
      icon: "",
      state: "active",
      orgId: "test-org-a",
      config: JSON.stringify({ name: "Draft Tool" }),
      createdBy: "creator-user",
    }),
  };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      TOOLS_CONFIG_TABLE: "test-tools",
    };
    _resetRegistryService();
    jest.clearAllMocks();
    mockedIsAdmin.mockReturnValue(true);
    mockedGetUserId.mockReturnValue("admin-user-123");
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("admin approves PENDING_APPROVAL tool — updateResourceStatus called with metadata stamped", async () => {
    // First call: fetch existing; second call: re-fetch after status change
    mockGetResource.mockResolvedValueOnce(pendingRecord).mockResolvedValueOnce({
      ...pendingRecord,
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        ...JSON.parse(pendingRecord.customDescriptorContent!),
        decidedBy: "admin-user-123",
        decidedAt: expect.any(String),
        statusReason: "",
      }),
    });
    mockUpdateResource.mockResolvedValue(pendingRecord);
    mockUpdateResourceStatus.mockResolvedValue({
      ...pendingRecord,
      status: "APPROVED",
    });

    const result = await updateToolConfigRegistry(
      { toolId: "tool-001", status: "APPROVED" },
      "admin-user-123",
      adminEvent,
    );

    // updateResource called to stamp decision metadata
    expect(mockUpdateResource).toHaveBeenCalledWith("tool", "tool-001", {
      name: "My Tool",
      description: expect.any(String),
      customMetadata: expect.any(String),
    });

    // Verify decision metadata was serialized with decidedBy/decidedAt
    const metaArg = mockSerializeCustomMetadata.mock.calls[0][0];
    expect(metaArg).toMatchObject({
      decidedBy: "admin-user-123",
      decidedAt: expect.any(String),
    });

    // updateResourceStatus called with APPROVED
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
      "tool",
      "tool-001",
      "APPROVED",
      expect.any(String),
      "PENDING_APPROVAL",
    );

    expect(result.toolId).toBe("tool-001");
  });

  test("non-admin cannot approve — throws UnauthorizedError, no registry mutation calls", async () => {
    mockedIsAdmin.mockReturnValue(false);
    mockGetResource.mockResolvedValueOnce(pendingRecord);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-001", status: "APPROVED" },
        "regular-user-456",
        nonAdminEvent,
      ),
    ).rejects.toThrow(/UnauthorizedError.*admin role required.*approve/);

    expect(mockUpdateResource).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test("reject without statusReason throws ValidationError", async () => {
    mockGetResource.mockResolvedValueOnce(pendingRecord);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-001", status: "REJECTED" },
        "admin-user-123",
        adminEvent,
      ),
    ).rejects.toThrow(/ValidationError.*statusReason.*required.*reject/);

    expect(mockUpdateResource).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test("invalid transition DRAFT → APPROVED throws lifecycle error", async () => {
    mockGetResource.mockResolvedValueOnce(draftRecord);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-002", status: "APPROVED" },
        "admin-user-123",
        adminEvent,
      ),
    ).rejects.toThrow(/Invalid status transition.*DRAFT.*APPROVED/);

    expect(mockUpdateResource).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });
});
