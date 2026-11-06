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

// ---------------------------------------------------------------------------
// CIT-281: Unpublished intake blueprint cleanup
// ---------------------------------------------------------------------------
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  runReconcileUnpublishedBlueprints,
  isUnpublishedIntakeBlueprint,
  type ReconcileUnpublishedBlueprintsOptions,
} from "../reconcile-legacy-rows";

const TWENTY_FIVE_HOURS_AGO = new Date(
  Date.now() - 25 * 60 * 60 * 1000,
).toISOString();
const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function intakeDraftBlueprint(
  workflowId: string,
  name: string,
  createdAt: string = TWENTY_FIVE_HOURS_AGO,
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "DRAFT",
    isBlueprint: "true",
    createdBy:
      "arn:aws:sts::123456789012:assumed-role/intake-runtime-role/session",
    createdAt,
  };
}

function publishedBlueprint(
  workflowId: string,
  name: string,
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "PUBLISHED",
    isBlueprint: "true",
    createdBy:
      "arn:aws:sts::123456789012:assumed-role/intake-runtime-role/session",
    createdAt: TWENTY_FIVE_HOURS_AGO,
  };
}

function seededBlueprint(
  workflowId: string,
  name: string,
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "system",
    status: "DRAFT",
    isBlueprint: "true",
    createdBy: "system",
    createdAt: TWENTY_FIVE_HOURS_AGO,
    seedVersion: 3,
  };
}

describe("isUnpublishedIntakeBlueprint", () => {
  const seededIds = new Set(["seeded-1"]);
  const ageThresholdMs = 24 * 60 * 60 * 1000;
  const now = Date.now();

  test("identifies an old DRAFT intake blueprint as candidate", () => {
    expect(
      isUnpublishedIntakeBlueprint(
        intakeDraftBlueprint("wf-1", "Smoke-test-1 Process"),
        seededIds,
        ageThresholdMs,
        now,
      ),
    ).toBe(true);
  });

  test("excludes PUBLISHED blueprints", () => {
    expect(
      isUnpublishedIntakeBlueprint(
        publishedBlueprint("wf-2", "Published BP"),
        seededIds,
        ageThresholdMs,
        now,
      ),
    ).toBe(false);
  });

  test("excludes seeded blueprints (by seedVersion attribute)", () => {
    expect(
      isUnpublishedIntakeBlueprint(
        seededBlueprint("seeded-1", "Echo Demo"),
        seededIds,
        ageThresholdMs,
        now,
      ),
    ).toBe(false);
  });

  test("excludes seeded blueprints (by ID set)", () => {
    const row = intakeDraftBlueprint("seeded-1", "Some Name");
    expect(
      isUnpublishedIntakeBlueprint(row, seededIds, ageThresholdMs, now),
    ).toBe(false);
  });

  test("excludes blueprints newer than age threshold", () => {
    expect(
      isUnpublishedIntakeBlueprint(
        intakeDraftBlueprint("wf-3", "Recent", ONE_HOUR_AGO),
        seededIds,
        ageThresholdMs,
        now,
      ),
    ).toBe(false);
  });

  test("excludes blueprints created by a Cognito user (non-IAM)", () => {
    const row = {
      ...intakeDraftBlueprint("wf-4", "User-created"),
      createdBy: "3f2a1b7c-9d4e-4f61-8a2b-0c5d6e7f8a9b",
    };
    expect(
      isUnpublishedIntakeBlueprint(row, seededIds, ageThresholdMs, now),
    ).toBe(false);
  });
});

describe("runReconcileUnpublishedBlueprints", () => {
  const dynamoMock = mockClient(DynamoDBDocumentClient);
  let workflowsTable: FakeDynamoTable;

  function seedWorkflows(): void {
    workflowsTable = new FakeDynamoTable();
    // 4 orphan DRAFT intake blueprints (the CIT-281 incident rows)
    workflowsTable.put(
      "542db0c2",
      intakeDraftBlueprint("542db0c2", "Smoke-test-1 Process"),
    );
    workflowsTable.put(
      "9e683e14",
      intakeDraftBlueprint("9e683e14", "Smoke-test-1 Process"),
    );
    workflowsTable.put(
      "89419c36",
      intakeDraftBlueprint("89419c36", "Smoke-test-1 Process"),
    );
    workflowsTable.put(
      "3a44f088",
      intakeDraftBlueprint("3a44f088", "Smoke-test-1 Process"),
    );
    // 1 real PUBLISHED blueprint — must survive
    workflowsTable.put(
      "1a8abc78",
      publishedBlueprint("1a8abc78", "Smoke-test-1 Process"),
    );
    // 1 seeded blueprint — must survive
    workflowsTable.put(
      "seeded-bp",
      seededBlueprint("seeded-bp", "Echo Demo Workflow"),
    );
  }

  function setupMock(): void {
    dynamoMock.reset();
    dynamoMock.on(QueryCommand).callsFake(() => {
      return { Items: workflowsTable.getAll() };
    });
    dynamoMock.on(DeleteCommand).callsFake((input) => {
      workflowsTable.delete(Object.values(input.Key!)[0] as string);
      return {};
    });
  }

  beforeEach(() => {
    seedWorkflows();
    setupMock();
  });

  afterEach(() => {
    dynamoMock.reset();
  });

  function makeOpts(dryRun: boolean): ReconcileUnpublishedBlueprintsOptions {
    return {
      tableWorkflows: "test-workflows",
      dryRun,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      seededIds: new Set(["seeded-bp"]),
      ageThresholdHours: 24,
    };
  }

  test("dry-run identifies 4 orphan DRAFT blueprints but deletes nothing", async () => {
    const initial = workflowsTable.size();
    const { summary, rows } = await runReconcileUnpublishedBlueprints(
      makeOpts(true),
    );
    expect(summary.found).toBe(4);
    expect(summary.deleted).toBe(0);
    expect(summary.errors).toBe(0);
    expect(workflowsTable.size()).toBe(initial);
    expect(rows.map((r) => r.workflowId).sort()).toEqual([
      "3a44f088",
      "542db0c2",
      "89419c36",
      "9e683e14",
    ]);
  });

  test("--apply deletes only the orphan DRAFT rows, preserves PUBLISHED and seeded", async () => {
    const { summary } = await runReconcileUnpublishedBlueprints(
      makeOpts(false),
    );
    expect(summary.deleted).toBe(4);
    expect(summary.errors).toBe(0);
    // PUBLISHED and seeded survive
    expect(workflowsTable.items.has("1a8abc78")).toBe(true);
    expect(workflowsTable.items.has("seeded-bp")).toBe(true);
    // Orphans removed
    expect(workflowsTable.items.has("542db0c2")).toBe(false);
    expect(workflowsTable.items.has("9e683e14")).toBe(false);
  });

  test("second run is idempotent — no orphans found", async () => {
    await runReconcileUnpublishedBlueprints(makeOpts(false));
    setupMock();
    const { summary } = await runReconcileUnpublishedBlueprints(makeOpts(true));
    expect(summary.found).toBe(0);
  });
});
