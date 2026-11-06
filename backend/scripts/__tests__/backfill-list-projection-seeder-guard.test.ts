/**
 * Tests for the seeder-owned row guard in backfill-list-projection.ts.
 *
 * Verifies that seeder-owned rows (createdBy='seedConfig', projectionVersion
 * present) are never overwritten by PutCommand — only non-ownership fields
 * are updated via merge-only UpdateCommand.
 */

// Environment stubs — must be set before any AWS SDK import
process.env.AWS_REGION = "us-east-1";
process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { RegistryRecord } from "../../src/services/registry-service";

// ---------------------------------------------------------------------------
// aws-sdk-client-mock intercepts at the send() level; no need to mock the
// constructor chain. Just need the mocks established before the module under
// test constructs clients.
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

// Mock readRegistrySequentially so the test never touches AWS.
jest.mock("../lib/registry-sequential-reader", () => ({
  readRegistrySequentially: jest.fn().mockResolvedValue({
    agents: [],
    tools: [],
    errors: 0,
  }),
}));

// Mock RegistryService — only methods actually invoked at runtime
jest.mock("../../src/services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResourceSummaries: jest.fn(),
    listResources: jest.fn(),
    getClient: jest.fn(),
    getRegistryId: jest.fn().mockReturnValue("reg-1"),
    deserializeCustomMetadata: jest
      .fn()
      .mockImplementation(
        (
          json: string | null | undefined,
          defaults: Record<string, unknown>,
        ) => {
          if (json == null || json === "") return defaults;
          try {
            return { ...defaults, ...JSON.parse(json) };
          } catch {
            return defaults;
          }
        },
      ),
    mapToAgentConfig: jest.fn().mockImplementation((record: RegistryRecord) => {
      const meta = record.customDescriptorContent
        ? JSON.parse(record.customDescriptorContent)
        : {};
      return {
        name: record.name ?? "",
        description: record.description ?? "",
        orgId: meta.orgId,
        config: meta.config,
        state: "active",
        categories: meta.categories ?? [],
      };
    }),
    mapToToolConfig: jest.fn().mockReturnValue({
      config: "{}",
      state: "active",
      categories: [],
    }),
  })),
}));

// Mock citadel-kind
jest.mock("../../src/utils/citadel-kind", () => ({
  resolveKind: jest.fn().mockReturnValue("agent"),
}));

import { runProjectionBackfill } from "../backfill-list-projection";
import { readRegistrySequentially } from "../lib/registry-sequential-reader";

const SEEDER_ROW = {
  agentId: "mjaKkVyqoFGN",
  name: "demo-echo-agent",
  createdBy: "seedConfig",
  projectionVersion: 1,
  config: {
    name: "demo-echo-agent",
    filename: "demo_echo_agent.py",
    schema: { type: "object" },
    action: { type: "sqs", target: "queue-url" },
  },
  orgId: "All Organizations",
  citadelKind: "agent",
  state: "active",
  categories: ["built-in"],
};

const NON_SEEDER_ROW = {
  agentId: "obEoj56JCATf",
  name: "my-custom-agent",
  createdBy: "user@example.com",
  projectionVersion: 1,
  config: { description: "Custom agent" },
  orgId: "Default",
  citadelKind: "agent",
  state: "active",
  categories: [],
};

