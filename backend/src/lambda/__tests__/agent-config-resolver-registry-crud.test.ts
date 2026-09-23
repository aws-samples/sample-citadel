/**
 * Tests for Registry-backed CRUD functions in agent-config-resolver (task 6.4)
 *
 * Validates: Requirements 3.3, 3.4, 3.5, 3.7, 12.1, 12.2
 */
import {
  createAgentConfigRegistry,
  updateAgentConfigRegistry,
  deleteAgentConfigRegistry,
  publishAgentManifestRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------

const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockDeleteResource = jest.fn();
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
  // Decision 3d5843e9 (supersedes a3fb5542; finding 462c17ad): the AWS
  // registry rejects DRAFT as an UpdateRegistryRecordStatus target.
  // 'inactive' now throws in the real toRegistryStatus (see
  // registry-service.ts) — the resolver intercepts it even earlier with a
  // structured error before this mock would ever be reached in practice.
  // 'maintenance' is repurposed as the deprecate-intent value -> DEPRECATED.
  const map: Record<string, string> = {
    active: "APPROVED",
    maintenance: "DEPRECATED",
  };
  return map[state] || "DEPRECATED";
});

/** Registry record fixture shape consumed by the mock mapper. */
interface RegistryRecordFixture {
  recordId: string;
  name?: string;
  description?: string;
  status?: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const mockMapToAgentConfig = jest.fn((record: RegistryRecordFixture) => {
  // Mirror the real mapper's orgId projection so the new tenancy gate
  // (finding 1fcfd11e) — which reads mapToAgentConfig(...).orgId — sees the
  // same orgId these fixtures carry in customDescriptorContent.
  const meta = record.customDescriptorContent
    ? (() => {
        try {
          return JSON.parse(record.customDescriptorContent!);
        } catch {
          return {};
        }
      })()
    : {};
  return {
    agentId: record.recordId,
    orgId: typeof meta.orgId === "string" ? meta.orgId : undefined,
    config: record.description || "",
    state: "active",
    categories: [],
    createdAt: record.createdAt?.toISOString?.() ?? record.createdAt,
    updatedAt: record.updatedAt?.toISOString?.() ?? record.updatedAt,
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => "test-registry",
    createResource: mockCreateResource,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    deleteResource: mockDeleteResource,
    updateResourceStatus: mockUpdateResourceStatus,
    submitForApproval: mockSubmitForApproval,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
  // The activation gate (US-IMP) guards on RegistryRecordStatusValues.APPROVED;
  // the real registry-service exports these enum values, so the test double
  // must export them too (mirrors agent-config-resolver.test.ts).
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

describe("Registry-backed CRUD functions (task 6.4)", () => {
  const originalEnv = process.env;
  // Fixture identity that carries a tenant claim the same way AppSync
  // delivers it in production. Tests pass this to the registry-path
  // functions as the second arg so extractOrgFromEvent resolves without
  // falling back to Cognito.
  const eventWithOrg = {
    identity: { claims: { "custom:organization": "test-org-a" } },
  };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      AGENT_CONFIG_TABLE: "test-agents",
    };
    _resetRegistryService();
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ─── createAgentConfigRegistry ──────────────────────────────

  describe("createAgentConfigRegistry", () => {
    const baseRecord = {
      recordId: "agent-1",
      name: "TestAgent",
      description: '{"name":"TestAgent"}',
      status: "DRAFT",
      customDescriptorContent: "{}",
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
    };

    test("creates a Registry resource with serialized custom metadata", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);
      mockGetResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: '{"name":"TestAgent"}',
          state: "active",
          categories: ["cat1"],
          icon: "icon.png",
        },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith({
        categories: ["cat1"],
        icon: "icon.png",
        state: "active",
        appId: undefined,
        orgId: "test-org-a",
      });
      expect(mockCreateResource).toHaveBeenCalledWith("agent", "agent-1", {
        name: "TestAgent",
        description: '{"name":"TestAgent"}',
        customMetadata: expect.any(String),
      });
    });

    test("updates status when initial state is provided", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);
      mockGetResource.mockResolvedValue(baseRecord);
      mockSubmitForApproval.mockResolvedValue({
        ...baseRecord,
        status: "APPROVED",
      });

      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: '{"name":"TestAgent"}',
          state: "active",
        },
        eventWithOrg,
      );

      expect(mockToRegistryStatus).toHaveBeenCalledWith("active");
      // Activation must go through SubmitRegistryRecordForApproval, never a
      // direct UpdateRegistryRecordStatus(APPROVED) — finding adde5b79.
      expect(mockSubmitForApproval).toHaveBeenCalledWith("agent-1");
      expect(mockUpdateResourceStatus).not.toHaveBeenCalledWith(
        "agent",
        "agent-1",
        "APPROVED",
      );
    });

    test("returns mapped AgentConfig", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      const result = await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: '{"name":"TestAgent"}',
        },
        eventWithOrg,
      );

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(baseRecord);
      expect(result.agentId).toBe("agent-1");
    });

    test("handles object config input by stringifying", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: { name: "TestAgent" },
        },
        eventWithOrg,
      );

      expect(mockCreateResource).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        expect.objectContaining({
          description: '{"name":"TestAgent"}',
        }),
      );
    });

    test("defaults categories to empty array and icon to empty string", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: '{"name":"TestAgent"}',
        },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          categories: [],
          icon: "",
          state: "active",
        }),
      );
    });

    test("passes appId when provided", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: '{"name":"TestAgent"}',
          appId: "app-123",
        },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "app-123",
        }),
      );
    });

    // ── D1(a): orgId captured from JWT, not from input ─────────────────
    test("captures orgId from the JWT claim and stores it in customMetadata", async () => {
      mockCreateResource.mockResolvedValue(baseRecord);

      await createAgentConfigRegistry(
        { agentId: "agent-1", config: '{"name":"TestAgent"}' },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "test-org-a" }),
      );
    });

    test("throws when caller has no organization claim and no Cognito fallback", async () => {
      // No identity → extractOrgFromEvent returns null → we must refuse to
      // create a tenant-owned record without a tenant.
      await expect(
        createAgentConfigRegistry(
          { agentId: "agent-1", config: '{"name":"TestAgent"}' },
          {},
        ),
      ).rejects.toThrow("Cannot determine caller organization");
      expect(mockCreateResource).not.toHaveBeenCalled();
    });
  });

  // ─── updateAgentConfigRegistry ──────────────────────────────

  describe("updateAgentConfigRegistry", () => {
    const existingRecord = {
      recordId: "agent-1",
      name: "ExistingAgent",
      description: '{"name":"ExistingAgent"}',
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: ["old-cat"],
        icon: "old-icon.png",
        state: "active",
      }),
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
    };

    const updatedRecord = {
      ...existingRecord,
      updatedAt: new Date("2025-01-02"),
    };

    test("throws when agent not found in Registry", async () => {
      mockGetResource.mockResolvedValue(null);

      await expect(
        updateAgentConfigRegistry({ agentId: "missing" }, eventWithOrg),
      ).rejects.toThrow("Agent config not found: missing");
    });

    test("updates resource with merged metadata", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          categories: ["new-cat"],
        },
        eventWithOrg,
      );

      expect(mockUpdateResource).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        expect.objectContaining({
          customMetadata: expect.any(String),
        }),
      );
    });

    test("updates Registry status when state changes", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          state: "maintenance",
        },
        eventWithOrg,
      );

      expect(mockToRegistryStatus).toHaveBeenCalledWith("maintenance");
      // Decision 3d5843e9 (finding 462c17ad): deprecate intent
      // (state:"maintenance") issues DEPRECATED, routed through the
      // validated-transition gate — existing.status ("APPROVED") is passed
      // as currentStatus.
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        "DEPRECATED",
        undefined,
        "APPROVED",
      );
    });

    test("does not update status when state is unchanged", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          categories: ["new-cat"],
        },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test("Deactivate ('inactive') on a registry-backed record is rejected with a structured error, no SDK call (decision 3d5843e9, finding 462c17ad)", async () => {
      const draftExistingRecord = { ...existingRecord, status: "DRAFT" };
      mockGetResource.mockResolvedValue(draftExistingRecord);

      await expect(
        updateAgentConfigRegistry(
          {
            agentId: "agent-1",
            state: "inactive",
          },
          eventWithOrg,
        ),
      ).rejects.toThrow(
        "ValidationError: Deactivation is not supported for registry records; use Deprecate (irreversible)",
      );

      // The registry rejects DRAFT as an UpdateRegistryRecordStatus target
      // (finding 462c17ad) — the resolver must fail BEFORE any SDK call,
      // not attempt the write and let it fail downstream.
      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("deprecate intent (state: 'maintenance') on an APPROVED record maps to DEPRECATED via the validated gate", async () => {
      mockGetResource.mockResolvedValue(existingRecord); // status: APPROVED
      mockUpdateResourceStatus.mockResolvedValue({
        recordId: "agent-1",
        status: "DEPRECATED",
      });
      mockUpdateResource.mockResolvedValue({
        ...updatedRecord,
        status: "DEPRECATED",
      });

      await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          state: "maintenance",
        },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        "DEPRECATED",
        undefined,
        "APPROVED",
      );
    });

    test("preserves existing config when no new config provided", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          state: "maintenance",
        },
        eventWithOrg,
      );

      expect(mockUpdateResource).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        expect.objectContaining({
          description: '{"name":"ExistingAgent"}',
        }),
      );
    });

    test("returns mapped AgentConfig", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      const result = await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          state: "maintenance",
        },
        eventWithOrg,
      );

      // After the state-change refetch, mapToAgentConfig is called with the
      // record returned by the second getResource call (here existingRecord).
      expect(mockMapToAgentConfig).toHaveBeenCalledWith(existingRecord);
      expect(result.agentId).toBe("agent-1");
    });

    // ── Phase-2a (superseded by finding 1fcfd11e): a caller from a DIFFERENT
    // org than the existing record's orgId is now REJECTED before any
    // mutation, rather than silently allowed through while the record's
    // original orgId was merely preserved. The preservation behaviour itself
    // (never deriving orgId from input) is still covered below for a
    // same-org caller.
    test("rejects a caller whose org differs from the EXISTING record orgId (finding 1fcfd11e)", async () => {
      const recordWithOrg = {
        ...existingRecord,
        customDescriptorContent: JSON.stringify({
          categories: ["c"],
          icon: "",
          state: "active",
          orgId: "original-owner-org",
        }),
      };
      mockGetResource.mockResolvedValue(recordWithOrg);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await expect(
        updateAgentConfigRegistry(
          { agentId: "agent-1", categories: ["new-cat"] },
          {
            identity: {
              claims: { "custom:organization": "different-caller-org" },
            },
          },
        ),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("preserves existingMeta.orgId on update for a SAME-org caller (never replaces it with caller org)", async () => {
      const recordWithOrg = {
        ...existingRecord,
        customDescriptorContent: JSON.stringify({
          categories: ["c"],
          icon: "",
          state: "active",
          orgId: "original-owner-org",
        }),
      };
      mockGetResource.mockResolvedValue(recordWithOrg);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        { agentId: "agent-1", categories: ["new-cat"] },
        {
          identity: { claims: { "custom:organization": "original-owner-org" } },
        },
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "original-owner-org" }),
      );
    });

    test("falls back to caller JWT org when legacy record is missing orgId", async () => {
      // existingRecord has no orgId in customDescriptorContent → legacy path.
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      await updateAgentConfigRegistry(
        { agentId: "agent-1", categories: ["new-cat"] },
        eventWithOrg,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "test-org-a" }),
      );
    });

    test("when input.state changes, re-fetches the record after updateResourceStatus and returns the post-transition state", async () => {
      const draftRecord = {
        recordId: "agent-1",
        name: "ExistingAgent",
        description: '{"name":"ExistingAgent"}',
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({
          state: "inactive",
          manifest: {},
        }),
      };
      const pendingRecord = {
        recordId: "agent-1",
        name: "ExistingAgent",
        description: '{"name":"ExistingAgent"}',
        status: "PENDING_APPROVAL",
        customDescriptorContent: JSON.stringify({
          state: "active",
          manifest: {},
        }),
      };

      // 1st getResource call → DRAFT (existing), 2nd call (refetch) → PENDING_APPROVAL
      mockGetResource
        .mockResolvedValueOnce(draftRecord)
        .mockResolvedValueOnce(pendingRecord);
      // updateResource returns the stale DRAFT record — simulating the bug
      mockUpdateResource.mockResolvedValue(draftRecord);
      mockUpdateResourceStatus.mockResolvedValue(undefined);
      mockSubmitForApproval.mockResolvedValue(pendingRecord);

      // Stub mapToAgentConfig to map status → state using the same logic as
      // the real implementation for the statuses this test exercises.
      // mockImplementationOnce (not mockImplementation): jest.clearAllMocks()
      // in this file's beforeEach clears call history but NOT a permanent
      // mockImplementation override, so a bare .mockImplementation() here
      // would silently leak into every later test in the file (it did —
      // this override drops `orgId`, which the tenancy gate added for
      // finding 1fcfd11e now depends on).
      mockMapToAgentConfig.mockImplementationOnce(
        (record: RegistryRecordFixture) => ({
          agentId: record.recordId,
          config: record.description || "",
          state:
            record.status === "PENDING_APPROVAL" || record.status === "APPROVED"
              ? "active"
              : record.status === "DRAFT"
                ? "maintenance"
                : "inactive",
          categories: [],
        }),
      );

      const result = await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          state: "active",
        },
        eventWithOrg,
      );

      // Activation must go through SubmitRegistryRecordForApproval, never a
      // direct UpdateRegistryRecordStatus(APPROVED) — finding adde5b79.
      expect(mockSubmitForApproval).toHaveBeenCalledWith("agent-1");
      expect(mockUpdateResourceStatus).not.toHaveBeenCalledWith(
        "agent",
        "agent-1",
        "APPROVED",
      );
      expect(mockGetResource).toHaveBeenCalledTimes(2);
      expect(mockMapToAgentConfig).toHaveBeenLastCalledWith(pendingRecord);
      expect(result.state).toBe("active");
    });

    test("when input.state is unchanged, does not call updateResourceStatus and does not refetch", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(updatedRecord);

      const result = await updateAgentConfigRegistry(
        {
          agentId: "agent-1",
          // existingRecord.customDescriptorContent state is 'active'
          state: "active",
        },
        eventWithOrg,
      );

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      // Only the initial pre-mutation fetch; no refetch.
      expect(mockGetResource).toHaveBeenCalledTimes(1);
      // Returns the record from updateResource, not a refetched one.
      expect(mockMapToAgentConfig).toHaveBeenCalledWith(updatedRecord);
      expect(result.agentId).toBe("agent-1");
    });

    // ─── finding adde5b79: submit-not-approve activation ─────────────

    test("DRAFT + active → submits for approval, never issues a direct UpdateRegistryRecordStatus(APPROVED)", async () => {
      const draftRecord = { ...existingRecord, status: "DRAFT" };
      mockGetResource
        .mockResolvedValueOnce(draftRecord)
        .mockResolvedValueOnce({ ...draftRecord, status: "PENDING_APPROVAL" });
      mockUpdateResource.mockResolvedValue(draftRecord);
      mockSubmitForApproval.mockResolvedValue({
        ...draftRecord,
        status: "PENDING_APPROVAL",
      });

      await updateAgentConfigRegistry(
        { agentId: "agent-1", state: "active" },
        eventWithOrg,
      );

      expect(mockSubmitForApproval).toHaveBeenCalledWith("agent-1");
      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
    });

    test("REJECTED + active → structured error, no DRAFT call, no submit (decision 3d5843e9, finding 462c17ad)", async () => {
      const rejectedRecord = { ...existingRecord, status: "REJECTED" };
      mockGetResource.mockResolvedValue(rejectedRecord);

      await expect(
        updateAgentConfigRegistry(
          { agentId: "agent-1", state: "active" },
          eventWithOrg,
        ),
      ).rejects.toThrow(
        "ValidationError: Rejected records cannot be resubmitted; create a new record",
      );

      // The removed #182 resubmit step (REJECTED -> DRAFT) always failed at
      // the registry call (finding 462c17ad) — assert it's gone, not just
      // reordered.
      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(mockSubmitForApproval).not.toHaveBeenCalled();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("metadata is left untouched when submitForApproval fails (no partial drift)", async () => {
      const draftRecord = { ...existingRecord, status: "DRAFT" };
      mockGetResource.mockResolvedValue(draftRecord);
      mockSubmitForApproval.mockRejectedValue(new Error("submit failed"));

      await expect(
        updateAgentConfigRegistry(
          { agentId: "agent-1", state: "active" },
          eventWithOrg,
        ),
      ).rejects.toThrow("submit failed");

      // The status transition ran and failed BEFORE any metadata write.
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });
  });

  // ─── deleteAgentConfigRegistry ──────────────────────────────

  describe("deleteAgentConfigRegistry", () => {
    // finding 1fcfd11e: delete now fetches the record, reconciles its org
    // against the caller, and additionally requires admin/architect (decision
    // 31ee5b5d) — before any deleteResource call.
    const architectEvent = {
      identity: {
        claims: {
          "custom:organization": "test-org-a",
          "custom:role": "architect",
        },
      },
    };
    const existingRecord = {
      recordId: "agent-1",
      name: "TestAgent",
      description: '{"name":"TestAgent"}',
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: "",
        state: "active",
        orgId: "test-org-a",
      }),
    };

    test("returns success on successful delete", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await deleteAgentConfigRegistry("agent-1", architectEvent);

      expect(mockDeleteResource).toHaveBeenCalledWith("agent", "agent-1");
      expect(result.success).toBe(true);
      expect(result.message).toContain("agent-1");
    });

    test("returns failure when delete throws", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockDeleteResource.mockRejectedValue(new Error("Registry error"));

      const result = await deleteAgentConfigRegistry("agent-1", architectEvent);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed");
    });

    test("returns failure when caller lacks admin/architect role, and never deletes", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      const nonArchitectEvent = {
        identity: { claims: { "custom:organization": "test-org-a" } },
      };

      const result = await deleteAgentConfigRegistry(
        "agent-1",
        nonArchitectEvent,
      );

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    test("returns failure when caller org differs from the existing record org, and never deletes", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      const crossOrgEvent = {
        identity: {
          claims: {
            "custom:organization": "other-org",
            "custom:role": "architect",
          },
        },
      };

      const result = await deleteAgentConfigRegistry("agent-1", crossOrgEvent);

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  // ─── publishAgentManifestRegistry ───────────────────────────

  describe("publishAgentManifestRegistry", () => {
    // finding 1fcfd11e: publish now fetches the record, reconciles its org
    // against the caller, and additionally requires admin/architect (decision
    // 31ee5b5d) — before any updateResource call.
    const architectEvent = {
      identity: {
        claims: {
          "custom:organization": "test-org-a",
          "custom:role": "architect",
        },
      },
    };
    const existingRecord = {
      recordId: "agent-1",
      name: "TestAgent",
      description: '{"name":"TestAgent"}',
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        categories: ["cat1"],
        icon: "icon.png",
        state: "active",
        orgId: "test-org-a",
      }),
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
    };

    const validManifest = {
      name: "Test Agent",
      description: "A test agent",
      version: "1.0.0",
    };

    test("throws on invalid JSON manifest", async () => {
      await expect(
        publishAgentManifestRegistry("agent-1", "not-json", architectEvent),
      ).rejects.toThrow("Invalid manifest JSON");
    });

    test("throws on manifest missing required fields", async () => {
      await expect(
        publishAgentManifestRegistry(
          "agent-1",
          JSON.stringify({ name: "Agent" }),
          architectEvent,
        ),
      ).rejects.toThrow("Manifest validation failed");
    });

    test("throws when agent not found in Registry", async () => {
      mockGetResource.mockResolvedValue(null);

      await expect(
        publishAgentManifestRegistry(
          "agent-1",
          JSON.stringify(validManifest),
          architectEvent,
        ),
      ).rejects.toThrow("Agent config not found");
    });

    test("updates custom metadata with new manifest", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(existingRecord);

      await publishAgentManifestRegistry(
        "agent-1",
        JSON.stringify(validManifest),
        architectEvent,
      );

      expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ manifest: validManifest }),
      );
      expect(mockUpdateResource).toHaveBeenCalledWith(
        "agent",
        "agent-1",
        expect.objectContaining({
          customMetadata: expect.any(String),
          description: existingRecord.description,
        }),
      );
    });

    test("returns mapped AgentConfig", async () => {
      mockGetResource.mockResolvedValue(existingRecord);
      mockUpdateResource.mockResolvedValue(existingRecord);

      const result = await publishAgentManifestRegistry(
        "agent-1",
        JSON.stringify(validManifest),
        architectEvent,
      );

      expect(mockMapToAgentConfig).toHaveBeenCalledWith(existingRecord);
      expect(result.agentId).toBe("agent-1");
    });
  });
});
