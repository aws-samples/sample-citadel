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

// ---------------------------------------------------------------------------
// CIT-288: Placeholder-agent copy cleanup
// ---------------------------------------------------------------------------

import {
  runReconcilePlaceholderCopies,
  isPlaceholderCopy,
  hasPlaceholderAgent,
  type ReconcilePlaceholderCopiesOptions,
} from "../reconcile-legacy-rows";

function placeholderCopyWorkflow(
  workflowId: string,
  name: string,
  overrides: Partial<Record<string, NativeAttributeValue>> = {},
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "DRAFT",
    isBlueprint: "false",
    appId: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    definition: JSON.stringify({
      nodes: [
        { id: "n1", agentId: "placeholder-fabricated-1", type: "agent" },
        { id: "n2", agentId: "real-agent", type: "agent" },
      ],
      edges: [],
    }),
    ...overrides,
  };
}

function realWorkflow(
  workflowId: string,
  name: string,
  overrides: Partial<Record<string, NativeAttributeValue>> = {},
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "DRAFT",
    isBlueprint: "false",
    appId: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    definition: JSON.stringify({
      nodes: [
        { id: "n1", agentId: "real-agent-1", type: "agent" },
        { id: "n2", agentId: "real-agent-2", type: "agent" },
      ],
      edges: [],
    }),
    ...overrides,
  };
}

function blueprintWorkflow(
  workflowId: string,
  name: string,
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "DRAFT",
    isBlueprint: "true",
    appId: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    definition: JSON.stringify({
      nodes: [{ id: "n1", agentId: "placeholder-bp-agent", type: "agent" }],
      edges: [],
    }),
  };
}

function publishedWorkflow(
  workflowId: string,
  name: string,
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name,
    orgId: "org-a",
    status: "PUBLISHED",
    isBlueprint: "false",
    appId: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    definition: JSON.stringify({
      nodes: [{ id: "n1", agentId: "placeholder-old", type: "agent" }],
      edges: [],
    }),
  };
}

describe("hasPlaceholderAgent", () => {
  test("returns true when any node agentId starts with placeholder-", () => {
    expect(
      hasPlaceholderAgent({
        nodes: [{ id: "n1", agentId: "placeholder-abc", type: "agent" }],
      }),
    ).toBe(true);
  });

  test("returns false when no node has a placeholder agentId", () => {
    expect(
      hasPlaceholderAgent({
        nodes: [{ id: "n1", agentId: "real-agent", type: "agent" }],
      }),
    ).toBe(false);
  });

  test("returns false for empty nodes array", () => {
    expect(hasPlaceholderAgent({ nodes: [] })).toBe(false);
  });

  test("returns false for null/undefined input", () => {
    expect(hasPlaceholderAgent(null)).toBe(false);
    expect(hasPlaceholderAgent(undefined)).toBe(false);
  });

  test("detects agentId nested in data object", () => {
    expect(
      hasPlaceholderAgent({
        nodes: [
          { id: "n1", data: { agentId: "placeholder-nested" }, type: "agent" },
        ],
      }),
    ).toBe(true);
  });
});

describe("isPlaceholderCopy", () => {
  test("identifies DRAFT non-blueprint with placeholder agent", () => {
    expect(isPlaceholderCopy(placeholderCopyWorkflow("wf-1", "Copy"))).toBe(
      true,
    );
  });

  test("excludes isBlueprint=true rows", () => {
    expect(isPlaceholderCopy(blueprintWorkflow("bp-1", "Blueprint"))).toBe(
      false,
    );
  });

  test("excludes PUBLISHED rows", () => {
    expect(isPlaceholderCopy(publishedWorkflow("wf-pub", "Published"))).toBe(
      false,
    );
  });

  test("excludes rows with no placeholder agents", () => {
    expect(isPlaceholderCopy(realWorkflow("wf-real", "Real"))).toBe(false);
  });

  test("excludes rows with missing definition", () => {
    const row = { ...placeholderCopyWorkflow("wf-x", "X"), definition: "" };
    expect(isPlaceholderCopy(row)).toBe(false);
  });

  test("handles rows with absent isBlueprint (still eligible)", () => {
    const row = placeholderCopyWorkflow("wf-y", "Y");
    delete (row as Record<string, unknown>).isBlueprint;
    expect(isPlaceholderCopy(row)).toBe(true);
  });
});

