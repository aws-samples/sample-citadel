/**
 * Tests for reconcile-seeded-rows.ts
 *
 * Uses stateful in-memory fakes for DDB + S3 to verify:
 * - dry-run writes nothing
 * - apply collapses twins into canonical + pointer
 * - second apply is a no-op (idempotent)
 * - blueprint agentId rewrite from name → recordId
 * - conflicts are detected and skipped
 * - orgId 'Default' → 'system' on blueprints
 * - orgId '' → sentinel on agents
 */
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import type { NativeAttributeValue } from "@aws-sdk/lib-dynamodb";
import {
  runReconcile,
  parseArgs,
  isSeederOwnedRecordIdRow,
  isNameKeyedRow,
  buildCanonicalRow,
  buildPointerRow,
  detectConflict,
  type ReconcileOptions,
  type TwinPair,
} from "../reconcile-seeded-rows";

// ---------------------------------------------------------------------------
// Stateful fakes
// ---------------------------------------------------------------------------

class FakeDynamoTable {
  items: Map<string, Record<string, NativeAttributeValue>> = new Map();

  put(item: Record<string, NativeAttributeValue>): void {
    const key = String(item.agentId ?? item.workflowId ?? "");
    this.items.set(key, { ...item });
  }

  get(key: string): Record<string, NativeAttributeValue> | undefined {
    return this.items.get(key);
  }

  getAll(): Record<string, NativeAttributeValue>[] {
    return [...this.items.values()];
  }
}

class FakeS3 {
  objects: Set<string> = new Set();

  exists(key: string): boolean {
    return this.objects.has(key);
  }

