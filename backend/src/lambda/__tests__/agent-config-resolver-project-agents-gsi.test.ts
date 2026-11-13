/**
 * Tests for the GSI-based findProjectAgentRecords path.
 *
 * After the fix, findProjectAgentRecords must:
 *   1. Query the DDB GSI sourceProjectId-index (NOT call listResourcesChecked)
 *   2. Issue exactly N getResource calls (one per GSI result) for full records
 *   3. Return only records belonging to the requested project
 *   4. Respect orgId filtering (same as before)
 *   5. Emit structured logs with registry call counts
 */
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

// ── Mock RegistryService ──────────────────────────────────────────────────
const mockGetResource = jest.fn();
const mockListResources = jest.fn();
const mockListResourcesChecked = jest.fn();
const mockSubmitForApproval = jest.fn();
const mockUpdateResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
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
const mockToRegistryStatus = jest.fn((state: string) =>
  state === "active" ? "APPROVED" : "DRAFT",
);
const mockMapToAgentConfig = jest.fn(
  (record: { recordId: string; description?: string }) => ({
    agentId: record.recordId,
    config: record.description || "",
    state: "active",
    categories: [],
  }),
);

jest.mock("../../services/registry-service", () => {
  const MockRS = jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    updateResourceStatus: mockUpdateResourceStatus,
    submitForApproval: mockSubmitForApproval,
    listResources: mockListResources,
    listResourcesChecked: mockListResourcesChecked,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
  }));
  MockRS.isThrottlingError = (err: unknown): boolean => {
    const name = (err as { name?: string })?.name ?? "";
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    return (
      name === "ThrottlingException" ||
      name === "TooManyRequestsException" ||
      statusCode === 429
    );
  };
  return {
    __esModule: true,
    RegistryService: MockRS,
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
    RegistryThrottledError: class RegistryThrottledError extends Error {
      retryable = true;
      retryAfterMs: number;
      constructor(message: string, retryAfterMs = 5000) {
        super(message);
        this.name = "RegistryThrottledError";
        this.retryAfterMs = retryAfterMs;
      }
    },
  };
});

// ── Mock trust-path (needed by activateProjectAgents imports) ─────────────
const mockComputeTrustPath = jest.fn();
const mockAssumeAnalysisRoleClient = jest.fn();
jest.mock("../../utils/trust-path", () => ({
  ...jest.requireActual("../../utils/trust-path"),
  computeTrustPath: mockComputeTrustPath,
  assumeAnalysisRoleClient: mockAssumeAnalysisRoleClient,
}));

// ── Mock governance-flag ──────────────────────────────────────────────────
jest.mock("../../utils/governance-flag", () => ({
  getGovernanceEnforce: jest.fn().mockResolvedValue("permissive"),
}));

// ── Mock events ───────────────────────────────────────────────────────────
jest.mock("../../utils/events", () => ({
  publishEvent: jest.fn(),
}));

// ── Mock CloudWatch ───────────────────────────────────────────────────────
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  PutMetricDataCommand: jest.fn(),
}));

// ── Env ───────────────────────────────────────────────────────────────────
process.env.AGENT_CONFIG_TABLE = "test-agents";
process.env.REGISTRY_ENABLED = "true";
process.env.REGISTRY_ID = "test-registry";

import {
  findProjectAgentRecords,
  _resetRegistryService,
} from "../agent-config-resolver";

beforeEach(() => {
  jest.clearAllMocks();
  dynamoMock.reset();
  _resetRegistryService();
});

// ── Helpers ───────────────────────────────────────────────────────────────

function gsiRow(
  agentId: string,
  registryRecordId: string,
  extra?: Record<string, unknown>,
) {
  return {
    agentId,
    registryRecordId,
    sourceProjectId: "proj-123",
    registryStatus: "DRAFT",
    orgId: "org-a",
    name: `Agent ${agentId}`,
    ...extra,
  };
}

