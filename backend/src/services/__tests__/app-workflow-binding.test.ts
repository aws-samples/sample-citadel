/**
 * Tests for AppWorkflowBindingService (CIT-286).
 *
 * Uses stateful in-memory fakes for both DynamoDB tables (workflows +
 * apps) and the registry service. Verifies that every writer leaves both
 * sides of the binding consistent, enforces the 1:1 constraint, and that
 * the reconciler detects and fixes each mismatch class.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  ScanCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  bind,
  unbind,
  unbindAll,
  clearApp,
  reconcileBindings,
  type BindingServiceDeps,
  type RegistryLike,
  type RegistryRecordLike,
} from "../../services/app-workflow-binding";

// ---------------------------------------------------------------------------
// Stateful in-memory fakes
// ---------------------------------------------------------------------------

/** In-memory DDB table fake: Map<pk, Record<string, unknown>> */
class FakeTable {
  readonly items = new Map<string, Record<string, unknown>>();
  constructor(private pkField: string) {}

  get(key: string): Record<string, unknown> | undefined {
    return this.items.get(key);
  }

  put(item: Record<string, unknown>): void {
    const pk = item[this.pkField] as string;
    this.items.set(pk, { ...item });
  }

  scan(): Record<string, unknown>[] {
    return Array.from(this.items.values());
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}

const workflowsTable = new FakeTable("workflowId");
const appsTable = new FakeTable("appId");

/** In-memory registry service mock. */
const registryRecords = new Map<string, RegistryRecordLike>();

function seedRegistry(appId: string, manifest: Record<string, unknown>): void {
  registryRecords.set(appId, {
    recordId: appId,
    name: "Test App",
    customDescriptorContent: JSON.stringify({ manifest }),
  });
}

function readRegistryManifest(appId: string): Record<string, unknown> {
  const record = registryRecords.get(appId);
  if (!record?.customDescriptorContent) return {};
  try {
    const d = JSON.parse(record.customDescriptorContent);
    return (d.manifest as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

const fakeRegistryService: RegistryLike = {
  async getResource(_type: string, id: string) {
    return registryRecords.get(id) ?? null;
  },
  async updateResource(_type: string, id: string, input) {
    const existing = registryRecords.get(id);
    if (!existing) throw new Error("Not found");
    const updated = {
      ...existing,
      ...(input.customMetadata !== undefined
        ? { customDescriptorContent: input.customMetadata }
        : {}),
    };
    registryRecords.set(id, updated);
    return updated;
  },
};

// ---------------------------------------------------------------------------
// DDB mock wiring
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

function resetFakes(): void {
  workflowsTable.items.clear();
  appsTable.items.clear();
  registryRecords.clear();
  ddbMock.reset();
  wireGetCommand();
  wireTransactWrite();
  wireScanCommand();
  wireUpdateCommand();
  wirePutCommand();
}

function wireGetCommand(): void {
  ddbMock.on(GetCommand).callsFake((input) => {
    const tableName: string = input.TableName;
    if (tableName === "test-workflows") {
      const item = workflowsTable.get(input.Key.workflowId);
      return { Item: item ? { ...item } : undefined };
    }
    if (tableName === "test-apps") {
      const item = appsTable.get(input.Key.appId);
      return { Item: item ? { ...item } : undefined };
    }
    return { Item: undefined };
  });
}

function wireTransactWrite(): void {
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    // Simulate TransactWrite by applying each item's update.
    for (const item of input.TransactItems) {
      if (item.Update) {
        const update = item.Update as {
          TableName: string;
          Key: Record<string, string>;
          UpdateExpression: string;
          ConditionExpression?: string;
          ExpressionAttributeNames?: Record<string, string>;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
        const table =
          update.TableName === "test-workflows" ? workflowsTable : appsTable;
        const pkField =
          update.TableName === "test-workflows" ? "workflowId" : "appId";
        const pk = update.Key[pkField];
        const existing = table.get(pk);

        if (!existing) {
          throw Object.assign(new Error("TransactionCanceledException"), {
            name: "TransactionCanceledException",
          });
        }

        // Check condition expression for 1:1 guard
        if (
          update.ConditionExpression &&
          update.ConditionExpression.includes("attribute_not_exists(#appId)")
        ) {
          const currentAppId = existing.appId as string | undefined;
          const targetAppId = update.ExpressionAttributeValues?.[":appId"] as
            string | undefined;
          if (
            currentAppId &&
            currentAppId !== "" &&
            currentAppId !== "undefined" &&
            currentAppId !== targetAppId
          ) {
            throw Object.assign(new Error("TransactionCanceledException"), {
              name: "TransactionCanceledException",
            });
          }
        }

        // Check condition for unbind: #appId = :thisApp
        if (update.ConditionExpression === "#appId = :thisApp") {
          const currentAppId = existing.appId as string | undefined;
          const expectedAppId = update.ExpressionAttributeValues?.[
            ":thisApp"
          ] as string | undefined;
          if (currentAppId !== expectedAppId) {
            throw Object.assign(new Error("TransactionCanceledException"), {
              name: "TransactionCanceledException",
            });
          }
        }

        // Apply the update expression (simplified).
        const names = update.ExpressionAttributeNames || {};
        const values = update.ExpressionAttributeValues || {};
        const updated = { ...existing };

        // Handle SET and REMOVE
        const expr = update.UpdateExpression;
        const removePart = expr.includes("REMOVE")
          ? expr.split("REMOVE")[1]?.split("SET")[0]?.trim()
          : "";
        const setPart = expr.includes("SET")
          ? expr
              .replace(/REMOVE\s+[^S]*/i, "")
              .replace(/^SET\s+/i, "")
              .trim()
          : "";

        if (removePart) {
          for (const token of removePart.split(",")) {
            const fieldRef = token.trim();
            const fieldName = names[fieldRef] || fieldRef;
            delete updated[fieldName];
          }
        }
        if (setPart) {
          for (const assignment of setPart.split(",")) {
            const [lhs, rhs] = assignment.split("=").map((s) => s.trim());
            if (!lhs || !rhs) continue;
            const fieldName = names[lhs] || lhs;
            updated[fieldName] = values[rhs];
          }
        }

        table.put(updated);
      }
    }
    return {};
  });
}

function wireScanCommand(): void {
  ddbMock.on(ScanCommand).callsFake((input) => {
    const tableName: string = input.TableName;
    if (tableName === "test-workflows") {
      return { Items: workflowsTable.scan(), LastEvaluatedKey: undefined };
    }
    if (tableName === "test-apps") {
      return { Items: appsTable.scan(), LastEvaluatedKey: undefined };
    }
    return { Items: [], LastEvaluatedKey: undefined };
  });
}

function wireUpdateCommand(): void {
  ddbMock.on(UpdateCommand).callsFake((input) => {
    const tableName: string = input.TableName;
    const table = tableName === "test-workflows" ? workflowsTable : appsTable;
    const pkField = tableName === "test-workflows" ? "workflowId" : "appId";
    const pk = Object.values(input.Key)[0] as string;
    const existing = table.get(pk) || { [pkField]: pk };
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};

    // Evaluate ConditionExpression for the reconcile-bindings optimistic lock.
    // Supports: "#wids = :prev" and "(attribute_not_exists(#wids) OR #wids = :prev)".
    const cond: string | undefined = input.ConditionExpression;
    if (cond) {
      const resolveField = (ref: string): unknown => {
        const field = names[ref] || ref;
        return existing[field];
      };

      if (cond.includes("#wids = :prev")) {
        const currentVal = resolveField("#wids");
        const expectedVal = values[":prev"];
        const eq =
          JSON.stringify(currentVal ?? null) ===
          JSON.stringify(expectedVal ?? null);

        if (cond.includes("attribute_not_exists")) {
          // (attribute_not_exists(#wids) OR #wids = :prev)
          const fieldName = names["#wids"] || "workflowIds";
          const notExists = !(fieldName in existing);
          if (!notExists && !eq) {
            throw Object.assign(new Error("ConditionalCheckFailedException"), {
              name: "ConditionalCheckFailedException",
            });
          }
        } else if (!eq) {
          throw Object.assign(new Error("ConditionalCheckFailedException"), {
            name: "ConditionalCheckFailedException",
          });
        }
      }
    }

    const updated = { ...existing };

    const expr: string = input.UpdateExpression;
    const removePart = expr.includes("REMOVE")
      ? expr.split("REMOVE")[1]?.split("SET")[0]?.trim()
      : "";
    const setPart = expr.includes("SET")
      ? expr
          .replace(/REMOVE\s+[^S]*/i, "")
          .replace(/^SET\s+/i, "")
          .trim()
      : "";

    if (removePart) {
      for (const token of removePart.split(",")) {
        const fieldRef = token.trim();
        const fieldName = names[fieldRef] || fieldRef;
        delete updated[fieldName];
      }
    }
    if (setPart) {
      // Handle list_append — need to be careful with commas inside function calls
      // Split assignments respecting parentheses depth
      const assignments: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of setPart) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          assignments.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
      if (current.trim()) assignments.push(current.trim());

      for (const assignment of assignments) {
        const eqIdx = assignment.indexOf("=");
        if (eqIdx < 0) continue;
        const lhs = assignment.slice(0, eqIdx).trim();
        const rhs = assignment.slice(eqIdx + 1).trim();
        const fieldName = names[lhs] || lhs;
        if (rhs.startsWith("list_append")) {
          // Extract the second argument from list_append(first, second)
          // Handle nested parentheses in first arg (e.g., if_not_exists(...))
          let depth = 0;
          let argStart = -1;
          for (let ci = 0; ci < rhs.length; ci++) {
            if (rhs[ci] === "(") depth++;
            if (rhs[ci] === ")") depth--;
            // When we're at depth 1 and hit a comma, the next token is the 2nd arg
            if (rhs[ci] === "," && depth === 1) {
              argStart = ci + 1;
              break;
            }
          }
          if (argStart >= 0) {
            const secondArg = rhs.slice(argStart, rhs.lastIndexOf(")")).trim();
            const addValue = values[secondArg];
            const cur = (updated[fieldName] as unknown[]) || [];
            updated[fieldName] = [...cur, ...(addValue as unknown[])];
          }
        } else {
          updated[fieldName] = values[rhs];
        }
      }
    }

    table.put(updated);
    return {};
  });
}

function wirePutCommand(): void {
  ddbMock.on(PutCommand).callsFake((input) => {
    const tableName: string = input.TableName;
    const table = tableName === "test-workflows" ? workflowsTable : appsTable;
    table.put({ ...input.Item });
    return {};
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const events: Array<{ type: string; detail: unknown }> = [];

function makeDeps(opts?: {
  registryService?: RegistryLike;
}): BindingServiceDeps {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    workflowsTable: "test-workflows",
    appsTable: "test-apps",
    registryService: opts?.registryService ?? fakeRegistryService,
    emitEvent: async (type, detail) => {
      events.push({ type, detail });
    },
  };
}

function seedWorkflow(id: string, appId?: string): void {
  workflowsTable.put({
    workflowId: id,
    orgId: "org-1",
    name: "Test Workflow",
    status: "DRAFT",
    ...(appId !== undefined ? { appId } : {}),
  });
}

function seedApp(id: string, workflowIds: string[] = []): void {
  appsTable.put({
    appId: id,
    orgId: "org-1",
    name: "Test App",
    workflowIds,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetFakes();
  events.length = 0;
});

describe("bind", () => {
  it("writes both sides atomically and mirrors to registry", async () => {
    seedWorkflow("wf-1");
    seedApp("app-1", []);
    seedRegistry("app-1", { workflowIds: [], version: 1 });

    await bind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    // Workflow side
    const wf = workflowsTable.get("wf-1");
    expect(wf?.appId).toBe("app-1");

    // App side
    const app = appsTable.get("app-1");
    expect(app?.workflowIds).toEqual(["wf-1"]);

    // Registry mirror
    const manifest = readRegistryManifest("app-1");
    expect(manifest.workflowIds).toEqual(["wf-1"]);

    // Event emitted
    expect(events).toEqual([
      {
        type: "app.workflow.bound",
        detail: expect.objectContaining({ appId: "app-1", workflowId: "wf-1" }),
      },
    ]);
  });

  it("is idempotent when workflow already bound to same app", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", ["wf-1"]);
    seedRegistry("app-1", { workflowIds: ["wf-1"], version: 1 });

    await bind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    // No extra entries
    expect((appsTable.get("app-1")?.workflowIds as string[]).length).toBe(1);
    // No event on idempotent call
    expect(events).toEqual([]);
  });

  it("refuses when workflow is already bound to another app (1:1 enforcement)", async () => {
    seedWorkflow("wf-1", "app-other");
    seedApp("app-1", []);

    await expect(
      bind(makeDeps(), "app-1", "wf-1", { userId: "user-1" }),
    ).rejects.toThrow("Workflow is already bound to another app");
  });

  it("throws when workflow not found (TransactWrite fails)", async () => {
    seedApp("app-1", []);
    // No workflow seeded — TransactWrite will fail

    await expect(
      bind(makeDeps(), "app-1", "nonexistent", { userId: "user-1" }),
    ).rejects.toThrow();
  });

  it("throws when app not found", async () => {
    seedWorkflow("wf-1");

    await expect(
      bind(makeDeps(), "nonexistent", "wf-1", { userId: "user-1" }),
    ).rejects.toThrow("App not found");
  });

  it("succeeds when registry mirror is absent (no registryService)", async () => {
    seedWorkflow("wf-1");
    seedApp("app-1", []);

    await bind(makeDeps({ registryService: undefined }), "app-1", "wf-1", {
      userId: "user-1",
    });

    expect(workflowsTable.get("wf-1")?.appId).toBe("app-1");
    expect(appsTable.get("app-1")?.workflowIds).toEqual(["wf-1"]);
  });
});

describe("unbind", () => {
  it("clears both sides and mirrors to registry", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", ["wf-1"]);
    seedRegistry("app-1", { workflowIds: ["wf-1"], version: 1 });

    await unbind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
    expect(appsTable.get("app-1")?.workflowIds).toEqual([]);

    const manifest = readRegistryManifest("app-1");
    expect(manifest.workflowIds).toEqual([]);

    expect(events).toEqual([
      {
        type: "app.workflow.unbound",
        detail: expect.objectContaining({ appId: "app-1", workflowId: "wf-1" }),
      },
    ]);
  });

  it("is idempotent when already unbound", async () => {
    seedWorkflow("wf-1");
    seedApp("app-1", []);

    await unbind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    // No event
    expect(events).toEqual([]);
  });

  it("no-ops when app is already deleted", async () => {
    seedWorkflow("wf-1", "app-1");

    await unbind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });
    // No throw
    expect(events).toEqual([]);
  });
});