describe("runReconcilePlaceholderCopies", () => {
  const dynamoMock = mockClient(DynamoDBDocumentClient);
  let workflowsTable: FakeDynamoTable;
  let executionsTable: FakeDynamoTable;
  let appsTable: FakeDynamoTable;

  function seedTables(): void {
    workflowsTable = new FakeDynamoTable();
    executionsTable = new FakeDynamoTable();
    appsTable = new FakeDynamoTable();

    // 2 placeholder copies eligible for deletion
    workflowsTable.put("pc-1", placeholderCopyWorkflow("pc-1", "Copy 1"));
    workflowsTable.put("pc-2", placeholderCopyWorkflow("pc-2", "Copy 2"));
    // 1 placeholder copy with execution reference — must survive
    workflowsTable.put(
      "pc-exec",
      placeholderCopyWorkflow("pc-exec", "Has Exec"),
    );
    executionsTable.put("exec-1", {
      executionId: "exec-1",
      workflowId: "pc-exec",
      startedAt: "2026-10-01T00:00:00.000Z",
    });
    // 1 placeholder copy bound via appId attribute — must be reported as bound, skipped
    workflowsTable.put(
      "pc-bound-attr",
      placeholderCopyWorkflow("pc-bound-attr", "Bound via appId", {
        appId: "app-123",
      }),
    );
    // 1 placeholder copy bound via apps table workflowIds — must be reported as bound, skipped
    workflowsTable.put(
      "pc-bound-app",
      placeholderCopyWorkflow("pc-bound-app", "Bound via app"),
    );
    appsTable.put("app-456", {
      appId: "app-456",
      workflowIds: ["pc-bound-app", "some-other-wf"],
    });
    // 1 real workflow (no placeholder) — must survive
    workflowsTable.put("wf-real", realWorkflow("wf-real", "Real Workflow"));
    // 1 blueprint with placeholder — must survive (never touch blueprints)
    workflowsTable.put(
      "bp-1",
      blueprintWorkflow("bp-1", "Blueprint With Placeholder"),
    );
    // 1 PUBLISHED workflow with placeholder — must survive
    workflowsTable.put(
      "wf-pub",
      publishedWorkflow("wf-pub", "Published Placeholder"),
    );
  }

  function setupMock(): void {
    dynamoMock.reset();

    dynamoMock.on(ScanCommand).callsFake((input) => {
      const table = input.TableName as string;
      if (table === "test-workflows") {
        return { Items: workflowsTable.getAll() };
      }
      if (table === "test-apps") {
        return { Items: appsTable.getAll() };
      }
      return { Items: [] };
    });

    dynamoMock.on(QueryCommand).callsFake((input) => {
      const wfId = input.ExpressionAttributeValues?.[":wfId"] as string;
      const matchingExecs = executionsTable
        .getAll()
        .filter((item) => item.workflowId === wfId);
      return { Count: matchingExecs.length, Items: matchingExecs };
    });

    dynamoMock.on(DeleteCommand).callsFake((input) => {
      const key = Object.values(input.Key!)[0] as string;
      workflowsTable.delete(key);
      return {};
    });
  }

  beforeEach(() => {
    seedTables();
    setupMock();
  });

  afterEach(() => {
    dynamoMock.reset();
  });

  function makeOpts(
    dryRun: boolean,
    includeApps = true,
  ): ReconcilePlaceholderCopiesOptions {
    return {
      tableWorkflows: "test-workflows",
      tableExecutions: "test-executions",
      tableApps: includeApps ? "test-apps" : "",
      dryRun,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    };
  }

  test("dry-run identifies placeholder copies, reports bound ones, writes nothing", async () => {
    const initial = workflowsTable.size();
    const { summary, rows } = await runReconcilePlaceholderCopies(
      makeOpts(true),
    );

    // 2 deletable + 2 bound = 4 found
    expect(summary.found).toBe(4);
    expect(summary.boundSkipped).toBe(2);
    expect(summary.deleted).toBe(0);
    expect(summary.errors).toBe(0);
    // Table unchanged
    expect(workflowsTable.size()).toBe(initial);

    // Bound rows correctly flagged
    const boundRows = rows.filter((r) => r.boundSkipped);
    expect(boundRows.map((r) => r.workflowId).sort()).toEqual([
      "pc-bound-app",
      "pc-bound-attr",
    ]);

    // Deletable rows correctly identified
    const deletable = rows.filter((r) => !r.boundSkipped);
    expect(deletable.map((r) => r.workflowId).sort()).toEqual([
      "pc-1",
      "pc-2",
    ]);
  });

  test("--apply deletes only eligible placeholder copies", async () => {
    const { summary } = await runReconcilePlaceholderCopies(makeOpts(false));

    expect(summary.deleted).toBe(2);
    expect(summary.boundSkipped).toBe(2);
    expect(summary.errors).toBe(0);

    // Deleted
    expect(workflowsTable.items.has("pc-1")).toBe(false);
    expect(workflowsTable.items.has("pc-2")).toBe(false);

    // Survivors
    expect(workflowsTable.items.has("pc-exec")).toBe(true); // has execution
    expect(workflowsTable.items.has("pc-bound-attr")).toBe(true); // bound
    expect(workflowsTable.items.has("pc-bound-app")).toBe(true); // bound
    expect(workflowsTable.items.has("wf-real")).toBe(true); // real workflow
    expect(workflowsTable.items.has("bp-1")).toBe(true); // blueprint
    expect(workflowsTable.items.has("wf-pub")).toBe(true); // published
  });

  test("excludes workflows with execution references", async () => {
    const { rows } = await runReconcilePlaceholderCopies(makeOpts(true));
    const allIds = rows.map((r) => r.workflowId);
    expect(allIds).not.toContain("pc-exec");
  });

  test("never touches isBlueprint=true rows", async () => {
    const { rows } = await runReconcilePlaceholderCopies(makeOpts(true));
    const allIds = rows.map((r) => r.workflowId);
    expect(allIds).not.toContain("bp-1");
  });

  test("never touches PUBLISHED rows", async () => {
    const { rows } = await runReconcilePlaceholderCopies(makeOpts(true));
    const allIds = rows.map((r) => r.workflowId);
    expect(allIds).not.toContain("wf-pub");
  });

  test("skips app-table lookup when tableApps is empty", async () => {
    // Without apps table, pc-bound-app has no appId attr and is NOT in
    // an app's workflowIds, so it becomes deletable.
    const { summary, rows } = await runReconcilePlaceholderCopies(
      makeOpts(true, false),
    );
    const deletable = rows.filter((r) => !r.boundSkipped);
    expect(deletable.map((r) => r.workflowId).sort()).toEqual([
      "pc-1",
      "pc-2",
      "pc-bound-app",
    ]);
    // pc-bound-attr still has appId attribute, so it's bound
    expect(summary.boundSkipped).toBe(1);
  });

  test("second run is idempotent — no more copies found", async () => {
    await runReconcilePlaceholderCopies(makeOpts(false));
    setupMock();
    const { summary } = await runReconcilePlaceholderCopies(makeOpts(true));
    // Only bound rows remain from the placeholder set
    expect(summary.found).toBe(2);
    const deletable = summary.found - summary.boundSkipped;
    expect(deletable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Untitled never-run DRAFT workflow cleanup
// ---------------------------------------------------------------------------

import {
  runReconcileUntitledDrafts,
  isUntitledDraft,
  type ReconcileUntitledDraftsOptions,
} from "../reconcile-legacy-rows";

const FORTY_EIGHT_HOURS_AGO = new Date(
  Date.now() - 48 * 60 * 60 * 1000,
).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const NOW_MS = Date.now();
const DEFAULT_NAME_PATTERN = "Untitled Workflow";
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function untitledDraftWorkflow(
  workflowId: string,
  overrides: Partial<Record<string, NativeAttributeValue>> = {},
): Record<string, NativeAttributeValue> {
  return {
    workflowId,
    name: "Untitled Workflow",
    orgId: "org-a",
    status: "DRAFT",
    isBlueprint: "false",
    appId: "",
    createdAt: FORTY_EIGHT_HOURS_AGO,
    definition: JSON.stringify({
      nodes: [
        { id: "n1", agentId: "agent-1", type: "agent" },
        { id: "n2", agentId: "agent-2", type: "agent" },
      ],
      edges: [],
    }),
    ...overrides,
  };
}

describe("isUntitledDraft", () => {
  test("identifies an old DRAFT non-blueprint with matching name", () => {
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-1"),
        DEFAULT_NAME_PATTERN,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(true);
  });

  test("rejects isBlueprint=true rows", () => {
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-bp", { isBlueprint: "true" }),
        DEFAULT_NAME_PATTERN,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("rejects PUBLISHED rows", () => {
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-pub", { status: "PUBLISHED" }),
        DEFAULT_NAME_PATTERN,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("rejects rows with non-matching name", () => {
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-named", { name: "My Real Workflow" }),
        DEFAULT_NAME_PATTERN,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("rejects rows newer than min age", () => {
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-new", { createdAt: TWO_HOURS_AGO }),
        DEFAULT_NAME_PATTERN,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("matches with custom name prefix", () => {
    const custom = "Draft-";
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-custom", { name: "Draft-test" }),
        custom,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-no", { name: "Untitled Workflow" }),
        custom,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("prefix with regex metacharacters is matched literally", () => {
    const meta = "Untitled (v2)";
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-meta", { name: "Untitled (v2) Workflow" }),
        meta,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(true);
    // Should NOT match 'Untitled xv2y Workflow' — metacharacters are literal
    expect(
      isUntitledDraft(
        untitledDraftWorkflow("wf-meta-no", { name: "Untitled xv2y Workflow" }),
        meta,
        DEFAULT_MIN_AGE_MS,
        NOW_MS,
      ),
    ).toBe(false);
  });

  test("handles absent isBlueprint (still eligible)", () => {
    const row = untitledDraftWorkflow("wf-no-bp");
    delete (row as Record<string, unknown>).isBlueprint;
    expect(
      isUntitledDraft(row, DEFAULT_NAME_PATTERN, DEFAULT_MIN_AGE_MS, NOW_MS),
    ).toBe(true);
  });
});

describe("runReconcileUntitledDrafts", () => {
  const dynamoMock = mockClient(DynamoDBDocumentClient);
  let workflowsTable: FakeDynamoTable;
  let executionsTable: FakeDynamoTable;
  let appsTable: FakeDynamoTable;

  function seedTables(): void {
    workflowsTable = new FakeDynamoTable();
    executionsTable = new FakeDynamoTable();
    appsTable = new FakeDynamoTable();

    // 3 untitled DRAFT workflows eligible for deletion
    workflowsTable.put("ut-1", untitledDraftWorkflow("ut-1"));
    workflowsTable.put("ut-2", untitledDraftWorkflow("ut-2"));
    workflowsTable.put(
      "ut-3",
      untitledDraftWorkflow("ut-3", { name: "Untitled Workflow (2)" }),
    );

    // 1 untitled DRAFT with execution reference — must survive
    workflowsTable.put(
      "ut-exec",
      untitledDraftWorkflow("ut-exec"),
    );
    executionsTable.put("exec-ut", {
      executionId: "exec-ut",
      workflowId: "ut-exec",
      startedAt: "2026-10-01T00:00:00.000Z",
    });

    // 1 untitled DRAFT bound via appId — must be skipped
    workflowsTable.put(
      "ut-bound",
      untitledDraftWorkflow("ut-bound", { appId: "app-999" }),
    );

    // 1 untitled DRAFT bound via apps table — must be skipped
    workflowsTable.put(
      "ut-bound-app",
      untitledDraftWorkflow("ut-bound-app"),
    );
    appsTable.put("app-abc", {
      appId: "app-abc",
      workflowIds: ["ut-bound-app"],
    });

    // 1 untitled DRAFT too new — must survive
    workflowsTable.put(
      "ut-new",
      untitledDraftWorkflow("ut-new", { createdAt: TWO_HOURS_AGO }),
    );

    // 1 PUBLISHED workflow named Untitled — must survive
    workflowsTable.put(
      "ut-pub",
      untitledDraftWorkflow("ut-pub", { status: "PUBLISHED" }),
    );

    // 1 named DRAFT workflow — must survive
    workflowsTable.put(
      "named-wf",
      untitledDraftWorkflow("named-wf", { name: "My Real Workflow" }),
    );

    // 1 blueprint with untitled name — must survive
    workflowsTable.put(
      "ut-bp",
      untitledDraftWorkflow("ut-bp", { isBlueprint: "true" }),
    );
  }

  function setupMock(): void {
    dynamoMock.reset();

    dynamoMock.on(ScanCommand).callsFake((input) => {
      const table = input.TableName as string;
      if (table === "test-workflows") {
        return { Items: workflowsTable.getAll() };
      }
      if (table === "test-apps") {
        return { Items: appsTable.getAll() };
      }
      return { Items: [] };
    });

    dynamoMock.on(QueryCommand).callsFake((input) => {
      const wfId = input.ExpressionAttributeValues?.[":wfId"] as string;
      const matchingExecs = executionsTable
        .getAll()
        .filter((item) => item.workflowId === wfId);
      return { Count: matchingExecs.length, Items: matchingExecs };
    });

    dynamoMock.on(DeleteCommand).callsFake((input) => {
      const key = Object.values(input.Key!)[0] as string;
      workflowsTable.delete(key);
      return {};
    });
  }

  beforeEach(() => {
    seedTables();
    setupMock();
  });

  afterEach(() => {
    dynamoMock.reset();
  });

  function makeOpts(
    dryRun: boolean,
    includeApps = true,
  ): ReconcileUntitledDraftsOptions {
    return {
      tableWorkflows: "test-workflows",
      tableExecutions: "test-executions",
      tableApps: includeApps ? "test-apps" : "",
      dryRun,
      docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      namePrefix: DEFAULT_NAME_PATTERN,
      minAgeMs: DEFAULT_MIN_AGE_MS,
      now: NOW_MS,
    };
  }

  test("dry-run identifies untitled drafts but writes nothing", async () => {
    const initial = workflowsTable.size();
    const { summary, rows } = await runReconcileUntitledDrafts(
      makeOpts(true),
    );

    expect(summary.found).toBe(5);
    expect(summary.boundSkipped).toBe(2);
    expect(summary.deleted).toBe(0);
    expect(summary.errors).toBe(0);
    expect(workflowsTable.size()).toBe(initial);

    // 3 eligible + 2 bound-skipped
    const eligible = rows.filter((r) => !r.boundSkipped);
    const ids = eligible.map((r) => r.workflowId).sort();
    expect(ids).toEqual(["ut-1", "ut-2", "ut-3"]);

    // Verify nodeCount is reported on eligible rows
    for (const row of eligible) {
      expect(row.nodeCount).toBe(2);
    }

    // Bound-skipped rows are reported in the output
    const bound = rows.filter((r) => r.boundSkipped);
    expect(bound).toHaveLength(2);
    const boundIds = bound.map((r) => r.workflowId).sort();
    expect(boundIds).toEqual(["ut-bound", "ut-bound-app"]);
  });

  test("--apply deletes only eligible untitled drafts", async () => {
    const { summary } = await runReconcileUntitledDrafts(makeOpts(false));

    expect(summary.deleted).toBe(3);
    expect(summary.errors).toBe(0);

    // Deleted
    expect(workflowsTable.items.has("ut-1")).toBe(false);
    expect(workflowsTable.items.has("ut-2")).toBe(false);
    expect(workflowsTable.items.has("ut-3")).toBe(false);

    // Survivors
    expect(workflowsTable.items.has("ut-exec")).toBe(true);
    expect(workflowsTable.items.has("ut-bound")).toBe(true);
    expect(workflowsTable.items.has("ut-bound-app")).toBe(true);
    expect(workflowsTable.items.has("ut-new")).toBe(true);
    expect(workflowsTable.items.has("ut-pub")).toBe(true);
    expect(workflowsTable.items.has("named-wf")).toBe(true);
    expect(workflowsTable.items.has("ut-bp")).toBe(true);
  });

  test("excludes workflows with execution references", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    const allIds = rows.map((r) => r.workflowId);
    expect(allIds).not.toContain("ut-exec");
  });

  test("excludes PUBLISHED rows", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    const eligible = rows.filter((r) => !r.boundSkipped);
    const ids = eligible.map((r) => r.workflowId);
    expect(ids).not.toContain("ut-pub");
  });

  test("excludes blueprints", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    const eligible = rows.filter((r) => !r.boundSkipped);
    const ids = eligible.map((r) => r.workflowId);
    expect(ids).not.toContain("ut-bp");
  });

  test("excludes rows newer than min-age-hours", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    const eligible = rows.filter((r) => !r.boundSkipped);
    const ids = eligible.map((r) => r.workflowId);
    expect(ids).not.toContain("ut-new");
  });

  test("excludes rows with non-matching name", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    const eligible = rows.filter((r) => !r.boundSkipped);
    const ids = eligible.map((r) => r.workflowId);
    expect(ids).not.toContain("named-wf");
  });

  test("reports bound workflows with appId attribute as bound-skipped", async () => {
    const { summary, rows } = await runReconcileUntitledDrafts(makeOpts(true));
    expect(summary.boundSkipped).toBeGreaterThanOrEqual(1);
    const bound = rows.find((r) => r.workflowId === "ut-bound");
    expect(bound?.boundSkipped).toBe(true);
    expect(bound?.appId).toBe("app-999");
  });

  test("reports bound workflows from apps table as bound-skipped", async () => {
    const { summary, rows } = await runReconcileUntitledDrafts(makeOpts(true));
    expect(summary.boundSkipped).toBe(2);
    const bound = rows.find((r) => r.workflowId === "ut-bound-app");
    expect(bound?.boundSkipped).toBe(true);
    expect(bound?.boundApp).toBe("app-abc");
  });

  test("flags dangling appId when appId attribute set but no app lists it", async () => {
    const { rows } = await runReconcileUntitledDrafts(makeOpts(true));
    // ut-bound has appId=app-999 but no app's workflowIds contains ut-bound
    const dangling = rows.find((r) => r.workflowId === "ut-bound");
    expect(dangling?.danglingAppId).toBe(true);
    expect(dangling?.boundSkipped).toBe(true);

    // ut-bound-app has no appId attribute but IS in app-abc's workflowIds
    const listed = rows.find((r) => r.workflowId === "ut-bound-app");
    expect(listed?.danglingAppId).toBe(false);
  });

  test("second run is idempotent — no more eligible drafts found after delete", async () => {
    await runReconcileUntitledDrafts(makeOpts(false));
    setupMock();
    const { summary, rows } = await runReconcileUntitledDrafts(makeOpts(true));
    // Bound-skipped rows persist; only eligible (deletable) rows are gone
    const eligible = rows.filter((r) => !r.boundSkipped);
    expect(eligible).toHaveLength(0);
    expect(summary.boundSkipped).toBe(2);
  });
});
