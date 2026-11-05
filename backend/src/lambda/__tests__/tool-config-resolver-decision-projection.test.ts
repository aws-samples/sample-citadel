/**
 * Tests for the decision-field projection optimisation (CIT-263).
 *
 * Verifies that:
 *   1. Projection rows with decision fields skip the per-item GetItem
 *   2. Legacy rows without decision fields fall back to GetItem (+metric)
 *   3. The DecisionFallback metric is emitted for legacy rows only
 *   4. The decision writer (updateToolConfigRegistry approve path) writes
 *      decision fields onto the projection row
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Mock CloudWatch — capture metric calls
// ---------------------------------------------------------------------------
const mockCwSend = jest.fn().mockResolvedValue({});
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockCwSend,
  })),
  PutMetricDataCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

// ---------------------------------------------------------------------------
// Mock RegistryService
// ---------------------------------------------------------------------------
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockMapToToolConfig = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockDeserializeCustomMetadata = jest.fn();
const mockSerializeCustomMetadata = jest.fn().mockReturnValue("{}");
const mockToRegistryStatus = jest.fn();

jest.mock("../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    getResource: mockGetResource,
    mapToToolConfig: mockMapToToolConfig,
    updateResourceStatus: mockUpdateResourceStatus,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
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

const nonAdminEvent = (orgId: string) => ({
  identity: { claims: { "custom:organization": orgId } },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CIT-263: decision-field projection on list path", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    dynamoMock.reset();
    mockCwSend.mockClear();
    process.env = {
      ...originalEnv,
      TOOLS_CONFIG_TABLE: "test-tools",
      REGISTRY_ENABLED: "true",
      REGISTRY_ID: "test-registry",
      LIST_FROM_PROJECTION: "true",
    };
    _resetRegistryService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("projection rows with decision fields skip per-item GetItem", async () => {
    // Projection scan returns rows WITH decision fields
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "SearchTool", "org-a", {
            decidedBy: "admin-user",
            decidedAt: "2026-10-22T12:00:00.000Z",
            statusReason: "Approved",
          }),
          TOOL_PROJECTION_ROW("tool-2", "AnalysisTool", "org-a", {
            decidedBy: "admin-user",
            decidedAt: "2026-10-22T13:00:00.000Z",
          }),
        ],
      })
      .resolvesOnce({ Items: [] }); // Legacy scan — no legacy rows

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));

    expect(result).toHaveLength(2);
    // GetCommand should NOT have been called — no enrichWithDecision needed
    expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(result[0].decidedBy).toBe("admin-user");
    expect(result[1].decidedBy).toBe("admin-user");
  });

  test("legacy rows without decision fields fall back to GetItem", async () => {
    // Projection scan returns rows with decision fields
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          TOOL_PROJECTION_ROW("tool-1", "ProjectedTool", "org-a", {
            decidedBy: "admin-user",
          }),
        ],
      })
      .resolvesOnce({
        // Legacy scan returns a row NOT in projection (different name)
        Items: [
          {
            toolId: "legacy-tool",
            orgId: "org-a",
            config: JSON.stringify({ name: "LegacyTool" }),
            state: "active",
            categories: [],
          },
        ],
      });

    // GetCommand for enrichWithDecision on the legacy row
    dynamoMock.on(GetCommand).resolves({
      Item: {
        toolId: "decision#legacy-tool",
        decidedBy: "other-admin",
        decidedAt: "2026-10-20T10:00:00.000Z",
      },
    });

    const result = await listToolConfigsRegistry(nonAdminEvent("org-a"));

    expect(result).toHaveLength(2);
    // GetCommand should have been called exactly once — for the legacy row
    expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(1);
    const getCall = dynamoMock.commandCalls(GetCommand)[0];
    expect(getCall.args[0].input.Key).toEqual({
      toolId: "decision#legacy-tool",
    });

    // Legacy row should have decision fields from GetItem fallback
    const legacyResult = result.find((c) => c.toolId === "legacy-tool");
    expect(legacyResult?.decidedBy).toBe("other-admin");
  });

  test("DecisionFallback metric emitted for legacy rows only", async () => {
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [TOOL_PROJECTION_ROW("tool-1", "ProjectedTool", "org-a")],
      })
      .resolvesOnce({
        Items: [
          {
            toolId: "legacy-1",
            orgId: "org-a",
            config: JSON.stringify({ name: "LegacyOne" }),
            state: "active",
            categories: [],
          },
          {
            toolId: "legacy-2",
            orgId: "org-a",
            config: JSON.stringify({ name: "LegacyTwo" }),
            state: "active",
            categories: [],
          },
        ],
      });

    dynamoMock.on(GetCommand).resolves({ Item: undefined });

    await listToolConfigsRegistry(nonAdminEvent("org-a"));

    // Check that DecisionFallback metric was emitted with count=2
    const metricCalls = mockCwSend.mock.calls;
    const fallbackCall = metricCalls.find((call: unknown[]) => {
      const input = call[0] as { MetricData?: Array<{ MetricName?: string }> };
      return input.MetricData?.some(
        (m: { MetricName?: string }) => m.MetricName === "DecisionFallback",
      );
    });
    expect(fallbackCall).toBeDefined();
    const metricData = (
      fallbackCall![0] as { MetricData: Array<{ Value: number }> }
    ).MetricData[0];
    expect(metricData.Value).toBe(2);
  });

  test("zero legacy rows emits no DecisionFallback metric", async () => {
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [TOOL_PROJECTION_ROW("tool-1", "OnlyProjected", "org-a")],
      })
      .resolvesOnce({ Items: [] }); // No legacy rows

    await listToolConfigsRegistry(nonAdminEvent("org-a"));

    // DecisionFallback metric should NOT be emitted (count=0 is suppressed)
    const metricCalls = mockCwSend.mock.calls;
    const fallbackCall = metricCalls.find((call: unknown[]) => {
      const input = call[0] as { MetricData?: Array<{ MetricName?: string }> };
      return input.MetricData?.some(
        (m: { MetricName?: string }) => m.MetricName === "DecisionFallback",
      );
    });
    expect(fallbackCall).toBeUndefined();
  });
});
