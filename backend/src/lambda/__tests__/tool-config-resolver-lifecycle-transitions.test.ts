/**
 * Tests for explicit tool lifecycle state transitions (CIT-238).
 *
 * Validates:
 *   1. state:'active' on DRAFT → rejects with "submit it for review first"
 *   2. state:'active' on PENDING_APPROVAL → rejects (only APPROVED can toggle)
 *   3. DRAFT → PENDING_APPROVAL via input.status is allowed (explicit submit)
 *   4. APPROVED → active/maintenance toggle works
 *   5. REJECTED → state:'active' rejects with "create a new record"
 *   6. Mutation returns full ToolConfig incl. registryStatus/decidedBy/decidedAt/statusReason
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
    PENDING_APPROVAL: "active",
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

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("test-org-a"),
  isAdminFromEvent: jest.fn().mockReturnValue(true),
  assertRowOrg: jest.fn().mockResolvedValue(undefined),
  canCallerSeeRow: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("admin-user-123"),
}));

jest.mock("../../utils/tag-policy", () => ({
  normaliseTags: jest.fn((t: unknown) => t),
}));

jest.mock("../tag-policy-check", () => ({
  enforceTagPolicy: jest.fn().mockResolvedValue(undefined),
}));

describe("Tool lifecycle state transitions (CIT-238)", () => {
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

  function makeRecord(
    id: string,
    status: string,
    extraMeta: Record<string, unknown> = {},
  ): RegistryRecordFixture {
    return {
      recordId: id,
      name: `Tool ${id}`,
      description: JSON.stringify({ name: `Tool ${id}` }),
      status,
      customDescriptorContent: JSON.stringify({
        categories: ["general"],
        icon: "",
        state: "active",
        orgId: "test-org-a",
        config: JSON.stringify({ name: `Tool ${id}` }),
        createdBy: "creator-user",
        ...extraMeta,
      }),
    };
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      TOOLS_CONFIG_TABLE: "test-tools",
    };
    _resetRegistryService();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── Requirement 1: state:'active' on DRAFT → explicit rejection ────
  test("state:'active' on DRAFT tool rejects with 'submit it for review first'", async () => {
    const draft = makeRecord("tool-draft", "DRAFT");
    mockGetResource.mockResolvedValueOnce(draft);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-draft", state: "active" },
        "user-1",
        adminEvent,
      ),
    ).rejects.toThrow(/Tool is in DRAFT.*submit it for review first/);

    // Must NOT silently submit for review
    expect(mockSubmitForApproval).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  // ─── Requirement 2a: state:'active' on PENDING_APPROVAL → rejection ──
  test("state:'active' on PENDING_APPROVAL tool rejects with explicit error", async () => {
    const pending = makeRecord("tool-pending", "PENDING_APPROVAL");
    mockGetResource.mockResolvedValueOnce(pending);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-pending", state: "active" },
        "user-1",
        adminEvent,
      ),
    ).rejects.toThrow(/Tool is in PENDING_APPROVAL.*APPROVED/);

    expect(mockSubmitForApproval).not.toHaveBeenCalled();
  });

  // ─── Requirement 2b: DRAFT → PENDING_APPROVAL via explicit status ────
  test("explicit status:'PENDING_APPROVAL' from DRAFT submits for review", async () => {
    const draft = makeRecord("tool-draft", "DRAFT");
    mockGetResource
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({ ...draft, status: "PENDING_APPROVAL" });
    mockSubmitForApproval.mockResolvedValueOnce({
      ...draft,
      status: "PENDING_APPROVAL",
    });

    const result = await updateToolConfigRegistry(
      { toolId: "tool-draft", status: "PENDING_APPROVAL" },
      "user-1",
      adminEvent,
    );

    expect(mockSubmitForApproval).toHaveBeenCalledWith("tool-draft");
    expect(result.registryStatus).toBe("PENDING_APPROVAL");
  });

  // ─── Requirement 2c: APPROVED → maintenance toggle (deprecate) ────
  test("state:'maintenance' on APPROVED tool deprecates via updateResourceStatus", async () => {
    const approved = makeRecord("tool-approved", "APPROVED");
    mockGetResource
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce({ ...approved, status: "DEPRECATED" });
    mockUpdateResourceStatus.mockResolvedValueOnce({
      ...approved,
      status: "DEPRECATED",
    });
    mockUpdateResource.mockResolvedValueOnce({
      ...approved,
      status: "DEPRECATED",
    });

    const result = await updateToolConfigRegistry(
      { toolId: "tool-approved", state: "maintenance" },
      "user-1",
      adminEvent,
    );

    expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
      "tool",
      "tool-approved",
      "DEPRECATED",
      undefined,
      "APPROVED",
    );
    expect(result.registryStatus).toBe("DEPRECATED");
  });

  // ─── Requirement 2d: REJECTED → state:'active' rejects ────
  test("state:'active' on REJECTED tool rejects with 'create a new record'", async () => {
    const rejected = makeRecord("tool-rejected", "REJECTED");
    mockGetResource.mockResolvedValueOnce(rejected);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-rejected", state: "active" },
        "user-1",
        adminEvent,
      ),
    ).rejects.toThrow(
      /Rejected records cannot be resubmitted.*create a new record/,
    );

    expect(mockSubmitForApproval).not.toHaveBeenCalled();
  });

  // ─── Requirement 2e: state:'inactive' still rejects (existing behavior) ──
  test("state:'inactive' on registry record rejects with Deprecate hint", async () => {
    const approved = makeRecord("tool-approved", "APPROVED");
    mockGetResource.mockResolvedValueOnce(approved);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-approved", state: "inactive" },
        "user-1",
        adminEvent,
      ),
    ).rejects.toThrow(/Deactivation is not supported.*Deprecate/);
  });

  // ─── Requirement 2f: invalid status transition names current + allowed ──
  test("invalid explicit status transition names current status and allowed transitions", async () => {
    const draft = makeRecord("tool-draft", "DRAFT");
    mockGetResource.mockResolvedValueOnce(draft);

    await expect(
      updateToolConfigRegistry(
        { toolId: "tool-draft", status: "APPROVED" },
        "admin-user-123",
        adminEvent,
      ),
    ).rejects.toThrow(/Invalid status transition.*DRAFT.*APPROVED/);
  });

  // ─── Requirement 3: mutation returns full ToolConfig with lifecycle fields ──
  test("mutation response includes registryStatus, decidedBy, decidedAt, statusReason", async () => {
    const approvedMeta = {
      decidedBy: "admin-user-123",
      decidedAt: "2026-10-13T09:00:00.000Z",
      statusReason: null,
    };
    const approved = makeRecord("tool-approved", "APPROVED", approvedMeta);

    // Content-only edit on APPROVED record (no state/status change)
    mockGetResource.mockResolvedValueOnce(approved);
    mockUpdateResource.mockResolvedValueOnce(approved);

    const result = await updateToolConfigRegistry(
      { toolId: "tool-approved", config: '{"name":"Updated Tool"}' },
      "user-1",
      adminEvent,
    );

    expect(result).toHaveProperty("registryStatus");
    expect(result).toHaveProperty("decidedBy");
    expect(result).toHaveProperty("decidedAt");
    expect(result).toHaveProperty("statusReason");
    expect(result.decidedBy).toBe("admin-user-123");
    expect(result.decidedAt).toBe("2026-10-13T09:00:00.000Z");
  });
});
