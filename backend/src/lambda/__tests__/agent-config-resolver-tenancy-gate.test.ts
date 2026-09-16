/**
 * Tenancy + role-gate tests for the five agent-config-resolver Registry-path
 * ops named in finding 1fcfd11e:
 *
 *   deleteAgentConfigRegistry(agentId, event)
 *   publishAgentManifestRegistry(agentId, manifestStr, event)
 *   activateProjectAgents(projectId) — gated at the DISPATCH call site via
 *     assertProjectOrgAccess(projectId, event) BEFORE the (deliberately
 *     ungated, internally-reused) core runs. intake-orchestration-resolver.ts
 *     calls activateProjectAgents(projectId) directly with no event — this
 *     preserves that call site untouched (see the pinning test below).
 *   searchAgentConfigsRegistry(query, event) — result-level org filter,
 *     mirroring listAgentConfigsRegistry.
 *   updateAgentConfigRegistry(input, event) — now reconciles the EXISTING
 *     record's orgId (when present) against the caller's org before mutating.
 *
 * Root defect: deleteAgentConfigRegistry, publishAgentManifestRegistry, and
 * activateProjectAgents took no event at all, so ANY authenticated caller of
 * ANY org could delete/publish/activate ANY org's agents. searchAgentConfigs
 * returned unfiltered results across every org. updateAgentConfigRegistry
 * never compared the caller's org against the record it was about to mutate.
 *
 * Fail-closed matrix asserted per gated op: cross-org rejected, same-org
 * allowed, admin bypass, no-org non-admin rejected. delete/publish
 * additionally require isAdminFromEvent || hasRoleFromEvent(event,'architect')
 * (decision 31ee5b5d) — asserted after the org gate so a cross-org caller
 * never learns whether they merely lack the role.
 */
import {
  deleteAgentConfigRegistry,
  publishAgentManifestRegistry,
  searchAgentConfigsRegistry,
  updateAgentConfigRegistry,
  activateProjectAgents,
  handler,
  _resetRegistryService,
} from "../agent-config-resolver";

