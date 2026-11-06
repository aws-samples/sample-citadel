/**
 * Tests for the seeder guard in registry-sync's handleGaUpsert (CIT-272).
 *
 * When an existing recordId-keyed row has createdBy='seedConfig' and
 * projectionVersion set, handleGaUpsert must update ONLY approval/status
 * fields — never overwrite config, orgId, or projection metadata.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { RegistryRecord } from "../../services/registry-service";

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => ({
      getResource: jest.fn(),
    })),
  };
});

import {
  handleGaUpsert,
  syncSeederOwnedRow,
  PROJECTION_VERSION,
} from "../registry-sync";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

const TABLE = "test-agents-table";
const RECORD_ID = "mjaKkVyqoFGN";

function makeRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    recordId: RECORD_ID,
    name: "demo-echo-agent",
    description: "Demo agent",
    status: "APPROVED",
    registryId: "test-registry-id",
    recordType: "CUSTOM",
    createdAt: new Date("2026-09-26T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    customDescriptorContent: JSON.stringify({
      config: { description: "Demo agent" },
      createdBy: "seedConfig",
      orgId: "All Organizations",
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
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// syncSeederOwnedRow
// ---------------------------------------------------------------------------
describe("syncSeederOwnedRow", () => {
  it("updates only approval/status fields, never config", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const record = makeRecord({ status: "APPROVED" });
    await syncSeederOwnedRow(TABLE, RECORD_ID, record);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0].args[0].input;
    const expr = input.UpdateExpression as string;
    // Must set registryStatus and state
    expect(expr).toContain("registryStatus");
    expect(expr).toContain("state");
    // Must NOT set config, orgId, citadelKind, projectionVersion
    expect(expr).not.toContain("config");
    expect(expr).not.toContain("orgId");
    expect(expr).not.toContain("citadelKind");
    expect(expr).not.toContain("projectionVersion");
  });
});

// ---------------------------------------------------------------------------
// handleGaUpsert — seeder guard
// ---------------------------------------------------------------------------
describe("handleGaUpsert seeder guard", () => {
  it("uses syncSeederOwnedRow when existing row is seeder-owned", async () => {
    // GetCommand for the seeder guard check returns a seeder-owned row
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: RECORD_ID,
        createdBy: "seedConfig",
        projectionVersion: PROJECTION_VERSION,
      },
    });
    // UpdateCommand for syncSeederOwnedRow succeeds
    ddbMock.on(UpdateCommand).resolves({});

    const record = makeRecord({ status: "APPROVED" });
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Should NOT have written a full PutCommand (projection row)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);

    // Should have done an UpdateCommand (syncSeederOwnedRow)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const expr = updateCalls[0].args[0].input.UpdateExpression as string;
    // Approval fields present, config absent
    expect(expr).toContain("registryStatus");
    expect(expr).not.toContain("config");
  });

  it("falls through to standard merge when row is NOT seeder-owned", async () => {
    // GetCommand returns a row without createdBy='seedConfig'
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: RECORD_ID,
        createdBy: "fabricator",
        projectionVersion: PROJECTION_VERSION,
      },
    });
    // Standard merge path: UpdateCommand + PutCommand
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const record = makeRecord({ status: "APPROVED" });
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Standard path writes a PutCommand (projection row)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls through to standard merge when row does not exist", async () => {
    // GetCommand returns no item
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const record = makeRecord();
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Standard path writes a PutCommand (projection row)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not apply seeder guard for tool resources", async () => {
    // Tool resources should never hit the seeder guard path
    ddbMock.on(GetCommand).resolves({
      Item: {
        toolId: "some-tool",
        createdBy: "seedConfig",
        projectionVersion: 1,
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const record = makeRecord({ recordId: "tool-123" });
    await handleGaUpsert("test-tools-table", "tool", "tool-123", record);

    // Should not have checked the seeder guard (no GetCommand for tools)
    // The standard merge path runs: UpdateCommand + PutCommand
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("uses syncSeederOwnedRow when row is damaged (no createdBy) but has a pointer", async () => {
    // GetCommand: first call returns the damaged canonical row (no createdBy),
    // second call returns the pointer row keyed by name.
    ddbMock
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: RECORD_ID },
      })
      .resolves({
        Item: {
          agentId: RECORD_ID,
          projectionVersion: PROJECTION_VERSION,
          // createdBy is MISSING — this is the damage scenario
        },
      })
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: "demo-echo-agent" },
      })
      .resolves({
        Item: {
          agentId: "demo-echo-agent",
          _canonicalRecordId: RECORD_ID,
        },
      });
    // UpdateCommand for syncSeederOwnedRow succeeds
    ddbMock.on(UpdateCommand).resolves({});

    const record = makeRecord({ status: "APPROVED" });
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Should NOT have written a full PutCommand
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);

    // Should have done an UpdateCommand (syncSeederOwnedRow)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const expr = updateCalls[0].args[0].input.UpdateExpression as string;
    expect(expr).toContain("registryStatus");
    expect(expr).not.toContain("config");
  });

  it("falls through when row is damaged AND has no pointer", async () => {
    // GetCommand: canonical row is damaged, pointer row does not exist
    ddbMock
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: RECORD_ID },
      })
      .resolves({
        Item: {
          agentId: RECORD_ID,
          projectionVersion: PROJECTION_VERSION,
        },
      })
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: "demo-echo-agent" },
      })
      .resolves({}); // no item — no pointer
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const record = makeRecord();
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Standard merge path runs
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("detects seeder-owned via pointer even when many rows precede it (old Scan+Limit=1 bug)", async () => {
    // The old ScanCommand with Limit=1 would evaluate ONE item before
    // filtering — if the pointer wasn't that item, it was missed.
    // The new GetCommand-by-name approach hits the pointer directly.
    ddbMock
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: RECORD_ID },
      })
      .resolves({
        Item: {
          agentId: RECORD_ID,
          projectionVersion: PROJECTION_VERSION,
          // createdBy is MISSING — must rely on pointer fallback
        },
      })
      .on(GetCommand, {
        TableName: TABLE,
        Key: { agentId: "demo-echo-agent" },
      })
      .resolves({
        Item: {
          agentId: "demo-echo-agent",
          _canonicalRecordId: RECORD_ID,
        },
      });
    ddbMock.on(UpdateCommand).resolves({});

    const record = makeRecord({ status: "DRAFT" });
    await handleGaUpsert(TABLE, "agent", RECORD_ID, record);

    // Must have taken the syncSeederOwnedRow path (no PutCommand)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);

    // syncSeederOwnedRow writes an UpdateCommand with approval fields only
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const expr = updateCalls[0].args[0].input.UpdateExpression as string;
    expect(expr).toContain("registryStatus");
    expect(expr).not.toContain("config");
  });
});