describe("unbindAll", () => {
  it("clears appId on all bound workflows", async () => {
    seedWorkflow("wf-1", "app-1");
    seedWorkflow("wf-2", "app-1");
    seedWorkflow("wf-3", "app-other");
    seedApp("app-1", ["wf-1", "wf-2"]);

    await unbindAll(makeDeps(), "app-1", { userId: "user-1" });

    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
    expect(workflowsTable.get("wf-2")?.appId).toBeUndefined();
    // wf-3 untouched
    expect(workflowsTable.get("wf-3")?.appId).toBe("app-other");
  });

  it("is a no-op when app has no workflows", async () => {
    seedApp("app-1", []);

    await unbindAll(makeDeps(), "app-1", { userId: "user-1" });
    // No error
  });

  it("is a no-op when app doesn't exist", async () => {
    await unbindAll(makeDeps(), "nonexistent", { userId: "user-1" });
    // No error
  });
});

describe("clearApp", () => {
  it("delegates to unbindAll", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", ["wf-1"]);

    await clearApp(makeDeps(), "app-1");

    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
  });
});

describe("reconcileBindings", () => {
  it("detects orphan appId (app missing) and fixes with --fix", async () => {
    seedWorkflow("wf-1", "missing-app");

    const report = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(report.orphanAppIds).toContain("wf-1");

    // Fix mode
    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.fixed).toBeGreaterThanOrEqual(1);
    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
  });

  it("detects missing-from-list and fixes", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", []); // wf-1 NOT in list

    const report = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(report.missingFromList).toContain("wf-1");

    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.fixed).toBeGreaterThanOrEqual(1);
    const app = appsTable.get("app-1");
    expect(app?.workflowIds as string[]).toContain("wf-1");
  });

  it("detects dangling entries (workflow missing) and fixes", async () => {
    seedApp("app-1", ["wf-gone"]);

    const report = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(report.danglingEntries).toContain("app-1:wf-gone");

    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.fixed).toBeGreaterThanOrEqual(1);
    const app = appsTable.get("app-1");
    expect(app?.workflowIds as string[]).not.toContain("wf-gone");
  });

  it("detects cross-ref mismatch and fixes", async () => {
    seedWorkflow("wf-1", "app-other");
    seedApp("app-1", ["wf-1"]);

    const report = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(report.crossRefMismatches).toContain("app-1:wf-1:app-other");

    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.fixed).toBeGreaterThanOrEqual(1);
    const app = appsTable.get("app-1");
    expect(app?.workflowIds as string[]).not.toContain("wf-1");
  });

  it("reports zero issues for a consistent dataset", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", ["wf-1"]);

    const report = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(report.orphanAppIds).toHaveLength(0);
    expect(report.missingFromList).toHaveLength(0);
    expect(report.danglingEntries).toHaveLength(0);
    expect(report.crossRefMismatches).toHaveLength(0);
  });

  // Regression: missing-from-list fix must not be clobbered by cross-ref pass.
  // Reproduces the live incident where workflow 74e4554d was 'fixed' (appended)
  // then overwritten by the cross-ref cleanup writing from a stale snapshot.
  it("missing-from-list fix is NOT clobbered by cross-ref cleanup (live regression)", async () => {
    // Setup: app has list [A, B]; A's appId points elsewhere (cross-ref), B is valid.
    // Workflow C has appId=app but is NOT in the list (missing-from-list).
    seedWorkflow("wf-A", "app-other"); // cross-ref mismatch
    seedWorkflow("wf-B", "app-1"); // valid
    seedWorkflow("wf-C", "app-1"); // missing from list
    seedApp("app-other", []); // the app A points to
    seedApp("app-1", ["wf-A", "wf-B"]); // A is cross-ref, B valid, C missing

    const dryReport = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(dryReport.missingFromList).toContain("wf-C");
    expect(dryReport.crossRefMismatches).toContain("app-1:wf-A:app-other");

    // Fix pass.
    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.fixed).toBeGreaterThanOrEqual(1);
    expect(fixReport.errors).toBe(0);

    // The final list for app-1 must be exactly [wf-B, wf-C] (sorted).
    const app = appsTable.get("app-1");
    const finalList = [...(app?.workflowIds as string[])].sort();
    expect(finalList).toEqual(["wf-B", "wf-C"]);
  });

  // Property: after reconcile --fix, a second dry run reports zero mismatches
  // (idempotent convergence).
  it("idempotent convergence: fix then dry-run reports zero mismatches", async () => {
    // Build a complex inconsistent dataset.
    seedWorkflow("wf-orphan", "no-such-app");
    seedWorkflow("wf-missing", "app-1");
    seedWorkflow("wf-ok", "app-1");
    seedWorkflow("wf-xref", "app-2");
    seedApp("app-1", ["wf-ok", "wf-dangling"]); // wf-missing absent, wf-dangling gone
    seedApp("app-2", []); // wf-xref points here but not in list
    seedApp("app-3", ["wf-xref"]); // cross-ref: wf-xref.appId = app-2

    // First fix pass.
    const fixReport = await reconcileBindings({
      deps: makeDeps(),
      fix: true,
    });
    expect(fixReport.errors).toBe(0);

    // Second dry-run: must report zero issues.
    const dryReport = await reconcileBindings({
      deps: makeDeps(),
      fix: false,
    });
    expect(dryReport.orphanAppIds).toHaveLength(0);
    expect(dryReport.missingFromList).toHaveLength(0);
    expect(dryReport.danglingEntries).toHaveLength(0);
    expect(dryReport.crossRefMismatches).toHaveLength(0);
  });
});

