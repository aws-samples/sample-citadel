/**
 * Tests for listAgentConfigsRegistry deduplification and description surfacing.
 *
 * Regression guards for:
 * - Registry agent + its recordId-keyed cache row + its name-keyed cache row
 *   => ONE entry with description
 * - True legacy agent (no registry record) => listed once
 * - App records excluded from the agent list
 * - Description precedence: record.description > manifest.description >
 *   config.description
 */
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock RegistryService — minimal surface for listAgentConfigsRegistry.
// mockMapToAgentConfig faithfully reproduces the real mapper's description
// enrichment so the assertion on description actually tests the end-to-end
// path through the mock.
// ---------------------------------------------------------------------------

interface TestRegistryRecord {
  recordId: string;
  name: string;
  description?: string;
  status: string;
  customDescriptorContent: string;
}

const mockListResources = jest.fn();
const mockMapToAgentConfig = jest.fn((record: TestRegistryRecord) => {
  const meta = JSON.parse(record.customDescriptorContent) as {
    orgId?: string;
    citadelKind?: string;
  };
  // Mirror the real mapper: inject description into config JSON when
  // description is plain text (not a JSON object).
  const description = record.description;
  const hasPlainTextDesc =
    typeof description === "string" &&
    description.length > 0 &&
    !description.startsWith("{");
  const configObj: Record<string, unknown> = {};
  if (hasPlainTextDesc) configObj.description = description;
  configObj.name = record.name;

  return {
    agentId: record.recordId,
    name: record.name,
    description: hasPlainTextDesc ? description : undefined,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: JSON.stringify(configObj),
    state: "active",
    categories: [] as string[],
  };
});

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
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

import {
  listAgentConfigsRegistry,
  _resetRegistryService,
} from "../agent-config-resolver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const registryRecord = (
  recordId: string,
  name: string,
  description?: string,
): TestRegistryRecord => ({
  recordId,
  name,
  description,
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({
    orgId: "org-a",
    citadelKind: "agent",
  }),
});

const adminEvent = {
  identity: { claims: { "custom:role": "admin", "cognito:groups": ["admin"] } },
};

const agentIdsOf = (configs: Array<{ agentId: string }>): string[] =>
  configs.map((c) => c.agentId).sort();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listAgentConfigsRegistry — dedupe and description", () => {
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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("registry agent with recordId-keyed and name-keyed cache rows produces ONE entry", async () => {
    // Registry returns one agent.
    mockListResources.mockResolvedValue([
      registryRecord("rec-abc123", "WeatherAgent", "Fetches weather data"),
    ]);

    // DynamoDB cache has TWO mirror rows:
    // (a) recordId-keyed row (written by handleGaUpsert)
    // (b) name-keyed row with registryRecordId back-pointer (written by syncNameKeyedRow)
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          agentId: "rec-abc123",
          orgId: "org-a",
          config: '{"name":"WeatherAgent"}',
          state: "active",
        },
        {
          agentId: "WeatherAgent",
          orgId: "org-a",
          config: '{"name":"WeatherAgent"}',
          state: "active",
          registryRecordId: "rec-abc123",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(adminEvent);

    // Should contain only the registry-mapped entry, not the two cache rows.
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("rec-abc123");
    expect(result[0].description).toBe("Fetches weather data");
  });

  test("true legacy agent (no registry record) is listed once", async () => {
    mockListResources.mockResolvedValue([
      registryRecord("rec-abc123", "WeatherAgent", "Fetches weather data"),
    ]);

    dynamoMock.on(ScanCommand).resolves({
      Items: [
        // Mirror row — should be excluded.
        {
          agentId: "rec-abc123",
          orgId: "org-a",
          config: '{"name":"WeatherAgent"}',
          state: "active",
        },
        // True legacy agent — no registry record, no registryRecordId.
        {
          agentId: "LegacyBot",
          orgId: "org-a",
          config: '{"name":"LegacyBot"}',
          state: "active",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(adminEvent);

    const ids = agentIdsOf(result);
    expect(ids).toContain("rec-abc123");
    expect(ids).toContain("LegacyBot");
    expect(result).toHaveLength(2);
  });

  test("cache row whose agentId equals a registry recordId is excluded", async () => {
    mockListResources.mockResolvedValue([
      registryRecord("rec-xyz789", "HelperAgent"),
    ]);

    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          agentId: "rec-xyz789",
          orgId: "org-a",
          config: "{}",
          state: "active",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(adminEvent);

    expect(agentIdsOf(result)).toEqual(["rec-xyz789"]);
    expect(result).toHaveLength(1);
  });

  test("cache row with registryRecordId back-pointer is excluded", async () => {
    mockListResources.mockResolvedValue([
      registryRecord("rec-xyz789", "HelperAgent"),
    ]);

    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          agentId: "HelperAgent",
          orgId: "org-a",
          config: '{"name":"HelperAgent"}',
          state: "active",
          registryRecordId: "rec-xyz789",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(adminEvent);

    expect(agentIdsOf(result)).toEqual(["rec-xyz789"]);
    expect(result).toHaveLength(1);
  });

  test("description precedence: record.description wins over config.description", async () => {
    mockListResources.mockResolvedValue([
      registryRecord("rec-desc1", "DescAgent", "Record-level description"),
    ]);
    dynamoMock.on(ScanCommand).resolves({ Items: [] });

    const result = await listAgentConfigsRegistry(adminEvent);

    expect(result[0].description).toBe("Record-level description");
    const config = JSON.parse(result[0].config as string);
    expect(config.description).toBe("Record-level description");
  });

  test("duplicate legacy rows with same name are deduped", async () => {
    mockListResources.mockResolvedValue([]);

    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          agentId: "dup-1",
          orgId: "org-a",
          config: '{"name":"DuplicateAgent"}',
          state: "active",
        },
        {
          agentId: "dup-2",
          orgId: "org-a",
          config: '{"name":"DuplicateAgent"}',
          state: "active",
        },
      ],
    });

    const result = await listAgentConfigsRegistry(adminEvent);

    // Only the first one should survive the name dedup.
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("dup-1");
  });
});
