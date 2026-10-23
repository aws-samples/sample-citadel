/**
 * Tests for listAgentConfigsRegistry — list-from-projection path (CIT-244).
 *
 * Covers: projection has rows → list served from cache; empty projection →
 * fallback to registry; flag off → registry; org filter + kind filter on
 * projection; decision fields present after a decision.
 */
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock CloudWatch (best-effort metric)
// ---------------------------------------------------------------------------
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------
const mockListResources = jest.fn();
const mockMapToAgentConfig = jest.fn((record: Record<string, unknown>) => {
  const meta = JSON.parse((record.customDescriptorContent as string) ?? "{}");
  return {
    agentId: record.recordId,
    name: record.name,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: record.description,
    state: "active",
    categories: [] as string[],
    registryStatus: record.status,
    createdBy: meta.createdBy,
    decidedBy: meta.decidedBy,
    decidedAt: meta.decidedAt,
    statusReason: meta.statusReason,
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
  },
}));

import {
  listAgentConfigsRegistry,
  _resetRegistryService,
  isListFromProjection,
} from "../agent-config-resolver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECTION_ROW = (
  agentId: string,
  name: string,
  orgId: string,
  extra: Record<string, unknown> = {},
) => ({
  agentId,
  name,
  orgId,
  config: JSON.stringify({ name }),
  state: "active",
  categories: ["worker"],
  registryStatus: "APPROVED",
  registryRecordId: agentId,
  citadelKind: "agent",
  projectionVersion: 1,
  projectedAt: "2026-10-23T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  ...extra,
});

const LEGACY_DYNAMO_ROW = {
  agentId: "legacy-local",
  orgId: "org-a",
  config: '{"name":"LegacyLocal"}',
  state: "active",
  categories: [],
};

const adminEvent = {
  identity: { claims: { "custom:role": "admin", "cognito:groups": ["admin"] } },
};
const nonAdminEvent = (orgId: string) => ({
  identity: { claims: { "custom:organization": orgId } },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listAgentConfigsRegistry — list-from-projection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    dynamoMock.reset();
    process.env = {
      ...originalEnv,
      AGENT_CONFIG_TABLE: "test-agents",
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
    };
    _resetRegistryService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("isListFromProjection returns true when env is 'true'", () => {
    process.env.LIST_FROM_PROJECTION = "true";
    expect(isListFromProjection()).toBe(true);
  });

  test("isListFromProjection returns false when env is absent", () => {
    delete process.env.LIST_FROM_PROJECTION;
    expect(isListFromProjection()).toBe(false);
  });

  test("projection has rows → served from cache, not registry", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    // Projection scan returns rows
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        // Projection scan (FilterExpression has projectionVersion)
        Items: [
          PROJECTION_ROW("rec-1", "Agent1", "org-a"),
          PROJECTION_ROW("rec-2", "Agent2", ""),
        ],
      })
      .resolvesOnce({
        // Legacy scan (full table)
        Items: [LEGACY_DYNAMO_ROW],
      });

    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));

    // Should NOT call registry listResources when projection has data
    expect(mockListResources).not.toHaveBeenCalled();

    // Should include projection rows + legacy row
    const ids = result.map((c) => c.agentId).sort();
    expect(ids).toEqual(["legacy-local", "rec-1", "rec-2"]);
  });

  test("empty projection → falls back to registry", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    // Projection scan returns empty
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [] }) // Projection scan
      .resolves({ Items: [] }); // Legacy scan

    mockListResources.mockResolvedValue([]);

    const result = await listAgentConfigsRegistry(adminEvent);

    // Registry path was called as fallback
    expect(mockListResources).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  test("flag off → registry path used", async () => {
    delete process.env.LIST_FROM_PROJECTION;

    mockListResources.mockResolvedValue([]);
    dynamoMock.on(ScanCommand).resolves({ Items: [] });

    await listAgentConfigsRegistry(adminEvent);

    expect(mockListResources).toHaveBeenCalled();
  });

  test("org filter applied on projection rows", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          PROJECTION_ROW("rec-1", "Agent1", "org-a"),
          PROJECTION_ROW("rec-2", "Agent2", "org-b"), // different org
          PROJECTION_ROW("rec-3", "Agent3", ""), // system-shared
        ],
      })
      .resolvesOnce({ Items: [] });

    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));
    const ids = result.map((c) => c.agentId).sort();
    expect(ids).toEqual(["rec-1", "rec-3"]); // org-b excluded, system-shared included
  });

  test("decision fields present in projection rows", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          PROJECTION_ROW("rec-1", "Agent1", "org-a", {
            decidedBy: "admin-user",
            decidedAt: "2026-10-22T12:00:00.000Z",
            statusReason: "Looks good",
          }),
        ],
      })
      .resolvesOnce({ Items: [] });

    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));
    expect(result).toHaveLength(1);
    expect(result[0].decidedBy).toBe("admin-user");
    expect(result[0].decidedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(result[0].statusReason).toBe("Looks good");
  });

  test("citadelKind filter excludes non-agent projection rows", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    // The FilterExpression in the scan already restricts to citadelKind='agent',
    // so non-agent rows should not appear. We verify the ScanCommand has the
    // correct FilterExpression.
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [PROJECTION_ROW("rec-1", "Agent1", "org-a")],
      })
      .resolvesOnce({ Items: [] });

    await listAgentConfigsRegistry(adminEvent);

    const scanCall = dynamoMock.commandCalls(ScanCommand)[0];
    expect(scanCall.args[0].input.FilterExpression).toContain(
      "attribute_exists",
    );
    expect(scanCall.args[0].input.FilterExpression).toContain("#ck = :ck");
    expect(scanCall.args[0].input.ExpressionAttributeValues).toMatchObject({
      ":ck": "agent",
    });
  });

  test("golden comparison: projection output shape matches registry output shape", async () => {
    // Verify the output shape from projection includes the same fields
    // that the registry path would return
    process.env.LIST_FROM_PROJECTION = "true";

    const projRow = PROJECTION_ROW("rec-1", "Agent1", "org-a", {
      description: "A test agent",
      decidedBy: "admin",
      decidedAt: "2026-10-22T12:00:00.000Z",
      tags: { env: "test" },
    });
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [projRow] })
      .resolvesOnce({ Items: [] });

    const result = await listAgentConfigsRegistry(nonAdminEvent("org-a"));
    expect(result).toHaveLength(1);

    const config = result[0];
    // All fields from the GraphQL AgentConfig type should be present
    expect(config).toHaveProperty("agentId");
    expect(config).toHaveProperty("name");
    expect(config).toHaveProperty("orgId");
    expect(config).toHaveProperty("config");
    expect(config).toHaveProperty("state");
    expect(config).toHaveProperty("categories");
    expect(config).toHaveProperty("createdAt");
    expect(config).toHaveProperty("updatedAt");
    expect(config).toHaveProperty("registryStatus");
    expect(config).toHaveProperty("decidedBy");
    expect(config).toHaveProperty("decidedAt");
    expect(config).toHaveProperty("tags");
  });
});
