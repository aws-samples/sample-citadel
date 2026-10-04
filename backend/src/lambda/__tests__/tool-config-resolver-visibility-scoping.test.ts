/**
 * CIT-043 — Visibility-scoped listing and search for tool configs.
 *
 * Validates that:
 *  - developer sees only APPROVED records from registry
 *  - architect sees own-org PENDING_APPROVAL (and APPROVED)
 *  - admin sees all statuses
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
const mockMapToToolConfig = jest.fn((record: TestRegistryRecord) => {
  const meta = JSON.parse(record.customDescriptorContent) as {
    orgId?: string;
    createdBy?: string;
  };
  return {
    toolId: record.recordId,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: record.description || "",
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
    mapToToolConfig: mockMapToToolConfig,
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
  listToolConfigsRegistry,
  _resetRegistryService,
  handler,
} from "../tool-config-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_A = "org-a";
const USER_A = "user-a-sub";

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

const developerEvent = (orgId: string) => eventForRole(orgId, "developer");
const architectEvent = (orgId: string, userId = "some-user") =>
  eventForRole(orgId, "architect", userId);
const adminEvent = {
  identity: {
    sub: "admin-sub",
    "cognito:groups": ["admin"],
    claims: { "cognito:groups": ["admin"] },
  },
};

const APPROVED_OWN = registryRecord(
  "t-approved",
  "ApprovedTool",
  ORG_A,
  "APPROVED",
  USER_A,
);
const PENDING_OWN = registryRecord(
  "t-pending",
  "PendingTool",
  ORG_A,
  "PENDING_APPROVAL",
  USER_A,
);
const DRAFT_OWN = registryRecord(
  "t-draft",
  "DraftTool",
  ORG_A,
  "DRAFT",
  USER_A,
);
const REJECTED_OWN = registryRecord(
  "t-rejected",
  "RejectedTool",
  ORG_A,
  "REJECTED",
  USER_A,
);
const APPROVED_OTHER = registryRecord(
  "t-approved-other",
  "ApprovedOther",
  "org-b",
  "APPROVED",
  "user-b",
);
const PENDING_OTHER = registryRecord(
  "t-pending-other",
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
  APPROVED_OTHER,
  PENDING_OTHER,
];

const idsOf = (configs: Array<{ toolId: string }>): string[] =>
  configs.map((c) => c.toolId).sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CIT-043 tool config visibility scoping", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      TOOLS_CONFIG_TABLE: "test-tools",
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

  // --- listToolConfigsRegistry ---

  test("developer sees only APPROVED own-org tools from registry", async () => {
    const result = await listToolConfigsRegistry(developerEvent(ORG_A));
    const ids = idsOf(result);
    expect(ids).toContain("t-approved");
    expect(ids).not.toContain("t-pending");
    expect(ids).not.toContain("t-draft");
    expect(ids).not.toContain("t-rejected");
    expect(ids).not.toContain("t-approved-other");
  });

  test("architect sees own-org APPROVED + PENDING_APPROVAL tools from registry", async () => {
    const result = await listToolConfigsRegistry(architectEvent(ORG_A, USER_A));
    const ids = idsOf(result);
    expect(ids).toContain("t-approved");
    expect(ids).toContain("t-pending");
    expect(ids).toContain("t-draft"); // owner match
    expect(ids).not.toContain("t-rejected");
    expect(ids).not.toContain("t-pending-other");
  });

  test("admin sees all statuses across all orgs from registry", async () => {
    const result = await listToolConfigsRegistry(adminEvent);
    const ids = idsOf(result);
    expect(ids).toEqual(ALL_RECORDS.map((r) => r.recordId).sort());
  });

  // --- searchToolConfigs via handler ---

  test("developer search returns only APPROVED own-org tools", async () => {
    const result = await handler(
      {
        info: { fieldName: "searchToolConfigs" },
        arguments: { query: "test" },
        identity: developerEvent(ORG_A).identity,
      },
      {},
    );
    const ids = idsOf(result as Array<{ toolId: string }>);
    expect(ids).toContain("t-approved");
    expect(ids).not.toContain("t-pending");
  });

  test("admin search returns all statuses", async () => {
    const result = await handler(
      {
        info: { fieldName: "searchToolConfigs" },
        arguments: { query: "test" },
        identity: adminEvent.identity,
      },
      {},
    );
    const ids = idsOf(result as Array<{ toolId: string }>);
    expect(ids).toEqual(ALL_RECORDS.map((r) => r.recordId).sort());
  });
});
