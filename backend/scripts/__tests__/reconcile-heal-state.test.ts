/**
 * Tests for --heal-state-from-registry-status in reconcile-legacy-rows.ts.
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  runHealStateFromRegistryStatus,
  parseArgs,
} from "../reconcile-legacy-rows";

// ---------------------------------------------------------------------------
// DDB mock
// ---------------------------------------------------------------------------
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
// parseArgs
// ---------------------------------------------------------------------------
describe("parseArgs --heal-state-from-registry-status", () => {
  test("parses --heal-state-from-registry-status --table-agents", () => {
    const args = parseArgs([
      "--heal-state-from-registry-status",
      "--table-agents",
      "my-agents",
    ]);
    expect(args.healStateFromRegistryStatus).toBe(true);
    expect(args.tableAgents).toBe("my-agents");
    expect(args.dryRun).toBe(true); // default
  });

  test("--apply sets dryRun to false", () => {
    const args = parseArgs([
      "--heal-state-from-registry-status",
      "--table-agents",
      "my-agents",
      "--apply",
    ]);
    expect(args.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runHealStateFromRegistryStatus
// ---------------------------------------------------------------------------
describe("runHealStateFromRegistryStatus", () => {
  test("dry-run identifies drifted rows without writing", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { agentId: "agent-1", registryStatus: "APPROVED", state: "inactive" },
        { agentId: "agent-2", registryStatus: "APPROVED", state: "active" }, // already correct
        { agentId: "agent-3", registryStatus: "DEPRECATED", state: "active" },
        { agentId: "agent-4", registryStatus: "REJECTED", state: "active" },
      ],
    });

    const result = await runHealStateFromRegistryStatus({
      tableAgents: "test-agents",
      dryRun: true,
      docClient,
    });

    expect(result.scanned).toBe(4);
    expect(result.drifted).toBe(3);
    expect(result.healed).toBe(0); // dry-run → no writes
    expect(result.errors).toBe(0);

    // Verify no UpdateCommand was sent
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  test("apply mode heals drifted rows", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { agentId: "agent-1", registryStatus: "APPROVED", state: "inactive" },
        { agentId: "agent-2", registryStatus: "DEPRECATED", state: "active" },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await runHealStateFromRegistryStatus({
      tableAgents: "test-agents",
      dryRun: false,
      docClient,
    });

    expect(result.scanned).toBe(2);
    expect(result.drifted).toBe(2);
    expect(result.healed).toBe(2);
    expect(result.errors).toBe(0);

    // Verify UpdateCommand calls
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(2);

    // First call: APPROVED → active
    const firstInput = updateCalls[0].args[0].input;
    expect(firstInput.Key).toEqual({ agentId: "agent-1" });
    expect(firstInput.ExpressionAttributeValues?.[":state"]).toBe("active");

    // Second call: DEPRECATED → inactive
    const secondInput = updateCalls[1].args[0].input;
    expect(secondInput.Key).toEqual({ agentId: "agent-2" });
    expect(secondInput.ExpressionAttributeValues?.[":state"]).toBe("inactive");
  });

  test("second dry-run after apply shows no drift", async () => {
    // Simulate the state after healing
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { agentId: "agent-1", registryStatus: "APPROVED", state: "active" },
        { agentId: "agent-2", registryStatus: "DEPRECATED", state: "inactive" },
      ],
    });

    const result = await runHealStateFromRegistryStatus({
      tableAgents: "test-agents",
      dryRun: true,
      docClient,
    });

    expect(result.scanned).toBe(2);
    expect(result.drifted).toBe(0);
    expect(result.healed).toBe(0);
  });

  test("rows without registryStatus are skipped", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { agentId: "legacy-row", state: "active" }, // no registryStatus
      ],
    });

    const result = await runHealStateFromRegistryStatus({
      tableAgents: "test-agents",
      dryRun: true,
      docClient,
    });

    expect(result.scanned).toBe(1);
    expect(result.drifted).toBe(0);
  });
});
