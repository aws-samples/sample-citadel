/**
 * CIT-042 PR2: tag-policy enforcement for agent import
 * (agent-import-resolver.ts).
 *
 * 4 cases:
 *   1. strict + missing required key → TAG_POLICY_VIOLATION, no registry write
 *   2. shadow → proceeds with warn
 *   3. no policy → proceeds
 *   4. import without tags → enforcement NOT called
 */

// ── env ────────────────────────────────────────────────────────────────
process.env.REGISTRY_ID = "test-registry-id";
process.env.ORGANIZATIONS_TABLE = "orgs-table";
process.env.ENVIRONMENT = "test";

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
const mockUpdateResource = jest.fn();
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSerializeCustomMetadata = jest.fn((m: unknown) => JSON.stringify(m));
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null | undefined, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try {
      return { ...defaults, ...JSON.parse(json) };
    } catch {
      return defaults;
    }
  },
);
const mockMapToAgentConfig = jest.fn(
  (record: { recordId: string; name?: string; description?: string }) => ({
    agentId: record.recordId,
    name: record.name ?? "",
    orgId: "org-test",
    config: record.description ?? "",
    state: "inactive",
    categories: [],
  }),
);

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => "test-registry",
    createResource: mockCreateResource,
    updateResource: mockUpdateResource,
    listResources: mockListResources,
    getResource: mockGetResource,
    updateResourceStatus: mockUpdateResourceStatus,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
}));

// ── mocks: auth-event ──────────────────────────────────────────────────
jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn().mockResolvedValue("org-test"),
  isAdminFromEvent: jest.fn().mockReturnValue(true),
  hasRoleFromEvent: jest.fn().mockReturnValue(true),
}));

// ── mocks: side-effect / AWS modules ───────────────────────────────────
jest.mock("../../utils/events", () => ({
  __esModule: true,
  publishEvent: jest.fn(),
  EventTypes: {
    AGENT_IMPORT_REGISTERED: "agent.import.registered",
  },
}));
jest.mock("../../utils/governance-flag", () => ({
  __esModule: true,
  getGovernanceEnforce: jest.fn().mockResolvedValue("shadow"),
}));
jest.mock("../registry-agent-authority-lifecycle", () => ({
  __esModule: true,
  grantFabricatorAuthority: jest.fn(),
}));
jest.mock("../../services/agent-discovery", () => ({
  __esModule: true,
  resolveSourceRef: jest.fn(),
  tagScanDiscover: jest.fn(),
  candidateFromManifest: jest.fn(),
  getDiscoveryAdapterForSubstrate: jest.fn(),
  UnsupportedSourceError: class extends Error {},
  InvalidSourceRefError: class extends Error {},
}));
jest.mock("../../adapters/agent-source/registry-factory", () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: jest.fn(() => ({
    resolve: jest.fn(),
  })),
}));
jest.mock("../../utils/reachability-probe", () => ({
  __esModule: true,
  probeReachability: jest.fn(),
}));
jest.mock("../../utils/credential-manager", () => ({
  __esModule: true,
  storeAgentInvocationSecret: jest.fn(),
  getAgentInvocationSecret: jest.fn(),
}));
jest.mock("../../utils/sanitize-agent-output", () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: jest.fn((x: string) => x),
}));
jest.mock("../../utils/trust-path", () => ({
  __esModule: true,
  assumeRoleCredentials: jest.fn(),
  isCrossAccountRoleArn: jest.fn().mockReturnValue(false),
}));
jest.mock("../../adapters/agent-source/invoke-support", () => ({
  __esModule: true,
  vendImportCredentials: jest.fn(),
  toInvokeCredentials: jest.fn(),
}));
jest.mock("../adr-resolver", () => ({
  __esModule: true,
  createADR: jest.fn().mockResolvedValue({ adrId: "adr-1" }),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));
jest.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  CreateGatewayTargetCommand: jest.fn(),
  DeleteGatewayTargetCommand: jest.fn(),
}));
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}));
jest.mock("../../utils/gateway-target-manager", () => ({
  __esModule: true,
  buildMCPServerTargetPayload: jest.fn(),
  deleteTargetAndProvider: jest.fn(),
}));
jest.mock("../../utils/credential-provider-manager", () => ({
  __esModule: true,
  createOrUpsertApiKeyProvider: jest.fn(),
}));

// ── SUT ────────────────────────────────────────────────────────────────
// importAgent is the default export handler's inner function. We import
// the module and call its handler with the importAgent field name.
import { handler, _resetRegistryService } from "../agent-import-resolver";

// ── helpers ────────────────────────────────────────────────────────────
const TEST_ORG = "org-test";
const ADMIN_EVENT = {
  info: { fieldName: "importAgent" },
  identity: {
    sub: "user-1",
    username: "user-1",
    claims: { sub: "user-1", "custom:organization": TEST_ORG },
  },
  arguments: {} as Record<string, unknown>,
};

function makeImportInput(tags?: Record<string, string>) {
  return {
    name: "my-agent",
    invocationProtocol: "HTTP_ENDPOINT",
    invocationTarget: "https://example.com/agent",
    invocationAuthMode: "NONE",
    substrate: "lambda",
    sourceArn: "arn:aws:lambda:us-east-1:123456789012:function:agent",
    ...(tags !== undefined ? { tags } : {}),
  };
}

function makeCreatedRecord(id: string = "rec-1") {
  return {
    recordId: id,
    name: "my-agent",
    description: "{}",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      categories: [],
      orgId: TEST_ORG,
      origin: { ownership: "external" },
    }),
  };
}

// ── tests ──────────────────────────────────────────────────────────────
describe("agent-import-resolver tag-policy enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetRegistryService();
    mockListResources.mockResolvedValue([]);
    mockCreateResource.mockResolvedValue(makeCreatedRecord());
  });

  it("strict + missing required key → TAG_POLICY_VIOLATION, no registry write", async () => {
    mockEnforceTagPolicy.mockRejectedValueOnce(
      new TagPolicyViolationError(
        [{ type: "MISSING_KEY", key: "env" }],
        "importAgent",
        TEST_ORG,
      ),
    );

    const event = {
      ...ADMIN_EVENT,
      arguments: { input: makeImportInput({ team: "platform" }) },
    };

    await expect(handler(event)).rejects.toThrow(TagPolicyViolationError);

    expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: TEST_ORG,
        action: "importAgent",
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

    const event = {
      ...ADMIN_EVENT,
      arguments: { input: makeImportInput({ team: "platform" }) },
    };

    const result = await handler(event);

    expect(mockEnforceTagPolicy).toHaveBeenCalled();
    expect(mockCreateResource).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("no policy → proceeds (enforcement returns ok:true)", async () => {
    mockEnforceTagPolicy.mockResolvedValueOnce({
      ok: true,
      violations: [],
    });

    const event = {
      ...ADMIN_EVENT,
      arguments: { input: makeImportInput({ env: "prod" }) },
    };

    const result = await handler(event);

    expect(mockEnforceTagPolicy).toHaveBeenCalled();
    expect(mockCreateResource).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("import without tags → enforcement NOT called", async () => {
    const event = {
      ...ADMIN_EVENT,
      arguments: { input: makeImportInput() },
    };

    const result = await handler(event);

    expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
    expect(mockCreateResource).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