function makeRecord(
  id: string,
  name: string,
  overrides: Partial<RegistryRecord> = {},
): RegistryRecord {
  return {
    recordId: id,
    name,
    description: `${name} description`,
    status: "APPROVED",
    registryId: "reg-1",
    recordType: "CUSTOM",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-10-01"),
    customDescriptorContent: JSON.stringify({
      config: { name, filename: `${name}.py` },
      createdBy: "seedConfig",
      orgId: "All Organizations",
      categories: ["built-in"],
    }),
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  sqsMock.on(SendMessageCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});
  // Default: no pointer rows exist (scanPointerTargetIds returns empty set)
  ddbMock.on(ScanCommand).resolves({ Items: [] });
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("backfill-list-projection: seeder-owned row guard", () => {
  it("uses merge-only UpdateCommand for seeder-owned rows, never PutCommand", async () => {
    // Arrange: one seeder-owned agent
    const seederRecord = makeRecord("mjaKkVyqoFGN", "demo-echo-agent");
    (readRegistrySequentially as jest.Mock).mockResolvedValue({
      agents: [seederRecord],
      tools: [],
      errors: 0,
    });

    // GetCommand returns a seeder-owned row
    ddbMock.on(GetCommand).resolves({ Item: { ...SEEDER_ROW } });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    // Act
    const counters = await runProjectionBackfill(
      "reg-1",
      "test-agents",
      "test-tools",
      false, // apply mode
      0,
      0,
    );

    // Assert: UpdateCommand was used (merge-only), NOT PutCommand
    const putCalls = ddbMock.commandCalls(PutCommand);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);

    expect(putCalls).toHaveLength(0);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(counters.agents).toBe(1);
    expect(counters.errors).toBe(0);
  });

  it("uses PutCommand for non-seeder-owned rows", async () => {
    // Arrange: one non-seeder-owned agent
    const record = makeRecord("obEoj56JCATf", "my-custom-agent", {
      customDescriptorContent: JSON.stringify({
        config: { description: "Custom agent" },
        createdBy: "user@example.com",
        orgId: "Default",
        categories: [],
      }),
    });
    (readRegistrySequentially as jest.Mock).mockResolvedValue({
      agents: [record],
      tools: [],
      errors: 0,
    });

    // GetCommand returns a non-seeder-owned row
    ddbMock.on(GetCommand).resolves({ Item: { ...NON_SEEDER_ROW } });
    ddbMock.on(PutCommand).resolves({});

    // Act
    const counters = await runProjectionBackfill(
      "reg-1",
      "test-agents",
      "test-tools",
      false,
      0,
      0,
    );

    // Assert: PutCommand was used
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    expect(counters.agents).toBe(1);
  });

  it("seeder-owned row keeps config, orgId, citadelKind after backfill", async () => {
    // This is the core regression test for the incident.
    const seederRecord = makeRecord("mjaKkVyqoFGN", "demo-echo-agent");
    (readRegistrySequentially as jest.Mock).mockResolvedValue({
      agents: [seederRecord],
      tools: [],
      errors: 0,
    });

    ddbMock.on(GetCommand).resolves({ Item: { ...SEEDER_ROW } });
    ddbMock.on(UpdateCommand).resolves({});

    await runProjectionBackfill(
      "reg-1",
      "test-agents",
      "test-tools",
      false,
      0,
      0,
    );

    // The UpdateCommand must NOT set config, orgId, or citadelKind
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    const updateInput = updateCalls[0].args[0].input;
    const updateExpr = updateInput.UpdateExpression as string;

    // These fields must NOT appear in the SET clause
    expect(updateExpr).not.toContain("#config");
    expect(updateExpr).not.toContain("#orgId");
    expect(updateExpr).not.toContain("#citadelKind");
    expect(updateExpr).not.toContain("#projectionVersion");

    // These fields SHOULD appear (merge-only)
    expect(updateExpr).toContain("#updatedAt");
    expect(updateExpr).toContain("#projectedAt");
  });

  it("dry-run logs seeder-owned merge-only without writing", async () => {
    const seederRecord = makeRecord("mjaKkVyqoFGN", "demo-echo-agent");
    (readRegistrySequentially as jest.Mock).mockResolvedValue({
      agents: [seederRecord],
      tools: [],
      errors: 0,
    });

    ddbMock.on(GetCommand).resolves({ Item: { ...SEEDER_ROW } });

    const counters = await runProjectionBackfill(
      "reg-1",
      "test-agents",
      "test-tools",
      true, // dry-run
      0,
      0,
    );

    // No DDB writes at all (GetCommand is read-only)
    const putCalls = ddbMock.commandCalls(PutCommand);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(putCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);

    // But the counter is incremented
    expect(counters.agents).toBe(1);

    // And the dry-run log was emitted
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("seeder-owned: merge-only"),
    );
  });

  it("maps empty orgId to All Organizations for seeder-owned registry descriptors on new rows", async () => {
    const record = makeRecord("newAgentId123", "demo-echo-agent", {
      customDescriptorContent: JSON.stringify({
        config: { name: "demo-echo-agent" },
        createdBy: "seedConfig",
        orgId: "",
        categories: ["built-in"],
      }),
    });
    (readRegistrySequentially as jest.Mock).mockResolvedValue({
      agents: [record],
      tools: [],
      errors: 0,
    });

    // No existing row (first-time write)
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    await runProjectionBackfill(
      "reg-1",
      "test-agents",
      "test-tools",
      false,
      0,
      0,
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
    expect(item.orgId).toBe("All Organizations");
    expect(item.orgUnknown).toBeUndefined();
  });
});
