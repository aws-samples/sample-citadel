/**
 * CIT-042 PR2: tag-policy enforcement for tool create + update
 * (tool-config-resolver.ts).
 *
 * 4 cases per entry point:
 *   1. strict + missing required key → TAG_POLICY_VIOLATION, no write
 *   2. shadow → proceeds with warn
 *   3. no policy → proceeds
 *   4. update without tags → enforcement NOT called
 */

// ── env ────────────────────────────────────────────────────────────────
process.env.REGISTRY_ID = "test-registry-id";
process.env.REGISTRY_ENABLED = "true";
process.env.TOOLS_CONFIG_TABLE = "tools-table";
process.env.ORGANIZATIONS_TABLE = "orgs-table";

// ── mocks: tag-policy-check (enforcement adapter) ──────────────────────
const mockEnforceTagPolicy = jest.fn();

class TagPolicyViolationError extends Error {
  readonly code = "TAG_POLICY_VIOLATION" as const;
  constructor(
    public readonly violations: Array<{ type: string; key: string }>,
    public readonly action: string,
    public readonly orgId: string,
  ) {
    super(
      `tag_policy_violation: missing required keys: ${violations.map((v) => v.key).join(", ")}`,
    );
    this.name = "TagPolicyViolationError";
  }
}

jest.mock("../tag-policy-check", () => ({
  __esModule: true,
  enforceTagPolicy: mockEnforceTagPolicy,
  TagPolicyViolationError,
}));

// ── mocks: RegistryService ─────────────────────────────────────────────
const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSubmitForApproval = jest.fn();
const mockSerializeCustomMetadata = jest.fn((m: unknown) => JSON.stringify(m));
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
const mockMapToToolConfig = jest.fn((record: Record<string, unknown>) => ({
  toolId: record.recordId,
  config: record.description || "",
  state: "active",
  categories: [],
}));

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => "test-registry",
    createResource: mockCreateResource,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    updateResourceStatus: mockUpdateResourceStatus,
    submitForApproval: mockSubmitForApproval,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToToolConfig: mockMapToToolConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
  },
  RegistryLifecycleError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

// ── mocks: auth helpers ────────────────────────────────────────────────
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-test"),
  isAdminFromEvent: jest.fn().mockReturnValue(false),
  hasRoleFromEvent: jest.fn().mockReturnValue(false),
  assertRowOrg: jest.fn(),
  canCallerSeeRow: jest.fn().mockReturnValue(true),
}));
jest.mock("../../utils/appsync", () => ({
  getUserId: jest.fn().mockReturnValue("user-1"),
}));

// ── mocks: side-effect modules ─────────────────────────────────────────
jest.mock("../../utils/operations-registry", () => ({
  getOperations: jest.fn().mockReturnValue([]),
}));
jest.mock("../../utils/record-visibility", () => ({
  isRecordVisible: jest.fn().mockReturnValue(true),
  viewerFromEvent: jest.fn(),
}));
jest.mock("../../adapters/lifecycle", () => ({
  LifecycleManager: jest.fn().mockImplementation(() => ({
    isValidTransition: jest.fn().mockReturnValue(true),
  })),
  REGISTRY_TRANSITIONS: { transitions: {} },
}));

// ── SUT ────────────────────────────────────────────────────────────────
import {
  createToolConfigRegistry,
  updateToolConfigRegistry,
} from "../tool-config-resolver";

// ── helpers ────────────────────────────────────────────────────────────
const TEST_ORG = "org-test";
const EVENT = {
  identity: {
    sub: "user-1",
    claims: { sub: "user-1", "custom:organization": TEST_ORG },
  },
};

function makeRecord(id: string, meta: Record<string, unknown> = {}) {
  return {
    recordId: id,
    name: id,
    description: JSON.stringify({ name: id, description: "test" }),
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      categories: [],
      icon: "",
      state: "active",
      orgId: TEST_ORG,
      ...meta,
    }),
  };
}

// ── tests ──────────────────────────────────────────────────────────────
describe("tool-config-resolver tag-policy enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateResource.mockResolvedValue(makeRecord("tool-1"));
    mockGetResource.mockResolvedValue(makeRecord("tool-1"));
    mockUpdateResource.mockResolvedValue(makeRecord("tool-1"));
  });

  // ─── createToolConfigRegistry ─────────────────────────────────────
  describe("createToolConfigRegistry", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no registry write", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "createTool",
          TEST_ORG,
        ),
      );

      await expect(
        createToolConfigRegistry(
          {
            toolId: "tool-1",
            config: JSON.stringify({ name: "t1", description: "test" }),
            tags: { team: "platform" },
          },
          "user-1",
          EVENT,
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "createTool",
          tags: { team: "platform" },
        }),
      );
      expect(mockCreateResource).not.toHaveBeenCalled();
    });

    it("shadow → proceeds with warn", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: false,
        violations: [{ type: "MISSING_KEY", key: "env" }],
      });

      const result = await createToolConfigRegistry(
        {
          toolId: "tool-1",
          config: JSON.stringify({ name: "t1", description: "test" }),
          tags: { team: "platform" },
        },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("no policy → proceeds", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: true,
        violations: [],
      });

      const result = await createToolConfigRegistry(
        {
          toolId: "tool-1",
          config: JSON.stringify({ name: "t1", description: "test" }),
          tags: { env: "prod" },
        },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("create without tags → enforcement NOT called", async () => {
      await createToolConfigRegistry(
        {
          toolId: "tool-1",
          config: JSON.stringify({ name: "t1", description: "test" }),
        },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
    });
  });

  // ─── updateToolConfigRegistry ─────────────────────────────────────
  describe("updateToolConfigRegistry", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no write", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "updateTool",
          TEST_ORG,
        ),
      );

      await expect(
        updateToolConfigRegistry(
          { toolId: "tool-1", tags: { team: "platform" } },
          "user-1",
          EVENT,
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "updateTool",
          tags: { team: "platform" },
        }),
      );
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    it("shadow → proceeds with warn", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: false,
        violations: [{ type: "MISSING_KEY", key: "env" }],
      });

      const result = await updateToolConfigRegistry(
        { toolId: "tool-1", tags: { team: "platform" } },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("no policy → proceeds", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: true,
        violations: [],
      });

      const result = await updateToolConfigRegistry(
        { toolId: "tool-1", tags: { env: "prod" } },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("update without tags → enforcement NOT called", async () => {
      const result = await updateToolConfigRegistry(
        {
          toolId: "tool-1",
          config: JSON.stringify({ name: "updated", description: "test" }),
        },
        "user-1",
        EVENT,
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});