describe("two-org negative", () => {
  it("bind in org-A does not affect org-B data", async () => {
    // Org-A data
    seedWorkflow("wf-a1");
    seedApp("app-a", []);
    seedRegistry("app-a", { workflowIds: [], version: 1 });

    // Org-B data
    workflowsTable.put({
      workflowId: "wf-b1",
      orgId: "org-2",
      name: "Org B Workflow",
      status: "DRAFT",
      appId: "app-b",
    });
    appsTable.put({
      appId: "app-b",
      orgId: "org-2",
      name: "Org B App",
      workflowIds: ["wf-b1"],
    });

    // Bind in org-A
    await bind(makeDeps(), "app-a", "wf-a1", { userId: "user-a" });

    // Org-B unchanged
    expect(workflowsTable.get("wf-b1")?.appId).toBe("app-b");
    expect(appsTable.get("app-b")?.workflowIds).toEqual(["wf-b1"]);
  });
});

describe("consistency after each writer path", () => {
  it("bind leaves both sides consistent", async () => {
    seedWorkflow("wf-1");
    seedApp("app-1", []);
    seedRegistry("app-1", { workflowIds: [], version: 1 });

    await bind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    expect(workflowsTable.get("wf-1")?.appId).toBe("app-1");
    expect(appsTable.get("app-1")?.workflowIds).toContain("wf-1");
  });

  it("unbind leaves both sides consistent", async () => {
    seedWorkflow("wf-1", "app-1");
    seedApp("app-1", ["wf-1"]);
    seedRegistry("app-1", { workflowIds: ["wf-1"], version: 1 });

    await unbind(makeDeps(), "app-1", "wf-1", { userId: "user-1" });

    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
    expect(appsTable.get("app-1")?.workflowIds).not.toContain("wf-1");
  });

  it("unbindAll + delete-app leaves workflows clean", async () => {
    seedWorkflow("wf-1", "app-1");
    seedWorkflow("wf-2", "app-1");
    seedApp("app-1", ["wf-1", "wf-2"]);

    await unbindAll(makeDeps(), "app-1", { userId: "user-1" });

    expect(workflowsTable.get("wf-1")?.appId).toBeUndefined();
    expect(workflowsTable.get("wf-2")?.appId).toBeUndefined();
  });
});
