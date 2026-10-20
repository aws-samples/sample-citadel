/**
 * Tests for tool record approval/rejection decision logic in
 * updateToolConfigRegistry (CIT-215).
 *
 * The registry fake models real AWS registry behaviour:
 *   - updateResource on a non-DRAFT record demotes it to DRAFT (content-edit rule)
 *   - updateResourceStatus validates transitions (PENDING_APPROVAL→APPROVED ok,
 *     DRAFT→APPROVED rejected)
 *
 * Scenarios:
 *   1. Admin approves PENDING_APPROVAL → ONLY updateResourceStatus, NO updateResource
 *   2. Admin rejects PENDING_APPROVAL → same pattern, statusReason required
 *   3. Non-admin → UnauthorizedError, no registry calls
 *   4. Reject without statusReason → ValidationError
 *   5. Invalid transition (e.g. DRAFT → APPROVED) → RegistryLifecycleError
 *   6. Submit → approve end-to-end succeeds
 *   7. decidedBy/decidedAt surfaced in getToolConfig
 */
import {
  updateToolConfigRegistry,
  getToolConfigRegistry,
  _resetRegistryService,
} from "../tool-config-resolver";

// ---------------------------------------------------------------------------
// Stateful registry fake that models real AWS behaviour
// ---------------------------------------------------------------------------

/** In-memory registry record store. */
const registryStore = new Map<
  string,
  {
    recordId: string;
    name: string;
    description?: string;
    status: string;
    customDescriptorContent?: string;
    createdAt?: Date;
    updatedAt?: Date;
  }
>();

/** Valid transitions matching REGISTRY_TRANSITIONS in lifecycle.ts. */
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["DEPRECATED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["DEPRECATED"],
  REJECTED: ["DEPRECATED"],
};

const mockGetResource = jest.fn(
  async (_type: string, id: string) => registryStore.get(id) ?? null,
);

/**
 * updateResource: the real AWS registry demotes any non-DRAFT record to
 * DRAFT when content is written (UpdateRegistryRecord = content edit).
 */
const mockUpdateResource = jest.fn(
  async (
    _type: string,
    id: string,
    payload: { name?: string; description?: string; customMetadata?: string },
  ) => {
    const existing = registryStore.get(id);
    if (!existing) throw new Error(`Record not found: ${id}`);
    const demote = existing.status !== "DRAFT";
    const updated = {
      ...existing,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      ...(payload.customMetadata !== undefined
        ? { customDescriptorContent: payload.customMetadata }
        : {}),
      status: demote ? "DRAFT" : existing.status,
      updatedAt: new Date(),
    };
    registryStore.set(id, updated);
    return updated;
  },
);

/**
 * updateResourceStatus: validates transitions like the real API.
 */
const mockUpdateResourceStatus = jest.fn(
  async (
    _type: string,
    id: string,
    status: string,
    _reason?: string,
    currentStatus?: string,
  ) => {
    const existing = registryStore.get(id);
    if (!existing) throw new Error(`Record not found: ${id}`);
    const fromStatus = currentStatus ?? existing.status;
    const allowed = VALID_TRANSITIONS[fromStatus] ?? [];
    if (fromStatus !== status && !allowed.includes(status)) {
      throw Object.assign(
        new Error(
          `Invalid status transition: ${fromStatus} → ${status}. Valid transitions from ${fromStatus}: ${allowed.join(", ") || "none"}`,
        ),
        { name: "RegistryLifecycleError", code: "INVALID_TRANSITION" },
      );
    }
    const updated = { ...existing, status, updatedAt: new Date() };
    registryStore.set(id, updated);
    return updated;
  },
);

const mockSubmitForApproval = jest.fn(async (id: string) => {
  const existing = registryStore.get(id);
  if (!existing) throw new Error(`Record not found: ${id}`);
  const updated = {
    ...existing,
    status: "PENDING_APPROVAL",
    updatedAt: new Date(),
  };
  registryStore.set(id, updated);
  return updated;
});

const mockCreateResource = jest.fn(
  async (
    _type: string,
    _id: string,
    payload: { name: string; description?: string; customMetadata?: string },
  ) => {
    const recordId = _id.substring(0, 12).padEnd(12, "0");
    const record = {
      recordId,
      name: payload.name,
      description: payload.description,
      status: "DRAFT",
      customDescriptorContent: payload.customMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    registryStore.set(recordId, record);
    return record;
  },
);

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
    createResource: mockCreateResource,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    deleteResource: jest.fn(),
    listResources: jest.fn().mockResolvedValue([]),
    updateResourceStatus: mockUpdateResourceStatus,
    submitForApproval: mockSubmitForApproval,
    searchResources: jest.fn().mockResolvedValue([]),
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
  decideRecord: jest.requireActual("../../services/registry-service")
    .decideRecord,
  DECISION_STATUSES: jest.requireActual("../../services/registry-service")
    .DECISION_STATUSES,
}));

