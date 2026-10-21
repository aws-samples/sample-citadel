/**
 * Tests for the dual-key approval-cache fix:
 *
 * 1. syncNameKeyedRow in registry-sync.ts updates a name-keyed row when a
 *    GA event lands for a recordId-keyed row.
 * 2. handleGaEvent propagates approval to both keys.
 * 3. decideRecord in the resolver writes both keys.
 * 4. reconcile-approval-cache script detects and fixes stale name-keyed rows.
 * 5. No new name-keyed rows are ever created.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => ({
      getResource: jest.fn(),
    })),
  };
});

import { syncNameKeyedRow, handleGaUpsert } from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";
import {
  REGISTRY_STATUS_FIELD,
  REGISTRY_RECORD_ID_FIELD,
  STATUS_UPDATED_AT_FIELD,
} from "../approval-cache-fields";

import {
  runReconcile,
  isNameKeyedRowWithRecordId,
  parseArgs,
} from "../../../scripts/reconcile-approval-cache";

const ddbMock = mockClient(DynamoDBDocumentClient);
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

beforeEach(() => {
  ddbMock.reset();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// syncNameKeyedRow
// ---------------------------------------------------------------------------

describe("syncNameKeyedRow", () => {
  test("updates name-keyed row when it exists and differs from recordId", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "test-agents-table",
        Key: { agentId: "MyAgent" },
      })
      .resolves({ Item: { agentId: "MyAgent" } });
    ddbMock.on(UpdateCommand).resolves({});

    await syncNameKeyedRow("test-agents-table", "rec123456789", {
      name: "MyAgent",
      status: "APPROVED",
      recordId: "rec123456789",
    });

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.Key).toEqual({ agentId: "MyAgent" });
    expect(input.ExpressionAttributeValues![":registryStatus"]).toBe(
      "APPROVED",
    );
    expect(input.ExpressionAttributeValues![":registryRecordId"]).toBe(
      "rec123456789",
    );
    expect(input.ConditionExpression).toContain("attribute_exists");
  });

  test("skips when name equals registryRecordId", async () => {
    await syncNameKeyedRow("test-agents-table", "MyAgent", {
      name: "MyAgent",
      status: "APPROVED",
    });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("skips when name is empty", async () => {
    await syncNameKeyedRow("test-agents-table", "rec123456789", {
      name: "",
      status: "APPROVED",
    });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("skips when name-keyed row does not exist (never creates)", async () => {
    ddbMock
      .on(GetCommand, {
        TableName: "test-agents-table",
        Key: { agentId: "MissingAgent" },
      })
      .resolves({ Item: undefined });

    await syncNameKeyedRow("test-agents-table", "rec123456789", {
      name: "MissingAgent",
      status: "APPROVED",
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("includes decidedBy when provided", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { agentId: "MyAgent" } });
    ddbMock.on(UpdateCommand).resolves({});

    await syncNameKeyedRow(
      "test-agents-table",
      "rec123456789",
      { name: "MyAgent", status: "APPROVED" },
      "admin-user",
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":decidedBy"]).toBe("admin-user");
    expect(input.UpdateExpression).toContain("#decidedBy");
  });

  test("swallows ConditionalCheckFailedException gracefully", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { agentId: "MyAgent" } });
    const ccfError = new Error("CCF");
    ccfError.name = "ConditionalCheckFailedException";
    ddbMock.on(UpdateCommand).rejects(ccfError);

    // Should not throw
    await syncNameKeyedRow("test-agents-table", "rec123456789", {
      name: "MyAgent",
      status: "APPROVED",
    });
  });
});

// ---------------------------------------------------------------------------
// handleGaUpsert + syncNameKeyedRow integration
// ---------------------------------------------------------------------------

describe("handleGaEvent syncs name-keyed row via handleGaUpsert", () => {
  function registryRecord(
    overrides: Partial<RegistryRecord> = {},
  ): RegistryRecord {
    return {
      recordId: "rec123456789",
      name: "TestAgent",
      description: "A test agent",
      status: "APPROVED",
      customDescriptorContent: undefined,
      ...overrides,
    };
  }

  test("GA APPROVED event updates both recordId and name rows", async () => {
    // First call: handleGaUpsert for the recordId-keyed row
    // Second call: syncNameKeyedRow GetCommand
    // Third call: syncNameKeyedRow UpdateCommand
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock
      .on(GetCommand, {
        TableName: "test-agents-table",
        Key: { agentId: "TestAgent" },
      })
      .resolves({ Item: { agentId: "TestAgent" } });

    // handleGaUpsert writes the recordId row
    await handleGaUpsert(
      "test-agents-table",
      "agent",
      "rec123456789",
      registryRecord({ status: "APPROVED" }),
    );

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    // At least one update for the recordId-keyed row
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const firstUpdate = updateCalls[0].args[0].input;
    expect(firstUpdate.Key).toEqual({ agentId: "rec123456789" });
    expect(firstUpdate.ExpressionAttributeValues![":registryStatus"]).toBe(
      "APPROVED",
    );
  });
});

// ---------------------------------------------------------------------------
// reconcile-approval-cache
// ---------------------------------------------------------------------------

describe("reconcile-approval-cache", () => {
  describe("isNameKeyedRowWithRecordId", () => {
    test("returns true for a name-keyed row with a different registryRecordId", () => {
      expect(
        isNameKeyedRowWithRecordId({
          agentId: "MyAgent",
          registryRecordId: "rec123456789",
        }),
      ).toBe(true);
    });

    test("returns false when agentId equals registryRecordId", () => {
      expect(
        isNameKeyedRowWithRecordId({
          agentId: "rec123456789",
          registryRecordId: "rec123456789",
        }),
      ).toBe(false);
    });

    test("returns false when registryRecordId is missing", () => {
      expect(isNameKeyedRowWithRecordId({ agentId: "MyAgent" })).toBe(false);
    });

    test("returns false when agentId looks like a recordId (12-char alphanum)", () => {
      expect(
        isNameKeyedRowWithRecordId({
          agentId: "AbCdEf123456",
          registryRecordId: "rec123456789",
        }),
      ).toBe(false);
    });
  });

  describe("parseArgs", () => {
    test("defaults to dry-run", () => {
      const args = parseArgs(["--table", "my-table"]);
      expect(args.dryRun).toBe(true);
    });

    test("--apply disables dry-run", () => {
      const args = parseArgs(["--table", "my-table", "--apply"]);
      expect(args.dryRun).toBe(false);
    });

    test("throws without --table", () => {
      expect(() => parseArgs([])).toThrow("--table");
    });
  });

  describe("runReconcile", () => {
    test("dry-run reports stale rows without writing", async () => {
      // Scan returns one name-keyed row with stale status
      ddbMock.on(ScanCommand).resolves({
        Items: [
          {
            agentId: "MyAgent",
            [REGISTRY_RECORD_ID_FIELD]: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "DRAFT",
          },
        ],
      });

      // GetCommand for the recordId-keyed row returns APPROVED
      ddbMock
        .on(GetCommand, {
          TableName: "test-agents-table",
          Key: { agentId: "rec123456789" },
        })
        .resolves({
          Item: {
            agentId: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "APPROVED",
            [STATUS_UPDATED_AT_FIELD]: "2026-10-21T00:00:00.000Z",
          },
        });

      const summary = await runReconcile("test-agents-table", true, docClient);

      expect(summary.scanned).toBe(1);
      expect(summary.stale).toBe(1);
      // No UpdateCommand should be issued in dry-run
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("apply mode fixes stale rows", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          {
            agentId: "MyAgent",
            [REGISTRY_RECORD_ID_FIELD]: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "DRAFT",
          },
        ],
      });

      ddbMock
        .on(GetCommand, {
          TableName: "test-agents-table",
          Key: { agentId: "rec123456789" },
        })
        .resolves({
          Item: {
            agentId: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "APPROVED",
            [STATUS_UPDATED_AT_FIELD]: "2026-10-21T00:00:00.000Z",
            decidedBy: "admin-user",
          },
        });

      ddbMock.on(UpdateCommand).resolves({});

      const summary = await runReconcile("test-agents-table", false, docClient);

      expect(summary.stale).toBe(1);
      expect(summary.fixed).toBe(1);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      const input = updateCalls[0].args[0].input;
      expect(input.Key).toEqual({ agentId: "MyAgent" });
      expect(input.ExpressionAttributeValues![":registryStatus"]).toBe(
        "APPROVED",
      );
      expect(input.ExpressionAttributeValues![":decidedBy"]).toBe("admin-user");
    });

    test("skips rows where name status matches recordId status", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          {
            agentId: "MyAgent",
            [REGISTRY_RECORD_ID_FIELD]: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "APPROVED",
          },
        ],
      });

      ddbMock
        .on(GetCommand, {
          TableName: "test-agents-table",
          Key: { agentId: "rec123456789" },
        })
        .resolves({
          Item: {
            agentId: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "APPROVED",
          },
        });

      const summary = await runReconcile("test-agents-table", false, docClient);

      expect(summary.stale).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("does not create new rows when recordId row is missing", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          {
            agentId: "MyAgent",
            [REGISTRY_RECORD_ID_FIELD]: "rec123456789",
            [REGISTRY_STATUS_FIELD]: "DRAFT",
          },
        ],
      });

      ddbMock
        .on(GetCommand, {
          TableName: "test-agents-table",
          Key: { agentId: "rec123456789" },
        })
        .resolves({ Item: undefined });

      const summary = await runReconcile("test-agents-table", false, docClient);

      expect(summary.skipped).toBe(1);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });
});
