/**
 * CIT-043 — Visibility-scoped listing and search for agent configs.
 *
 * Validates that:
 *  - developer sees only APPROVED records from both registry and DDB cache
 *  - architect sees own-org PENDING_APPROVAL (and APPROVED)
 *  - admin sees all statuses
 *  - createdBy is stamped on createAgentConfigRegistry
 */
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------

interface TestRegistryRecord {
  recordId: string;
  name: string;
  status: string;
  description: string;
  customDescriptorContent: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const mockListResources = jest.fn();
const mockSearchResources = jest.fn();
const mockCreateResource = jest.fn();
const mockGetResource = jest.fn();
const mockSubmitForApproval = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: unknown) =>
  JSON.stringify(meta),
);

const mockMapToAgentConfig = jest.fn((record: TestRegistryRecord) => {
  const meta = JSON.parse(record.customDescriptorContent) as {
    orgId?: string;
    createdBy?: string;
  };
  return {
    agentId: record.recordId,
    name: record.name,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: record.description,
    state: "active",
    categories: [] as string[],
    registryStatus: record.status,
    createdBy: meta.createdBy,
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    searchResources: mockSearchResources,
    createResource: mockCreateResource,
    getResource: mockGetResource,
    submitForApproval: mockSubmitForApproval,
    updateResourceStatus: mockUpdateResourceStatus,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    mapToAgentConfig: mockMapToAgentConfig,
    toRegistryStatus: jest.fn(() => "APPROVED"),
    toInternalState: jest.fn(() => "active"),
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
  },
}));

