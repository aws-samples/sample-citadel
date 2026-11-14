/**
 * Regression test: findProjectAgentRecords must return agent records ONLY.
 *
 * PR #534 replaced listResourcesChecked('agent') — which filtered by kind —
 * with a GSI query + getResource that has NO record-kind filter. A project's
 * APP record (e.g. the Energy-Settlements app, DRAFT, same sourceProjectId)
 * leaks through, and activateProjectAgents would submit the app for approval.
 *
 * These tests assert:
 *   1. findProjectAgentRecords drops non-agent records (app, tool).
 *   2. activateProjectAgents never calls submitForApproval for an app id.
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

// ── Mock trust-path ───────────────────────────────────────────────────────
jest.mock("../../utils/trust-path", () => ({
  ...jest.requireActual("../../utils/trust-path"),
  computeTrustPath: jest.fn(),
  assumeAnalysisRoleClient: jest.fn(),
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
  activateProjectAgents,
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

/** Creates a registry record whose citadelKind is 'agent'. */
function agentRecord(recordId: string) {
  return {
    recordId,
    name: `Agent ${recordId}`,
    description: "desc",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      citadelKind: "agent",
      sourceProjectId: "proj-123",
      orgId: "org-a",
    }),
  };
}

/** Creates a registry record whose citadelKind is 'app'. */
function appRecord(recordId: string) {
  return {
    recordId,
    name: `App ${recordId}`,
    description: "desc",
    status: "DRAFT",
    customDescriptorContent: JSON.stringify({
      citadelKind: "app",
      sourceProjectId: "proj-123",
      orgId: "org-a",
      appId: "energy-settlements",
      manifest: { agentBindings: [] },
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("findProjectAgentRecords — kind filtering", () => {
  test("GSI returns an agent row and an app row → result contains only the agent", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [gsiRow("a1", "rec-agent"), gsiRow("a2", "rec-app")],
    });

    mockGetResource
      .mockResolvedValueOnce(agentRecord("rec-agent"))
      .mockResolvedValueOnce(appRecord("rec-app"));

    const result = await findProjectAgentRecords("proj-123");

    // Only the agent record must be returned
    expect(result).toHaveLength(1);
    expect(result[0].recordId).toBe("rec-agent");
  });

  test("all records are apps → returns empty array", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [gsiRow("a1", "rec-app-1"), gsiRow("a2", "rec-app-2")],
    });

    mockGetResource
      .mockResolvedValueOnce(appRecord("rec-app-1"))
      .mockResolvedValueOnce(appRecord("rec-app-2"));

    const result = await findProjectAgentRecords("proj-123");

    expect(result).toHaveLength(0);
  });
});

describe("activateProjectAgents — kind safety", () => {
  test("never calls submitForApproval for an app record id", async () => {
    dynamoMock.on(QueryCommand).resolves({
      Items: [gsiRow("a1", "rec-agent"), gsiRow("a2", "rec-app")],
    });

    mockGetResource
      .mockResolvedValueOnce(agentRecord("rec-agent"))
      .mockResolvedValueOnce(appRecord("rec-app"));

    // submitForApproval returns a post-submit record
    mockSubmitForApproval.mockResolvedValue({
      recordId: "rec-agent",
      status: "APPROVED",
    });

    const result = await activateProjectAgents("proj-123");

    // submitForApproval must be called ONLY for the agent, never for the app
    expect(mockSubmitForApproval).toHaveBeenCalledTimes(1);
    expect(mockSubmitForApproval).toHaveBeenCalledWith("rec-agent");
    expect(mockSubmitForApproval).not.toHaveBeenCalledWith("rec-app");

    // The agent should be activated; the app should not appear anywhere
    expect(result.activated).toContain("Agent rec-agent");
    expect(result.failed).not.toContain("App rec-app");
    expect(result.alreadyActive).not.toContain("App rec-app");
  });
});
