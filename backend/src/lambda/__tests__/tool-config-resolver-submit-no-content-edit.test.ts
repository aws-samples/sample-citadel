/**
 * Tests that submitting a tool for review (DRAFT → PENDING_APPROVAL) does not
 * issue a spurious UpdateRegistryRecord when the request carries no content
 * fields, and correctly writes content BEFORE submit when content is present.
 *
 * Validates:
 *   1. Status-only submit → exactly one registry mutation
 *      (SubmitRegistryRecordForApproval), no UpdateRegistryRecord, returned
 *      registryStatus PENDING_APPROVAL.
 *   2. Content + submit → UpdateRegistryRecord first, then
 *      SubmitRegistryRecordForApproval.
 *   3. Content edit on an APPROVED record still demotes to DRAFT (existing
 *      behaviour preserved).
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

describe("Tool submit-for-review: no spurious content edit", () => {
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

  // ─── 1. Status-only submit: no UpdateRegistryRecord ────────────────
  test("status-only submit issues SubmitForApproval and no UpdateRegistryRecord", async () => {
    const draft = makeRecord("tool-draft", "DRAFT");
    const pending = { ...draft, status: "PENDING_APPROVAL" };
    mockGetResource
      .mockResolvedValueOnce(draft) // initial fetch
      .mockResolvedValueOnce(pending); // re-fetch after submit
    mockSubmitForApproval.mockResolvedValueOnce(pending);

    const result = await updateToolConfigRegistry(
      { toolId: "tool-draft", status: "PENDING_APPROVAL" },
      "user-1",
      adminEvent,
    );

    // Exactly one registry mutation: submitForApproval
    expect(mockSubmitForApproval).toHaveBeenCalledTimes(1);
    expect(mockSubmitForApproval).toHaveBeenCalledWith("tool-draft");

    // No content write (UpdateRegistryRecord)
    expect(mockUpdateResource).not.toHaveBeenCalled();

    // No status transition via updateResourceStatus
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();

    // Returned status is PENDING_APPROVAL
    expect(result.registryStatus).toBe("PENDING_APPROVAL");
  });

  // ─── 2. Content + submit: update THEN submit ──────────────────────
  test("content + submit writes content first then submits", async () => {
    const draft = makeRecord("tool-draft", "DRAFT");
    const updatedDraft = { ...draft, description: '{"name":"Updated Tool"}' };
    const pending = { ...updatedDraft, status: "PENDING_APPROVAL" };
    mockGetResource
      .mockResolvedValueOnce(draft) // initial fetch
      .mockResolvedValueOnce(pending); // re-fetch after submit
    mockUpdateResource.mockResolvedValueOnce(updatedDraft);
    mockSubmitForApproval.mockResolvedValueOnce(pending);

    const result = await updateToolConfigRegistry(
      {
        toolId: "tool-draft",
        status: "PENDING_APPROVAL",
        config: '{"name":"Updated Tool"}',
      },
      "user-1",
      adminEvent,
    );

    // Content write happened first
    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    expect(mockSubmitForApproval).toHaveBeenCalledTimes(1);

    // Verify ordering: updateResource was called before submitForApproval
    const updateOrder = mockUpdateResource.mock.invocationCallOrder[0];
    const submitOrder = mockSubmitForApproval.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(submitOrder);

    // Returned status is PENDING_APPROVAL
    expect(result.registryStatus).toBe("PENDING_APPROVAL");
  });

  // ─── 3. Content edit on APPROVED record still demotes ─────────────
  test("content edit on APPROVED record demotes to DRAFT (existing behaviour)", async () => {
    const approved = makeRecord("tool-approved", "APPROVED");
    const demoted = { ...approved, status: "DRAFT" };
    mockGetResource.mockResolvedValueOnce(approved);
    mockUpdateResource.mockResolvedValueOnce(demoted);

    const infoSpy = jest.spyOn(console, "info").mockImplementation();

    const result = await updateToolConfigRegistry(
      { toolId: "tool-approved", config: '{"name":"Changed"}' },
      "user-1",
      adminEvent,
    );

    // updateResource was called (content edit)
    expect(mockUpdateResource).toHaveBeenCalledTimes(1);

    // No submit — this was a content-only edit
    expect(mockSubmitForApproval).not.toHaveBeenCalled();

    // The returned status reflects the demotion
    expect(result.registryStatus).toBe("DRAFT");

    // The demotion was logged
    expect(infoSpy).toHaveBeenCalledWith(
      "approval invalidated by content edit",
      expect.stringContaining("tool-approved"),
    );

    infoSpy.mockRestore();
  });
});