import {
  listAgentConfigsRegistry,
  searchAgentConfigsRegistry,
  createAgentConfigRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_A = "org-a";
const USER_A = "user-a-sub";

/** Registry record with status/org/createdBy in custom metadata. */
const registryRecord = (
  id: string,
  name: string,
  orgId: string,
  status: string,
  createdBy?: string,
): TestRegistryRecord => ({
  recordId: id,
  name,
  status,
  description: JSON.stringify({ name }),
  customDescriptorContent: JSON.stringify({ orgId, createdBy }),
});

/** Event for a non-admin user with a specific role. */
const eventForRole = (orgId: string, role: string, userId = "some-user") => ({
  identity: {
    sub: userId,
    "custom:organization": orgId,
    "cognito:groups": [role],
    claims: {
      "custom:organization": orgId,
      "cognito:groups": [role],
    },
  },
});

const developerEvent = (orgId: string, userId = "some-user") =>
  eventForRole(orgId, "developer", userId);
const architectEvent = (orgId: string, userId = "some-user") =>
  eventForRole(orgId, "architect", userId);
const adminEvent = {
  identity: {
    sub: "admin-sub",
    "cognito:groups": ["admin"],
    claims: { "cognito:groups": ["admin"] },
  },
};

// Agents across statuses and orgs.
const APPROVED_OWN = registryRecord(
  "r-approved-own",
  "ApprovedOwn",
  ORG_A,
  "APPROVED",
  USER_A,
);
const PENDING_OWN = registryRecord(
  "r-pending-own",
  "PendingOwn",
  ORG_A,
  "PENDING_APPROVAL",
  USER_A,
);
const DRAFT_OWN = registryRecord(
  "r-draft-own",
  "DraftOwn",
  ORG_A,
  "DRAFT",
  USER_A,
);
const REJECTED_OWN = registryRecord(
  "r-rejected-own",
  "RejectedOwn",
  ORG_A,
  "REJECTED",
  USER_A,
);
const DEPRECATED_OWN = registryRecord(
  "r-depr-own",
  "DeprecatedOwn",
  ORG_A,
  "DEPRECATED",
  USER_A,
);
const APPROVED_OTHER = registryRecord(
  "r-approved-other",
  "ApprovedOther",
  "org-b",
  "APPROVED",
  "user-b",
);
const PENDING_OTHER = registryRecord(
  "r-pending-other",
  "PendingOther",
  "org-b",
  "PENDING_APPROVAL",
  "user-b",
);

const ALL_RECORDS = [
  APPROVED_OWN,
  PENDING_OWN,
  DRAFT_OWN,
  REJECTED_OWN,
  DEPRECATED_OWN,
  APPROVED_OTHER,
  PENDING_OTHER,
];

const idsOf = (configs: Array<{ agentId: string }>): string[] =>
  configs.map((c) => c.agentId).sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CIT-043 agent config visibility scoping", () => {
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
    dynamoMock.reset();
    mockListResources.mockResolvedValue(ALL_RECORDS);
    mockSearchResources.mockResolvedValue(ALL_RECORDS);
    dynamoMock.on(ScanCommand).resolves({ Items: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // --- listAgentConfigsRegistry: registry path ---

  test("developer sees only APPROVED own-org agents from registry", async () => {
    const result = await listAgentConfigsRegistry(developerEvent(ORG_A));
    const ids = idsOf(result);
    expect(ids).toContain("r-approved-own");
    expect(ids).not.toContain("r-pending-own");
    expect(ids).not.toContain("r-draft-own");
    expect(ids).not.toContain("r-rejected-own");
    expect(ids).not.toContain("r-depr-own");
    expect(ids).not.toContain("r-approved-other");
  });

  test("architect sees own-org APPROVED + PENDING_APPROVAL from registry", async () => {
    const result = await listAgentConfigsRegistry(
      architectEvent(ORG_A, USER_A),
    );
    const ids = idsOf(result);
    expect(ids).toContain("r-approved-own");
    expect(ids).toContain("r-pending-own");
    expect(ids).toContain("r-draft-own"); // owner match
    expect(ids).not.toContain("r-rejected-own");
    expect(ids).not.toContain("r-depr-own");
    expect(ids).not.toContain("r-pending-other"); // cross-org
  });

  test("admin sees all statuses across all orgs from registry", async () => {
    const result = await listAgentConfigsRegistry(adminEvent);
    const ids = idsOf(result);
    expect(ids).toEqual(ALL_RECORDS.map((r) => r.recordId).sort());
  });

  // --- listAgentConfigsRegistry: DDB cache path ---

  test("developer sees legacy DDB items without registryStatus (legacy = visible)", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          agentId: "ddb-legacy",
          orgId: ORG_A,
          config: '{"name":"LegacyAgent"}',
          state: "active",
        },
      ],
    });
    mockListResources.mockResolvedValue([]);

    const result = await listAgentConfigsRegistry(developerEvent(ORG_A));
    expect(idsOf(result)).toContain("ddb-legacy");
  });

  // --- searchAgentConfigsRegistry ---

  test("developer search returns only APPROVED own-org agents", async () => {
    const result = await searchAgentConfigsRegistry(
      "test",
      developerEvent(ORG_A),
    );
    const ids = idsOf(result);
    expect(ids).toContain("r-approved-own");
    expect(ids).not.toContain("r-pending-own");
    expect(ids).not.toContain("r-draft-own");
  });

  test("architect search returns own-org APPROVED + PENDING", async () => {
    const result = await searchAgentConfigsRegistry(
      "test",
      architectEvent(ORG_A, USER_A),
    );
    const ids = idsOf(result);
    expect(ids).toContain("r-approved-own");
    expect(ids).toContain("r-pending-own");
    expect(ids).toContain("r-draft-own");
  });

  test("admin search returns all statuses", async () => {
    const result = await searchAgentConfigsRegistry("test", adminEvent);
    expect(idsOf(result)).toEqual(ALL_RECORDS.map((r) => r.recordId).sort());
  });

  // --- createAgentConfigRegistry: createdBy stamped ---

  test("createAgentConfigRegistry stamps createdBy from event identity", async () => {
    mockCreateResource.mockResolvedValue({
      recordId: "new-agent",
      name: "NewAgent",
      status: "DRAFT",
      description: '{"name":"NewAgent"}',
      customDescriptorContent: JSON.stringify({
        orgId: ORG_A,
        createdBy: USER_A,
      }),
    });

    await createAgentConfigRegistry(
      { agentId: "new-agent", config: '{"name":"NewAgent"}' },
      eventForRole(ORG_A, "architect", USER_A),
    );

    expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: USER_A }),
    );
  });
});