// ── Mock RegistryService ────────────────────────────────────────────────
const mockGetResource = jest.fn();
const mockDeleteResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockListResources = jest.fn();
const mockSearchResources = jest.fn();
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
    inactive: "DEPRECATED",
    maintenance: "DRAFT",
  };
  return map[state] || "DEPRECATED";
});

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
          return JSON.parse(record.customDescriptorContent!);
        } catch {
          return {};
        }
      })()
    : {};
  return {
    agentId: record.recordId,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: record.description ?? "",
    state: "active",
    categories: [] as string[],
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    deleteResource: mockDeleteResource,
    updateResource: mockUpdateResource,
    updateResourceStatus: mockUpdateResourceStatus,
    listResources: mockListResources,
    searchResources: mockSearchResources,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
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

// ── Mock the project-org-access gate for activateProjectAgents dispatch ──
const mockAssertProjectOrgAccess = jest.fn();
jest.mock("../../utils/project-org-access", () => ({
  assertProjectOrgAccess: (...args: unknown[]) =>
    mockAssertProjectOrgAccess(...args),
  ProjectOrgAccessError: class ProjectOrgAccessError extends Error {},
}));

// ── Fixtures ─────────────────────────────────────────────────────────────
const sameOrgEvent = {
  identity: { claims: { "custom:organization": "test-org-a" } },
};
const crossOrgEvent = {
  identity: { claims: { "custom:organization": "other-org" } },
};
const noOrgEvent = { identity: {} };
const adminEvent = {
  identity: {
    claims: {
      "custom:organization": "admin-home-org",
      "cognito:groups": ["admin"],
    },
  },
};
const architectSameOrgEvent = {
  identity: {
    claims: {
      "custom:organization": "test-org-a",
      "custom:role": "architect",
    },
  },
};

const recordWithOrg = (agentId: string, orgId: string) => ({
  recordId: agentId,
  name: "TestAgent",
  description: '{"name":"TestAgent"}',
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({
    categories: [],
    icon: "",
    state: "active",
    orgId,
  }),
});

const validManifest = JSON.stringify({
  name: "Test Agent",
  description: "A test agent",
  version: "1.0.0",
});

describe("agent-config-resolver — tenancy + role gate (finding 1fcfd11e)", () => {
  const originalEnv = process.env;

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

  // ─── deleteAgentConfigRegistry ────────────────────────────────────────

  describe("deleteAgentConfigRegistry", () => {
    test("cross-org caller (architect role) is rejected before deleteResource is called", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      const result = await deleteAgentConfigRegistry("agent-1", {
        identity: {
          claims: {
            "custom:organization": "other-org",
            "custom:role": "architect",
          },
        },
      });

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    test("same-org architect caller is allowed", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await deleteAgentConfigRegistry(
        "agent-1",
        architectSameOrgEvent,
      );

      expect(mockDeleteResource).toHaveBeenCalledWith("agent", "agent-1");
      expect(result.success).toBe(true);
    });

    test("admin bypasses org AND role gate", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "other-org"));
      mockDeleteResource.mockResolvedValue(undefined);

      const result = await deleteAgentConfigRegistry("agent-1", adminEvent);

      expect(mockDeleteResource).toHaveBeenCalledWith("agent", "agent-1");
      expect(result.success).toBe(true);
    });

    test("no-org non-admin caller is rejected", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      const result = await deleteAgentConfigRegistry("agent-1", noOrgEvent);

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    test("role gate: same-org caller WITHOUT architect/admin role is rejected", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      const result = await deleteAgentConfigRegistry("agent-1", sameOrgEvent);

      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  // ─── publishAgentManifestRegistry ─────────────────────────────────────

  describe("publishAgentManifestRegistry", () => {
    test("cross-org caller (architect role) is rejected before updateResource is called", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      await expect(
        publishAgentManifestRegistry("agent-1", validManifest, {
          identity: {
            claims: {
              "custom:organization": "other-org",
              "custom:role": "architect",
            },
          },
        }),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("same-org architect caller is allowed", async () => {
      const record = recordWithOrg("agent-1", "test-org-a");
      mockGetResource.mockResolvedValue(record);
      mockUpdateResource.mockResolvedValue(record);

      const result = await publishAgentManifestRegistry(
        "agent-1",
        validManifest,
        architectSameOrgEvent,
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe("agent-1");
    });

    test("admin bypasses org AND role gate", async () => {
      const record = recordWithOrg("agent-1", "other-org");
      mockGetResource.mockResolvedValue(record);
      mockUpdateResource.mockResolvedValue(record);

      const result = await publishAgentManifestRegistry(
        "agent-1",
        validManifest,
        adminEvent,
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe("agent-1");
    });

    test("no-org non-admin caller is rejected", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      await expect(
        publishAgentManifestRegistry("agent-1", validManifest, noOrgEvent),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("role gate: same-org caller WITHOUT architect/admin role is rejected", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      await expect(
        publishAgentManifestRegistry("agent-1", validManifest, sameOrgEvent),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });
  });

  // ─── searchAgentConfigsRegistry ────────────────────────────────────────

  describe("searchAgentConfigsRegistry", () => {
    const records = [
      recordWithOrg("agent-a", "test-org-a"),
      recordWithOrg("agent-b", "other-org"),
    ];

    test("results are filtered to the caller's org", async () => {
      mockSearchResources.mockResolvedValue(records);

      const result = await searchAgentConfigsRegistry("test", sameOrgEvent);

      expect(result.map((r) => r.agentId)).toEqual(["agent-a"]);
    });

    test("admin sees results across all orgs (no filter)", async () => {
      mockSearchResources.mockResolvedValue(records);

      const result = await searchAgentConfigsRegistry("test", adminEvent);

      expect(result.map((r) => r.agentId).sort()).toEqual([
        "agent-a",
        "agent-b",
      ]);
    });

    test("no-org non-admin caller gets an empty list and no search call", async () => {
      mockSearchResources.mockResolvedValue(records);

      const result = await searchAgentConfigsRegistry("test", noOrgEvent);

      expect(result).toEqual([]);
      expect(mockSearchResources).not.toHaveBeenCalled();
    });
  });

  // ─── updateAgentConfigRegistry — cross-org reconciliation against EXISTING record ──

  describe("updateAgentConfigRegistry — existing-record org reconciliation", () => {
    test("cross-org caller is rejected when the EXISTING record has an orgId that differs", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      await expect(
        updateAgentConfigRegistry(
          { agentId: "agent-1", categories: ["x"] },
          crossOrgEvent,
        ),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    test("same-org caller is allowed", async () => {
      const record = recordWithOrg("agent-1", "test-org-a");
      mockGetResource.mockResolvedValue(record);
      mockUpdateResource.mockResolvedValue(record);

      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", categories: ["x"] },
        sameOrgEvent,
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe("agent-1");
    });

    test("admin bypasses the org gate", async () => {
      const record = recordWithOrg("agent-1", "other-org");
      mockGetResource.mockResolvedValue(record);
      mockUpdateResource.mockResolvedValue(record);

      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", categories: ["x"] },
        adminEvent,
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe("agent-1");
    });

    test("legacy record with NO orgId is not blocked by the org gate (fallback path preserved)", async () => {
      const legacyRecord = {
        recordId: "agent-1",
        name: "ExistingAgent",
        description: '{"name":"ExistingAgent"}',
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
        }),
      };
      mockGetResource.mockResolvedValue(legacyRecord);
      mockUpdateResource.mockResolvedValue(legacyRecord);

      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", categories: ["x"] },
        sameOrgEvent,
      );

      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result.agentId).toBe("agent-1");
    });

    test("no-org non-admin caller is rejected when the EXISTING record has an orgId", async () => {
      mockGetResource.mockResolvedValue(recordWithOrg("agent-1", "test-org-a"));

      await expect(
        updateAgentConfigRegistry(
          { agentId: "agent-1", categories: ["x"] },
          noOrgEvent,
        ),
      ).rejects.toThrow();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });
  });

  // ─── activateProjectAgents dispatch — org gate via assertProjectOrgAccess ──

  describe("activateProjectAgents dispatch gate (assertProjectOrgAccess)", () => {
    const makeEvent = (
      fieldName: string,
      args: Record<string, unknown>,
      identity: Record<string, unknown> = {},
    ) => ({ info: { fieldName }, arguments: args, identity });

    test("dispatch calls assertProjectOrgAccess(projectId, event) BEFORE activation runs", async () => {
      mockAssertProjectOrgAccess.mockResolvedValue(undefined);
      mockListResources.mockResolvedValue([]);

      await handler(
        makeEvent(
          "activateProjectAgents",
          { projectId: "proj-1" },
          {
            claims: { "custom:organization": "test-org-a" },
          },
        ),
      );

      expect(mockAssertProjectOrgAccess).toHaveBeenCalledWith(
        "proj-1",
        expect.anything(),
      );
    });

    test("dispatch propagates a rejection from assertProjectOrgAccess and never lists/activates", async () => {
      mockAssertProjectOrgAccess.mockRejectedValue(new Error("Access denied"));

      await expect(
        handler(
          makeEvent(
            "activateProjectAgents",
            { projectId: "proj-1" },
            {
              claims: { "custom:organization": "other-org" },
            },
          ),
        ),
      ).rejects.toThrow();
      expect(mockListResources).not.toHaveBeenCalled();
    });

    test("PINNING: activateProjectAgents(projectId) itself remains callable with NO event (intake-orchestration-resolver.ts's internal call site)", async () => {
      mockListResources.mockResolvedValue([]);

      const result = await activateProjectAgents("proj-1");

      expect(result).toEqual({ activated: [], failed: [], alreadyActive: [] });
      // The internal core must never require assertProjectOrgAccess itself —
      // only the dispatch wrapper does. No event was passed here, and no org
      // gate was invoked, exactly like the pre-fix behaviour intake relies on.
      expect(mockAssertProjectOrgAccess).not.toHaveBeenCalled();
    });
  });
});
