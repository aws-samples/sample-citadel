/**
 * Tests for the sourceProjectId backfill mode in reconcile-legacy-rows.ts.
 *
 * Given cache rows in AgentConfigTable with and without sourceProjectId,
 * the backfill must:
 *   1. Scan for rows missing sourceProjectId that have a registryRecordId
 *   2. Fetch the registry record to extract sourceProjectId from customDescriptorContent
 *   3. Update the cache row with the extracted sourceProjectId
 *   4. Skip rows already carrying sourceProjectId (idempotent)
 *   5. Dry-run: report candidates but write nothing
 *   6. Converge: second dry-run after --apply shows zero candidates
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

// Mock RegistryService for fetching record metadata
const mockGetResource = jest.fn();
jest.mock("../../src/services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    getClient: jest.fn(),
    getRegistryId: jest.fn().mockReturnValue("reg-1"),
  })),
}));

import {
  runReconcileSourceProjectId,
  type ReconcileSourceProjectIdSummary,
} from "../reconcile-legacy-rows";

const dynamoMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  jest.clearAllMocks();
  dynamoMock.reset();
});

// ── Helpers ───────────────────────────────────────────────────────────────

const fakeRegistryService = { getResource: mockGetResource };

function cacheRow(
  agentId: string,
  registryRecordId: string | undefined,
  sourceProjectId?: string,
) {
  return {
    agentId,
    registryRecordId,
    name: `Agent ${agentId}`,
    orgId: "org-a",
    registryStatus: "APPROVED",
    ...(sourceProjectId !== undefined ? { sourceProjectId } : {}),
  };
}

function registryRecord(recordId: string, sourceProjectId: string) {
  return {
    recordId,
    name: `Agent ${recordId}`,
    status: "APPROVED",
    customDescriptorContent: JSON.stringify({
      sourceProjectId,
      orgId: "org-a",
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("reconcileSourceProjectId", () => {
  test("dry-run: identifies rows missing sourceProjectId, writes nothing", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        cacheRow("a1", "rec-1"), // missing sourceProjectId — candidate
        cacheRow("a2", "rec-2", "proj-99"), // already has it — skip
        cacheRow("a3", undefined), // no registryRecordId — skip
      ],
    });

    mockGetResource.mockResolvedValueOnce(registryRecord("rec-1", "proj-123"));

    const result: ReconcileSourceProjectIdSummary =
      await runReconcileSourceProjectId({
        tableAgents: "test-agents",
        dryRun: true,
        docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        registryService: fakeRegistryService,
      });

    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.candidatesFound).toBe(1);
    expect(result.updated).toBe(0); // dry-run: no writes
    expect(result.errors).toBe(0);

    // No UpdateCommand issued
    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("apply: updates rows missing sourceProjectId", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        cacheRow("a1", "rec-1"), // missing — candidate
        cacheRow("a2", "rec-2"), // missing — candidate
        cacheRow("a3", "rec-3", "proj-99"), // already set — skip
      ],
    });
    dynamoMock.on(UpdateCommand).resolves({});

    mockGetResource
      .mockResolvedValueOnce(registryRecord("rec-1", "proj-123"))
      .mockResolvedValueOnce(registryRecord("rec-2", "proj-456"));

    const result = await runReconcileSourceProjectId({
      tableAgents: "test-agents",
      dryRun: false,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      registryService: fakeRegistryService,
    });

    expect(result.candidatesFound).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.skippedAlreadySet).toBe(1);
    expect(result.errors).toBe(0);

    // Two UpdateCommands issued
    const updates = dynamoMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(2);
  });

  test("convergence: second dry-run after apply shows zero candidates", async () => {
    // After apply, all rows now have sourceProjectId
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        cacheRow("a1", "rec-1", "proj-123"),
        cacheRow("a2", "rec-2", "proj-456"),
        cacheRow("a3", "rec-3", "proj-99"),
      ],
    });

    const result = await runReconcileSourceProjectId({
      tableAgents: "test-agents",
      dryRun: true,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      registryService: fakeRegistryService,
    });

    expect(result.candidatesFound).toBe(0);
    expect(result.updated).toBe(0);
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  test("handles registry getResource failure gracefully", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [cacheRow("a1", "rec-1")],
    });

    mockGetResource.mockRejectedValueOnce(new Error("registry unavailable"));

    const result = await runReconcileSourceProjectId({
      tableAgents: "test-agents",
      dryRun: false,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      registryService: fakeRegistryService,
    });

    expect(result.candidatesFound).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(0);
  });

  test("skips rows where registry record has no sourceProjectId", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [cacheRow("a1", "rec-1")],
    });
    dynamoMock.on(UpdateCommand).resolves({});

    mockGetResource.mockResolvedValueOnce({
      recordId: "rec-1",
      name: "Agent rec-1",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({ orgId: "org-a" }),
    });

    const result = await runReconcileSourceProjectId({
      tableAgents: "test-agents",
      dryRun: false,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      registryService: fakeRegistryService,
    });

    // The row was a candidate but registry has no sourceProjectId to write
    expect(result.candidatesFound).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skippedNoProjectId).toBe(1);
  });
});