// Mock DynamoDB — used for decision record persistence
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
const dynamoMock = mockClient(DynamoDBDocumentClient);

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
    registryStore.clear();
    jest.clearAllMocks();
    dynamoMock.reset();
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({});
    mockedIsAdmin.mockReturnValue(true);
    mockedGetUserId.mockReturnValue("admin-user-123");
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("admin approves PENDING_APPROVAL tool — updateResource NOT called, only updateResourceStatus", async () => {
    // Seed the stateful registry with a PENDING_APPROVAL record
    registryStore.set("tool-001", { ...pendingRecord });

    const result = await updateToolConfigRegistry(
      { toolId: "tool-001", status: "APPROVED" },
      "admin-user-123",
      adminEvent,
    );

    // updateResource must NOT be called — writing metadata to a
    // PENDING_APPROVAL record demotes it to DRAFT, breaking the approval.
    expect(mockUpdateResource).not.toHaveBeenCalled();

    // updateResourceStatus called with APPROVED
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
      "tool",
      "tool-001",
      "APPROVED",
      expect.any(String),
      "PENDING_APPROVAL",
    );

    // The returned config has decision fields overlaid
    expect(result.decidedBy).toBe("admin-user-123");
    expect(result.decidedAt).toBeDefined();
    expect(result.toolId).toBe("tool-001");

    // DynamoDB decision record was written
    const putCalls = dynamoMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const decisionPut = putCalls.find(
      (c) => c.args[0].input.Item?.toolId === "decision#tool-001",
    );
    expect(decisionPut).toBeDefined();
    expect(decisionPut!.args[0].input.Item?.decidedBy).toBe("admin-user-123");
  });

  test("admin rejects PENDING_APPROVAL tool — updateResource NOT called, statusReason persisted", async () => {
    registryStore.set("tool-001", { ...pendingRecord });

    const result = await updateToolConfigRegistry(
      {
        toolId: "tool-001",
        status: "REJECTED",
        statusReason: "Policy violation",
      },
      "admin-user-123",
      adminEvent,
    );

    expect(mockUpdateResource).not.toHaveBeenCalled();

    expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
      "tool",
      "tool-001",
      "REJECTED",
      "Policy violation",
      "PENDING_APPROVAL",
    );

    expect(result.decidedBy).toBe("admin-user-123");
    expect(result.statusReason).toBe("Policy violation");

    // DynamoDB decision record has statusReason
    const putCalls = dynamoMock.commandCalls(PutCommand);
    const decisionPut = putCalls.find(
      (c) => c.args[0].input.Item?.toolId === "decision#tool-001",
    );
    expect(decisionPut!.args[0].input.Item?.statusReason).toBe(
      "Policy violation",
    );
  });

  test("non-admin cannot approve — throws UnauthorizedError, no registry mutation calls", async () => {
    mockedIsAdmin.mockReturnValue(false);
    registryStore.set("tool-001", { ...pendingRecord });

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
    registryStore.set("tool-001", { ...pendingRecord });

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
    registryStore.set("tool-002", { ...draftRecord });

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

  test("registry fake: updateResource on non-DRAFT record demotes to DRAFT", async () => {
    registryStore.set("tool-001", { ...pendingRecord });

    await mockUpdateResource("tool", "tool-001", { name: "Updated" });

    const record = registryStore.get("tool-001");
    expect(record!.status).toBe("DRAFT");
  });

  test("registry fake: updateResourceStatus rejects DRAFT→APPROVED", async () => {
    registryStore.set("tool-002", { ...draftRecord });

    await expect(
      mockUpdateResourceStatus(
        "tool",
        "tool-002",
        "APPROVED",
        "reason",
        "DRAFT",
      ),
    ).rejects.toThrow(/Invalid status transition.*DRAFT.*APPROVED/);
  });

  test("submit → approve succeeds end to end", async () => {
    // Start with a DRAFT record
    registryStore.set("tool-002", { ...draftRecord });

    // Submit for approval (DRAFT → PENDING_APPROVAL)
    await updateToolConfigRegistry(
      { toolId: "tool-002", status: "PENDING_APPROVAL" },
      "creator-user",
      adminEvent,
    );

    expect(mockSubmitForApproval).toHaveBeenCalledWith("tool-002");
    const afterSubmit = registryStore.get("tool-002");
    expect(afterSubmit!.status).toBe("PENDING_APPROVAL");

    // Clear mocks for the approve step
    jest.clearAllMocks();
    dynamoMock.reset();
    dynamoMock.on(PutCommand).resolves({});
    dynamoMock.on(GetCommand).resolves({});

    // Approve (PENDING_APPROVAL → APPROVED)
    const result = await updateToolConfigRegistry(
      { toolId: "tool-002", status: "APPROVED" },
      "admin-user-123",
      adminEvent,
    );

    expect(mockUpdateResource).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
      "tool",
      "tool-002",
      "APPROVED",
      expect.any(String),
      "PENDING_APPROVAL",
    );
    const afterApprove = registryStore.get("tool-002");
    expect(afterApprove!.status).toBe("APPROVED");
    expect(result.decidedBy).toBe("admin-user-123");
    expect(result.decidedAt).toBeDefined();
  });

  test("decidedBy/decidedAt surfaced in getToolConfig via DynamoDB decision record", async () => {
    // Seed a registry record that has been approved
    registryStore.set("tool-001", {
      ...pendingRecord,
      status: "APPROVED",
    });

    // Reset and configure DynamoDB mock for this test specifically
    dynamoMock.reset();
    dynamoMock.on(PutCommand).resolves({});
    // Default GetCommand returns empty (no item)
    dynamoMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.toolId === "decision#tool-001") {
        return {
          Item: {
            toolId: "decision#tool-001",
            decidedBy: "admin-user-123",
            decidedAt: "2026-01-15T10:00:00.000Z",
            statusReason: "Looks good",
            status: "APPROVED",
          },
        };
      }
      return {};
    });

    const result = await getToolConfigRegistry("tool-001", adminEvent);

    expect(result).not.toBeNull();
    expect(result!.decidedBy).toBe("admin-user-123");
    expect(result!.decidedAt).toBe("2026-01-15T10:00:00.000Z");
    expect(result!.statusReason).toBe("Looks good");
  });
});
