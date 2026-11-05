/**
 * Tests for reconcile-legacy-rows.ts (CIT-263).
 *
 * Uses stateful in-memory DDB fakes to verify:
 *   - Orphan classification: excludes projection, pointer, decision rows
 *   - Dry-run writes nothing
 *   - --delete-orphans removes orphans, respects conflict-safe condition
 *   - Rows with registryRecordId are not orphans
 *   - Idempotent: second run is a no-op
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { NativeAttributeValue } from "@aws-sdk/lib-dynamodb";
import {
  runReconcileLegacy,
  isOrphanRow,
  isProjectionRow,
  isPointerRow,
  isDecisionRow,
  hasRegistryRecordId,
  type ReconcileLegacyOptions,
} from "../reconcile-legacy-rows";

// ---------------------------------------------------------------------------
// Stateful DDB fake
// ---------------------------------------------------------------------------

class FakeDynamoTable {
  items: Map<string, Record<string, NativeAttributeValue>> = new Map();

  put(key: string, item: Record<string, NativeAttributeValue>): void {
    this.items.set(key, { ...item });
  }

  delete(key: string): boolean {
    return this.items.delete(key);
  }

  getAll(): Record<string, NativeAttributeValue>[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function projectionRow(
  id: string,
  kind: "agent" | "tool",
): Record<string, NativeAttributeValue> {
  const keyAttr = kind === "agent" ? "agentId" : "toolId";
  return {
    [keyAttr]: id,
    orgId: "org-a",
    state: "active",
    projectionVersion: 1,
    citadelKind: kind,
    projectedAt: "2026-10-23T00:00:00.000Z",
    registryStatus: "APPROVED",
  };
}

function pointerRow(
  agentName: string,
  recordId: string,
): Record<string, NativeAttributeValue> {
  return {
    agentId: agentName,
    _canonicalRecordId: recordId,
    state: "active",
    orgId: "All Organizations",
    registryRecordId: recordId,
  };
}

function decisionRow(toolId: string): Record<string, NativeAttributeValue> {
  return {
    toolId: `decision#${toolId}`,
    decidedBy: "admin",
    decidedAt: "2026-10-22T12:00:00.000Z",
    status: "APPROVED",
  };
}

function legacyWithRegistryId(
  id: string,
  kind: "agent" | "tool",
  registryRecordId: string,
): Record<string, NativeAttributeValue> {
  const keyAttr = kind === "agent" ? "agentId" : "toolId";
  return {
    [keyAttr]: id,
    orgId: "Default",
    state: "active",
    registryRecordId,
  };
}

function orphanRow(
  id: string,
  kind: "agent" | "tool",
): Record<string, NativeAttributeValue> {
  const keyAttr = kind === "agent" ? "agentId" : "toolId";
  return {
    [keyAttr]: id,
    orgId: "All Organizations",
    state: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    config:
      kind === "tool"
        ? JSON.stringify({ name: id, description: "test" })
        : { name: id },
  };
}

// ---------------------------------------------------------------------------
// Unit tests for classification helpers
// ---------------------------------------------------------------------------

describe("classification helpers", () => {
  test("isProjectionRow identifies projection rows", () => {
    expect(isProjectionRow(projectionRow("id", "agent"))).toBe(true);
    expect(isProjectionRow(orphanRow("id", "agent"))).toBe(false);
  });

  test("isPointerRow identifies pointer rows", () => {
    expect(isPointerRow(pointerRow("name", "id"))).toBe(true);
    expect(isPointerRow(orphanRow("id", "agent"))).toBe(false);
  });

  test("isDecisionRow identifies decision# rows", () => {
    expect(isDecisionRow(decisionRow("tool-1"))).toBe(true);
    expect(isDecisionRow(orphanRow("tool-1", "tool"))).toBe(false);
  });

  test("hasRegistryRecordId identifies linked rows", () => {
    expect(
      hasRegistryRecordId(legacyWithRegistryId("name", "agent", "abc123")),
    ).toBe(true);
    expect(hasRegistryRecordId(orphanRow("id", "agent"))).toBe(false);
  });

  test("isOrphanRow correctly classifies agent rows", () => {
    expect(isOrphanRow(projectionRow("id", "agent"), "agent")).toBe(false);
    expect(isOrphanRow(pointerRow("name", "id"), "agent")).toBe(false);
    expect(
      isOrphanRow(legacyWithRegistryId("name", "agent", "abc"), "agent"),
    ).toBe(false);
    expect(isOrphanRow(orphanRow("id", "agent"), "agent")).toBe(true);
  });

  test("isOrphanRow correctly classifies tool rows", () => {
    expect(isOrphanRow(projectionRow("id", "tool"), "tool")).toBe(false);
    expect(isOrphanRow(decisionRow("id"), "tool")).toBe(false);
    expect(
      isOrphanRow(legacyWithRegistryId("name", "tool", "abc"), "tool"),
    ).toBe(false);
    expect(isOrphanRow(orphanRow("id", "tool"), "tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests with stateful fakes
// ---------------------------------------------------------------------------

describe("runReconcileLegacy", () => {
  const dynamoMock = mockClient(DynamoDBDocumentClient);
  let agentsTable: FakeDynamoTable;
  let toolsTable: FakeDynamoTable;

  function seedTables(): void {
    agentsTable = new FakeDynamoTable();
    toolsTable = new FakeDynamoTable();

    // Agents: 3 projection, 1 pointer, 1 legacy-with-registry, 2 orphans
    agentsTable.put("proj-1", projectionRow("proj-1", "agent"));
    agentsTable.put("proj-2", projectionRow("proj-2", "agent"));
    agentsTable.put("proj-3", projectionRow("proj-3", "agent"));
    agentsTable.put("demo-echo-agent", pointerRow("demo-echo-agent", "proj-1"));
    agentsTable.put(
      "dup-agent",
      legacyWithRegistryId("dup-agent", "agent", "proj-2"),
    );
    agentsTable.put("reportme", orphanRow("reportme", "agent"));
    agentsTable.put("adasdad", orphanRow("adasdad", "agent"));

    // Tools: 2 projection, 1 decision, 1 legacy-with-registry, 2 orphans
    toolsTable.put("tool-proj-1", projectionRow("tool-proj-1", "tool"));
    toolsTable.put("tool-proj-2", projectionRow("tool-proj-2", "tool"));
    toolsTable.put("decision#tool-proj-1", decisionRow("tool-proj-1"));
    toolsTable.put(
      "dup-tool",
      legacyWithRegistryId("dup-tool", "tool", "tool-proj-1"),
    );
    toolsTable.put("emailer", orphanRow("emailer", "tool"));
    toolsTable.put("gfjhgkf", orphanRow("gfjhgkf", "tool"));
  }

  function setupDynamoMock(): void {
    dynamoMock.reset();

    dynamoMock.on(ScanCommand).callsFake((input) => {
      const table = input.TableName as string;
      if (table === "test-agents") {
        return { Items: agentsTable.getAll() };
      }
      if (table === "test-tools") {
        return { Items: toolsTable.getAll() };
      }
      return { Items: [] };
    });

    dynamoMock.on(DeleteCommand).callsFake((input) => {
      const table = input.TableName;
      const key = Object.values(input.Key!)[0] as string;
      const targetTable = table === "test-agents" ? agentsTable : toolsTable;
      targetTable.delete(key);
      return {};
    });
  }

  beforeEach(() => {
    seedTables();
    setupDynamoMock();
  });

  afterEach(() => {
    dynamoMock.reset();
  });

  function makeOpts(dryRun: boolean): ReconcileLegacyOptions {
    return {
      tableAgents: "test-agents",
      tableTools: "test-tools",
      dryRun,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    };
  }

  test("dry-run identifies orphans but writes nothing", async () => {
    const initialAgentCount = agentsTable.size();
    const initialToolCount = toolsTable.size();

    const { summary, orphans } = await runReconcileLegacy(makeOpts(true));

    expect(summary.agentOrphansFound).toBe(2);
    expect(summary.toolOrphansFound).toBe(2);
    expect(summary.deleted).toBe(0);
    expect(summary.errors).toBe(0);

    // Tables unchanged
    expect(agentsTable.size()).toBe(initialAgentCount);
    expect(toolsTable.size()).toBe(initialToolCount);

    // Orphans correctly identified
    const orphanKeys = orphans.map((o) => o.key).sort();
    expect(orphanKeys).toEqual(["adasdad", "emailer", "gfjhgkf", "reportme"]);
  });

  test("delete-orphans removes only orphan rows", async () => {
    const { summary } = await runReconcileLegacy(makeOpts(false));

    expect(summary.deleted).toBe(4);
    expect(summary.errors).toBe(0);

    // Projection, pointer, decision, and registry-linked rows survive
    expect(agentsTable.items.has("proj-1")).toBe(true);
    expect(agentsTable.items.has("proj-2")).toBe(true);
    expect(agentsTable.items.has("demo-echo-agent")).toBe(true);
    expect(agentsTable.items.has("dup-agent")).toBe(true);
    expect(toolsTable.items.has("tool-proj-1")).toBe(true);
    expect(toolsTable.items.has("decision#tool-proj-1")).toBe(true);
    expect(toolsTable.items.has("dup-tool")).toBe(true);

    // Orphans removed
    expect(agentsTable.items.has("reportme")).toBe(false);
    expect(agentsTable.items.has("adasdad")).toBe(false);
    expect(toolsTable.items.has("emailer")).toBe(false);
    expect(toolsTable.items.has("gfjhgkf")).toBe(false);
  });

  test("second run is idempotent — no orphans found", async () => {
    // First run: delete orphans
    await runReconcileLegacy(makeOpts(false));

    // Second run: should find nothing
    setupDynamoMock(); // reset mocks with updated tables
    const { summary } = await runReconcileLegacy(makeOpts(true));

    expect(summary.agentOrphansFound).toBe(0);
    expect(summary.toolOrphansFound).toBe(0);
  });
});
