/**
 * CIT-042 PR2: tag-policy enforcement for agent create + update
 * (agent-config-resolver.ts).
 *
 * 4 cases per entry point:
 *   1. strict + missing required key → TAG_POLICY_VIOLATION, no write
 *   2. shadow → proceeds with warn
 *   3. no policy → proceeds
 *   4. update without tags → enforcement NOT called
 */

// ── env ────────────────────────────────────────────────────────────────
process.env.REGISTRY_ID = "test-registry-id";
process.env.ORGANIZATIONS_TABLE = "orgs-table";

// ── mocks: tag-policy-check (enforcement adapter) ──────────────────────
const mockEnforceTagPolicy = jest.fn();

// Define error class locally — the module is mocked so we can't import it.
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
const mockMapToAgentConfig = jest.fn((record: Record<string, unknown>) => ({
  agentId: record.recordId,
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
    mapToAgentConfig: mockMapToAgentConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
  },
}));

// ── mocks: auth helpers ────────────────────────────────────────────────
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-test"),
  isAdminFromEvent: jest.fn().mockReturnValue(false),
  hasRoleFromEvent: jest.fn().mockReturnValue(false),
  assertRowOrg: jest.fn(),
}));
jest.mock("../../utils/auth", () => ({
  extractUserIdFromEvent: jest.fn().mockReturnValue("user-1"),
}));

// ── mocks: side-effect modules ─────────────────────────────────────────
jest.mock("../../utils/events", () => ({
  publishEvent: jest.fn(),
}));
jest.mock("../../utils/record-visibility", () => ({
  isRecordVisible: jest.fn().mockReturnValue(true),
  viewerFromEvent: jest.fn(),
}));
jest.mock("../../utils/project-org-access", () => ({
  assertProjectOrgAccess: jest.fn(),
}));
jest.mock("../../utils/governance-flag", () => ({
  getGovernanceEnforce: jest.fn().mockResolvedValue("permissive"),
}));
jest.mock("../../utils/trust-path", () => ({
  computeTrustPath: jest.fn().mockResolvedValue({ clean: true, findings: [] }),
  isCrossAccountRoleArn: jest.fn().mockReturnValue(false),
  assumeAnalysisRoleClient: jest.fn(),
}));

// ── SUT ────────────────────────────────────────────────────────────────
import {
  createAgentConfigRegistry,
  updateAgentConfigRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

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
    description: JSON.stringify({ name: id }),
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
describe("agent-config-resolver tag-policy enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetRegistryService();
    mockCreateResource.mockResolvedValue(makeRecord("agent-1"));
    mockGetResource.mockResolvedValue(makeRecord("agent-1"));
    mockUpdateResource.mockResolvedValue(makeRecord("agent-1"));
  });

  // ─── createAgentConfigRegistry ────────────────────────────────────
  describe("createAgentConfigRegistry", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no registry write", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "createAgent",
          TEST_ORG,
        ),
      );

      await expect(
        createAgentConfigRegistry(
          {
            agentId: "agent-1",
            config: JSON.stringify({ name: "a1" }),
            tags: { team: "platform" },
          },
          EVENT,
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "createAgent",
          tags: { team: "platform" },
        }),
      );
      expect(mockCreateResource).not.toHaveBeenCalled();
    });

    it("shadow → proceeds with warn (enforcement returns ok:false)", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: false,
        violations: [{ type: "MISSING_KEY", key: "env" }],
      });

      const result = await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: JSON.stringify({ name: "a1" }),
          tags: { team: "platform" },
        },
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("no policy → proceeds (enforcement returns ok:true)", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: true,
        violations: [],
      });

      const result = await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: JSON.stringify({ name: "a1" }),
          tags: { env: "prod", team: "platform" },
        },
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("create without tags → enforcement NOT called", async () => {
      await createAgentConfigRegistry(
        {
          agentId: "agent-1",
          config: JSON.stringify({ name: "a1" }),
        },
        EVENT,
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(mockCreateResource).toHaveBeenCalled();
    });
  });

  // ─── updateAgentConfigRegistry ────────────────────────────────────
  describe("updateAgentConfigRegistry", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no write", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "updateAgent",
          TEST_ORG,
        ),
      );

      await expect(
        updateAgentConfigRegistry(
          {
            agentId: "agent-1",
            tags: { team: "platform" },
          },
          EVENT,
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "updateAgent",
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

      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", tags: { team: "platform" } },
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

      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", tags: { env: "prod" } },
        EVENT,
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("update without tags → enforcement NOT called", async () => {
      const result = await updateAgentConfigRegistry(
        { agentId: "agent-1", config: JSON.stringify({ name: "updated" }) },
        EVENT,
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});