function registryRecord(
  recordId: string,
  sourceProjectId: string,
  orgId = "org-a",
) {
  return {
    recordId,
    name: `Agent ${recordId}`,
    description: "desc",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      citadelKind: "agent",
      sourceProjectId,
      orgId,
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("findProjectAgentRecords — GSI path", () => {
  test("queries GSI instead of calling listResourcesChecked", async () => {
    // GSI returns 3 rows for the project
    dynamoMock.on(QueryCommand).resolves({
      Items: [
        gsiRow("a1", "rec-1"),
        gsiRow("a2", "rec-2"),
        gsiRow("a3", "rec-3"),
      ],
    });

    // getResource returns full records for each
    mockGetResource
      .mockResolvedValueOnce(registryRecord("rec-1", "proj-123"))
      .mockResolvedValueOnce(registryRecord("rec-2", "proj-123"))
      .mockResolvedValueOnce(registryRecord("rec-3", "proj-123"));

    const result = await findProjectAgentRecords("proj-123");

    // MUST NOT call listResourcesChecked
    expect(mockListResourcesChecked).not.toHaveBeenCalled();
    expect(mockListResources).not.toHaveBeenCalled();

    // Must have queried DDB with the GSI
    const queryCalls = dynamoMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const queryInput = queryCalls[0].args[0].input;
    expect(queryInput.IndexName).toBe("sourceProjectId-index");
    expect(queryInput.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":pid": "proj-123" }),
    );

    // Must call getResource exactly 3 times (once per GSI hit)
    expect(mockGetResource).toHaveBeenCalledTimes(3);
    // Each call passes "agent" as the type
    expect(mockGetResource).toHaveBeenCalledWith("agent", "rec-1");
    expect(mockGetResource).toHaveBeenCalledWith("agent", "rec-2");
    expect(mockGetResource).toHaveBeenCalledWith("agent", "rec-3");

    // Must return 3 records
    expect(result).toHaveLength(3);
  });

  test("returns empty array when GSI returns no rows", async () => {
    dynamoMock.on(QueryCommand).resolves({ Items: [] });

    const result = await findProjectAgentRecords("proj-empty");

    expect(result).toHaveLength(0);
    expect(mockGetResource).not.toHaveBeenCalled();
    expect(mockListResourcesChecked).not.toHaveBeenCalled();
  });

  test("skips GSI rows without registryRecordId", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [
        gsiRow("a1", "rec-1"),
        { agentId: "a2", sourceProjectId: "proj-123", orgId: "org-a" }, // no registryRecordId
        gsiRow("a3", "rec-3"),
      ],
    });
    mockGetResource
      .mockResolvedValueOnce(registryRecord("rec-1", "proj-123"))
      .mockResolvedValueOnce(registryRecord("rec-3", "proj-123"));

    const result = await findProjectAgentRecords("proj-123");

    expect(mockGetResource).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  test("filters by orgId when provided", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [
        gsiRow("a1", "rec-1", { orgId: "org-a" }),
        gsiRow("a2", "rec-2", { orgId: "org-b" }),
        gsiRow("a3", "rec-3", { orgId: "" }), // system-shared
        gsiRow("a4", "rec-4", { orgId: "All Organizations" }),
      ],
    });
    mockGetResource
      .mockResolvedValueOnce(registryRecord("rec-1", "proj-123", "org-a"))
      .mockResolvedValueOnce(registryRecord("rec-3", "proj-123", ""))
      .mockResolvedValueOnce(
        registryRecord("rec-4", "proj-123", "All Organizations"),
      );

    const result = await findProjectAgentRecords("proj-123", "org-a");

    // rec-2 (org-b) must be excluded
    expect(result).toHaveLength(3);
    // getResource called only for rows that pass org filter
    expect(mockGetResource).toHaveBeenCalledTimes(3);
  });

  test("drops individual records that fail getResource (non-throttle)", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [gsiRow("a1", "rec-1"), gsiRow("a2", "rec-2")],
    });
    mockGetResource
      .mockResolvedValueOnce(registryRecord("rec-1", "proj-123"))
      .mockRejectedValueOnce(new Error("ResourceNotFoundException"));

    const result = await findProjectAgentRecords("proj-123");

    // Only rec-1 returned; rec-2 dropped silently
    expect(result).toHaveLength(1);
    expect(result[0].recordId).toBe("rec-1");
  });
});
