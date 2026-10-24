/**
 * Tests for listToolConfigsRegistry — list-from-projection path (CIT-244).
 *
 * Covers: projection has rows → list served from cache; empty projection →
 * fallback to registry; flag off → registry; org filter on projection;
 * decision fields present after a decision.
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock CloudWatch
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
const mockMapToToolConfig = jest.fn((record: Record<string, unknown>) => {
  const meta = JSON.parse((record.customDescriptorContent as string) ?? "{}");
  return {
    toolId: record.recordId,
    orgId: typeof meta.orgId === "string" ? meta.orgId : "",
    config: record.description || "{}",
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
    mapToToolConfig: mockMapToToolConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    DEPRECATED: "DEPRECATED",
  },
  decideRecord: jest.fn(),
  DECISION_STATUSES: new Set(["APPROVED", "REJECTED"]),
}));

import {
  listToolConfigsRegistry,
  _resetRegistryService,
} from "../tool-config-resolver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL_PROJECTION_ROW = (
  toolId: string,
  name: string,
  orgId: string,
  extra: Record<string, unknown> = {},
) => ({
  toolId,
  orgId,
  config: JSON.stringify({ name }),
  state: "active",
  categories: ["worker"],
  registryStatus: "APPROVED",
  citadelKind: "tool",
  projectionVersion: 1,
  projectedAt: "2026-10-23T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  ...extra,
});

const adminEvent = {
  identity: { claims: { "custom:role": "admin", "cognito:groups": ["admin"] } },
};
const nonAdminEvent = (orgId: string) => ({
  identity: { claims: { "custom:organization": orgId } },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listToolConfigsRegistry — list-from-projection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    dynamoMock.reset();
    process.env = {
      ...originalEnv,
      TOOLS_CONFIG_TABLE: "test-tools",
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
    };
    _resetRegistryService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("projection has rows → served from cache, not registry", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "SearchTool", "org-a"),
          TOOL_PROJECTION_ROW("tool-2", "AnalysisTool", "org-a"),
        ],
      })
      .resolvesOnce({ Items: [] }); // Legacy scan

    // GetCommand for enrichWithDecision — no decision rows
    dynamoMock.on(GetCommand).resolves({ Item: undefined });

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));

    expect(mockListResources).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.toolId).sort()).toEqual(["tool-1", "tool-2"]);
  });

  test("empty projection → falls back to registry", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [] }) // Projection scan
      .resolves({ Items: [] }); // Legacy scan

    mockListResources.mockResolvedValue([]);

    const result = await listToolConfigsRegistry(adminEvent);

    expect(mockListResources).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  test("flag off → registry path used", async () => {
    delete process.env.LIST_FROM_PROJECTION;

    mockListResources.mockResolvedValue([]);
    dynamoMock.on(ScanCommand).resolves({ Items: [] });

    await listToolConfigsRegistry(adminEvent);

    expect(mockListResources).toHaveBeenCalled();
  });

  test("org filter applied on projection rows", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "T1", "org-a"),
          TOOL_PROJECTION_ROW("tool-2", "T2", "org-b"),
        ],
      })
      .resolvesOnce({ Items: [] });

    dynamoMock.on(GetCommand).resolves({ Item: undefined });

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));
    expect(result.map((c) => c.toolId)).toEqual(["tool-1"]);
  });

  test("decision fields present in projection rows", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "T1", "org-a", {
            decidedBy: "admin-user",
            decidedAt: "2026-10-22T12:00:00.000Z",
            statusReason: "LGTM",
          }),
        ],
      })
      .resolvesOnce({ Items: [] });

    // enrichWithDecision should see decidedBy already set and skip fetch
    dynamoMock.on(GetCommand).resolves({ Item: undefined });

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));
    expect(result).toHaveLength(1);
    expect(result[0].decidedBy).toBe("admin-user");
    expect(result[0].decidedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(result[0].statusReason).toBe("LGTM");
  });

  test("golden comparison: projection output shape matches expected fields", async () => {
    process.env.LIST_FROM_PROJECTION = "true";

    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "T1", "org-a", {
            decidedBy: "admin",
            decidedAt: "2026-10-22T12:00:00.000Z",
            tags: { team: "platform" },
          }),
        ],
      })
      .resolvesOnce({ Items: [] });

    dynamoMock.on(GetCommand).resolves({ Item: undefined });

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));
    expect(result).toHaveLength(1);

    const config = result[0];
    expect(config).toHaveProperty("toolId");
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