  put(key: string): void {
    this.objects.add(key);
  }
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeNameKeyedRow(
  agentName: string,
  recordId: string,
  filename?: string,
): Record<string, NativeAttributeValue> {
  return {
    agentId: agentName,
    config: {
      name: agentName,
      ...(filename ? { filename } : {}),
      description: `${agentName} description`,
      schema: { type: "object" },
      version: "1",
      action: { type: "sqs", target: "queue-url" },
    },
    state: "active",
    categories: ["built-in", "worker", "demo"],
    orgId: "Default",
    registryStatus: "APPROVED",
    registryRecordId: recordId,
  };
}

function makeRecordIdRow(
  agentName: string,
  recordId: string,
): Record<string, NativeAttributeValue> {
  return {
    agentId: recordId,
    name: agentName,
    config: JSON.stringify({ description: `${agentName} description` }),
    state: "active",
    categories: ["built-in", "worker", "demo"],
    citadelKind: "agent",
    projectionVersion: 1,
    projectedAt: "2026-10-25T20:05:53.623Z",
    orgId: "Default",
    createdBy: "seedConfig",
    icon: "",
    description: `${agentName} description`,
    registryStatus: "APPROVED",
    registryRecordId: recordId,
    manifest: {
      name: agentName,
      description: `${agentName} description`,
      version: 1,
      tools: [],
    },
    createdAt: "2026-09-26T08:12:25.545Z",
  };
}

function makeBlueprint(
  name: string,
  agentIds: string[],
  orgId = "Default",
): Record<string, NativeAttributeValue> {
  const workflowId = `wf-${name.replace(/\s/g, "-").toLowerCase()}`;
  const nodes = agentIds.map((id, i) => ({
    id: `node-${i + 1}`,
    agentId: id,
    position: { x: 100 + i * 300, y: 200 },
    configuration: {},
  }));
  const edges =
    agentIds.length > 1
      ? agentIds.slice(0, -1).map((_, i) => ({
          id: `edge-${i + 1}`,
          source: `node-${i + 1}`,
          target: `node-${i + 2}`,
          sourceHandle: "output",
          targetHandle: "input",
        }))
      : [];

  return {
    workflowId,
    orgId,
    name,
    description: `${name} description`,
    status: "PUBLISHED",
    isBlueprint: "true",
    definition: JSON.stringify({
      nodes,
      edges,
      version: "1.0.0",
      id: workflowId,
      name,
    }),
    seedVersion: 2,
    createdBy: "system",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

function setupMocksFromFakes(
  agentTable: FakeDynamoTable,
  workflowTable: FakeDynamoTable,
  fakeS3: FakeS3,
): void {
  ddbMock.reset();
  s3Mock.reset();

  // ScanCommand: route by TableName
  ddbMock.on(ScanCommand).callsFake((input) => {
    const tableName = input.TableName;
    const table = tableName === "agents-table" ? agentTable : workflowTable;
    let items = table.getAll();

    // Apply FilterExpression for blueprint scan (simple pattern match)
    if (input.FilterExpression?.includes("isBlueprint")) {
      items = items.filter(
        (item) =>
          item.isBlueprint === "true" &&
          (item.orgId === "system" || item.orgId === "Default"),
      );
    }

    return { Items: items, Count: items.length };
  });

  // PutCommand: route by TableName
  ddbMock.on(PutCommand).callsFake((input) => {
    const tableName = input.TableName;
    const table = tableName === "agents-table" ? agentTable : workflowTable;
    table.put(input.Item as Record<string, NativeAttributeValue>);
    return {};
  });

  // HeadObjectCommand: check fakeS3
  s3Mock.on(HeadObjectCommand).callsFake((input) => {
    if (fakeS3.exists(input.Key!)) {
      return { ContentLength: 100 };
    }
    const err = new Error("Not Found");
    (err as unknown as { name: string }).name = "NotFound";
    throw err;
  });

  // CopyObjectCommand: add to fakeS3
  s3Mock.on(CopyObjectCommand).callsFake((input) => {
    fakeS3.put(input.Key!);
    return {};
  });
}

function makeReconcileOpts(
  overrides: Partial<ReconcileOptions> = {},
): ReconcileOptions {
  return {
    table: "agents-table",
    workflowsTable: "workflows-table",
    bucket: "agent-bucket",
    dryRun: true,
    orgSentinel: "All Organizations",
    names: null,
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3Client: new S3Client({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcile-seeded-rows", () => {
  afterEach(() => {
    ddbMock.reset();
    s3Mock.reset();
  });

  // ── Pure helpers ──────────────────────────────────────────────

  describe("parseArgs", () => {
    test("parses all flags correctly", () => {
      const result = parseArgs([
        "--table",
        "agents-tbl",
        "--workflows-table",
        "workflows-tbl",
        "--bucket",
        "my-bucket",
        "--apply",
        "--org-sentinel",
        "Custom Org",
        "--names",
        "demo-echo-agent,fabricator",
      ]);
      expect(result.table).toBe("agents-tbl");
      expect(result.workflowsTable).toBe("workflows-tbl");
      expect(result.bucket).toBe("my-bucket");
      expect(result.dryRun).toBe(false);
      expect(result.orgSentinel).toBe("Custom Org");
      expect(result.names).toEqual(["demo-echo-agent", "fabricator"]);
    });

    test("defaults to dry-run mode", () => {
      const result = parseArgs([
        "--table",
        "t",
        "--workflows-table",
        "w",
        "--bucket",
        "b",
      ]);
      expect(result.dryRun).toBe(true);
    });

    test("throws when --table is missing", () => {
      expect(() =>
        parseArgs(["--workflows-table", "w", "--bucket", "b"]),
      ).toThrow("--table");
    });

    test("throws when --workflows-table is missing", () => {
      expect(() => parseArgs(["--table", "t", "--bucket", "b"])).toThrow(
        "--workflows-table",
      );
    });

    test("throws when --bucket is missing", () => {
      expect(() =>
        parseArgs(["--table", "t", "--workflows-table", "w"]),
      ).toThrow("--bucket");
    });
  });

  describe("isSeederOwnedRecordIdRow", () => {
    test("returns true for seedConfig + 12-char recordId key", () => {
      expect(
        isSeederOwnedRecordIdRow({
          agentId: "mjaKkVyqoFGN",
          createdBy: "seedConfig",
        }),
      ).toBe(true);
    });

    test("returns false for non-seedConfig createdBy", () => {
      expect(
        isSeederOwnedRecordIdRow({
          agentId: "mjaKkVyqoFGN",
          createdBy: "user",
        }),
      ).toBe(false);
    });

    test("returns false for name-keyed agentId", () => {
      expect(
        isSeederOwnedRecordIdRow({
          agentId: "demo-echo-agent",
          createdBy: "seedConfig",
        }),
      ).toBe(false);
    });
  });

  describe("isNameKeyedRow", () => {
    test("returns true for name-keyed row with registryRecordId", () => {
      expect(
        isNameKeyedRow({
          agentId: "demo-echo-agent",
          registryRecordId: "mjaKkVyqoFGN",
        }),
      ).toBe(true);
    });

    test("returns false when agentId equals registryRecordId", () => {
      expect(
        isNameKeyedRow({
          agentId: "mjaKkVyqoFGN",
          registryRecordId: "mjaKkVyqoFGN",
        }),
      ).toBe(false);
    });

    test("returns false when registryRecordId is absent", () => {
      expect(isNameKeyedRow({ agentId: "demo-echo-agent" })).toBe(false);
    });
  });

  describe("detectConflict", () => {
    test("returns null when no conflict exists", () => {
      const nameRow = { config: { filename: "agent.py" } };
      const recordIdRow = { config: { description: "sparse" } };
      expect(detectConflict(nameRow, recordIdRow)).toBeNull();
    });

    test("returns conflict when filenames disagree", () => {
      const nameRow = { config: { filename: "a.py" } };
      const recordIdRow = { config: { filename: "b.py" } };
      const result = detectConflict(nameRow, recordIdRow);
      expect(result).toContain("Conflicting config.filename");
    });
  });

  describe("buildCanonicalRow", () => {
    test("merges name row config into canonical row", () => {
      const pair: TwinPair = {
        agentName: "demo-echo-agent",
        recordId: "mjaKkVyqoFGN",
        nameRow: makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
        recordIdRow: makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"),
      };
      const row = buildCanonicalRow(pair, "All Organizations");
      expect(row.agentId).toBe("mjaKkVyqoFGN");
      expect(row.name).toBe("demo-echo-agent");
      expect((row.config as Record<string, unknown>).filename).toBe(
        "demo_echo_agent.py",
      );
      expect(row.citadelKind).toBe("agent");
      expect(row.projectionVersion).toBe(1);
      expect(row.orgId).toBe("All Organizations");
      expect(row.createdBy).toBe("seedConfig");
    });
  });

  describe("buildPointerRow", () => {
    test("builds a thin pointer with _canonicalRecordId", () => {
      const pair: TwinPair = {
        agentName: "demo-echo-agent",
        recordId: "mjaKkVyqoFGN",
        nameRow: makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
        recordIdRow: makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"),
      };
      const row = buildPointerRow(pair, "All Organizations");
      expect(row.agentId).toBe("demo-echo-agent");
      expect(row._canonicalRecordId).toBe("mjaKkVyqoFGN");
      expect(row.orgId).toBe("All Organizations");
      expect(row.config).toBeUndefined();
    });
  });

  // ── Integration: dry-run ───────────────────────────────────────

  describe("dry-run mode", () => {
    test("makes zero DDB writes and zero S3 copies", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      // Seed twin pairs
      agentTable.put(
        makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
      );
      agentTable.put(makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"));
      agentTable.put(makeNameKeyedRow("fabricator", "6WsQHauFdu4h"));
      agentTable.put(makeRecordIdRow("fabricator", "6WsQHauFdu4h"));
      agentTable.put(
        makeNameKeyedRow(
          "smoke-idempotency-agent",
          "obEoj56JCATf",
          "smoke_idempotency_agent.py",
        ),
      );
      agentTable.put(
        makeRecordIdRow("smoke-idempotency-agent", "obEoj56JCATf"),
      );

      // Seed blueprints
      workflowTable.put(
        makeBlueprint("Echo Demo Workflow", [
          "demo-echo-agent",
          "demo-echo-agent",
        ]),
      );
      workflowTable.put(
        makeBlueprint("Idempotency Smoke Workflow", [
          "smoke-idempotency-agent",
        ]),
      );

      fakeS3.put("agents/demo_echo_agent.py");
      fakeS3.put("agents/smoke_idempotency_agent.py");

      // Snapshot state before
      const agentRowsBefore = agentTable.getAll().map((r) => ({ ...r }));
      const workflowRowsBefore = workflowTable.getAll().map((r) => ({ ...r }));

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      const { summary } = await runReconcile(
        makeReconcileOpts({ dryRun: true }),
      );

      expect(summary.twinsFound).toBe(3);
      expect(summary.twinsCollapsed).toBe(3);
      expect(summary.s3Copies).toBe(2); // echo + smoke (fabricator has no filename)
      expect(summary.blueprintsRewritten).toBe(2);

      // Verify no actual DDB writes happened (state unchanged)
      const agentRowsAfter = agentTable.getAll();
      const workflowRowsAfter = workflowTable.getAll();
      expect(agentRowsAfter).toEqual(agentRowsBefore);
      expect(workflowRowsAfter).toEqual(workflowRowsBefore);

      // Verify no actual S3 copies happened
      expect(fakeS3.exists("agents/mjaKkVyqoFGN/demo_echo_agent.py")).toBe(
        false,
      );
    });
  });

  // ── Integration: apply mode ────────────────────────────────────

  describe("apply mode", () => {
    test("collapses twins into canonical + pointer", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      agentTable.put(
        makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
      );
      agentTable.put(makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"));
      agentTable.put(
        makeNameKeyedRow(
          "smoke-idempotency-agent",
          "obEoj56JCATf",
          "smoke_idempotency_agent.py",
        ),
      );
      agentTable.put(
        makeRecordIdRow("smoke-idempotency-agent", "obEoj56JCATf"),
      );

      workflowTable.put(
        makeBlueprint("Echo Demo Workflow", [
          "demo-echo-agent",
          "demo-echo-agent",
        ]),
      );

      fakeS3.put("agents/demo_echo_agent.py");
      fakeS3.put("agents/smoke_idempotency_agent.py");

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      const { summary } = await runReconcile(
        makeReconcileOpts({ dryRun: false }),
      );

      expect(summary.twinsCollapsed).toBe(2);
      expect(summary.s3Copies).toBe(2);
      expect(summary.blueprintsRewritten).toBe(1);
      expect(summary.errors).toBe(0);

      // Canonical row has full config + projection fields
      const canonical = agentTable.get("mjaKkVyqoFGN");
      expect(canonical).toBeDefined();
      expect((canonical!.config as Record<string, unknown>).filename).toBe(
        "demo_echo_agent.py",
      );
      expect(canonical!.citadelKind).toBe("agent");
      expect(canonical!.orgId).toBe("All Organizations");
      expect(canonical!.createdBy).toBe("seedConfig");

      // Name-keyed row is thin pointer
      const pointer = agentTable.get("demo-echo-agent");
      expect(pointer).toBeDefined();
      expect(pointer!._canonicalRecordId).toBe("mjaKkVyqoFGN");
      expect(pointer!.config).toBeUndefined();
      expect(pointer!.orgId).toBe("All Organizations");

      // S3 scoped keys exist
      expect(fakeS3.exists("agents/mjaKkVyqoFGN/demo_echo_agent.py")).toBe(
        true,
      );
      expect(
        fakeS3.exists("agents/obEoj56JCATf/smoke_idempotency_agent.py"),
      ).toBe(true);

      // Blueprint rewritten
      const bp = workflowTable.get("wf-echo-demo-workflow");
      expect(bp).toBeDefined();
      const def = JSON.parse(bp!.definition as string);
      expect(def.nodes[0].agentId).toBe("mjaKkVyqoFGN");
      expect(def.nodes[0].legacyAgentName).toBe("demo-echo-agent");
      expect(def.nodes[1].agentId).toBe("mjaKkVyqoFGN");
    });

    test("second apply is a no-op (idempotent)", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      agentTable.put(
        makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
      );
      agentTable.put(makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"));
      workflowTable.put(
        makeBlueprint("Echo Demo Workflow", [
          "demo-echo-agent",
          "demo-echo-agent",
        ]),
      );
      fakeS3.put("agents/demo_echo_agent.py");

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      // First apply
      await runReconcile(makeReconcileOpts({ dryRun: false }));

      // Snapshot after first apply
      const canonicalAfterFirst = { ...agentTable.get("mjaKkVyqoFGN")! };
      const _pointerAfterFirst = { ...agentTable.get("demo-echo-agent")! };

      // Reset mocks and re-setup for second run
      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      // Second apply — should find canonical rows already correct
      const { summary: summary2 } = await runReconcile(
        makeReconcileOpts({ dryRun: false }),
      );

      // The second run still finds twins (because the pointer still has
      // registryRecordId pointing to a different agentId), but the
      // writes are idempotent PutItem with identical data.
      expect(summary2.errors).toBe(0);

      // Data is unchanged
      const canonicalAfterSecond = agentTable.get("mjaKkVyqoFGN");
      expect(canonicalAfterSecond!.agentId).toBe(canonicalAfterFirst.agentId);
      expect(
        (canonicalAfterSecond!.config as Record<string, unknown>).filename,
      ).toBe((canonicalAfterFirst.config as Record<string, unknown>).filename);
    });

    test("blueprint orgId 'Default' is fixed to 'system'", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      agentTable.put(
        makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
      );
      agentTable.put(makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"));
      workflowTable.put(
        makeBlueprint(
          "Echo Demo Workflow",
          ["demo-echo-agent", "demo-echo-agent"],
          "Default",
        ),
      );

      fakeS3.put("agents/demo_echo_agent.py");

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      await runReconcile(makeReconcileOpts({ dryRun: false }));

      const bp = workflowTable.get("wf-echo-demo-workflow");
      expect(bp!.orgId).toBe("system");
    });
  });

  // ── Conflict handling ──────────────────────────────────────────

  describe("conflict handling", () => {
    test("skips and reports conflicting twins", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      // Create a conflict: name row and recordId row have different filenames
      const nameRow = makeNameKeyedRow(
        "demo-echo-agent",
        "mjaKkVyqoFGN",
        "agent_v1.py",
      );
      const recordIdRow = makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN");
      // Give recordId row a DIFFERENT full config with filename
      recordIdRow.config = {
        filename: "agent_v2.py",
        description: "different",
        schema: {},
        version: "2",
      };
      agentTable.put(nameRow);
      agentTable.put(recordIdRow);

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      const { summary } = await runReconcile(
        makeReconcileOpts({ dryRun: false }),
      );

      expect(summary.conflicts).toBe(1);
      expect(summary.twinsCollapsed).toBe(0);
    });
  });

  // ── Filter by --names ──────────────────────────────────────────

  describe("--names filter", () => {
    test("only reconciles agents in the names list", async () => {
      const agentTable = new FakeDynamoTable();
      const workflowTable = new FakeDynamoTable();
      const fakeS3 = new FakeS3();

      agentTable.put(
        makeNameKeyedRow(
          "demo-echo-agent",
          "mjaKkVyqoFGN",
          "demo_echo_agent.py",
        ),
      );
      agentTable.put(makeRecordIdRow("demo-echo-agent", "mjaKkVyqoFGN"));
      agentTable.put(makeNameKeyedRow("fabricator", "6WsQHauFdu4h"));
      agentTable.put(makeRecordIdRow("fabricator", "6WsQHauFdu4h"));

      fakeS3.put("agents/demo_echo_agent.py");

      setupMocksFromFakes(agentTable, workflowTable, fakeS3);

      const { summary } = await runReconcile(
        makeReconcileOpts({
          dryRun: false,
          names: ["demo-echo-agent"],
        }),
      );

      // Only demo-echo-agent should be reconciled
      expect(summary.twinsCollapsed).toBe(1);

      // fabricator should remain unchanged
      const fabricator = agentTable.get("fabricator");
      expect(fabricator!.config).toBeDefined();
      expect(fabricator!._canonicalRecordId).toBeUndefined();
    });
  });
});
