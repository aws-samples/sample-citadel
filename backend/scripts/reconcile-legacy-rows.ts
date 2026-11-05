/**
 * Reconcile: identifies and optionally deletes orphan legacy rows from the
 * agent and tool cache tables.
 *
 * Orphan rows are rows that:
 *   1. Are NOT projection rows (no projectionVersion attribute)
 *   2. Are NOT pointer rows (no _canonicalRecordId attribute)
 *   3. Are NOT decision# rows (toolId does not start with 'decision#')
 *   4. Have no registryRecordId (not a duplicate of a registry-backed record)
 *
 * These are pre-registry manual test entries with no backing registry record.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/reconcile-legacy-rows.ts \
 *     --table-agents <AGENT_CONFIG_TABLE> --table-tools <TOOLS_CONFIG_TABLE> \
 *     [--dry-run] [--delete-orphans]
 *
 * --dry-run (default): scans and reports orphan rows; no deletes.
 * --delete-orphans:    deletes identified orphan rows. Idempotent — safe to re-run.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export interface OrphanRow {
  tableName: string;
  key: string;
  name: string;
  orgId: string;
  createdAt: string;
  kind: "agent" | "tool";
}

export interface ReconcileLegacySummary {
  agentsScanned: number;
  toolsScanned: number;
  agentOrphansFound: number;
  toolOrphansFound: number;
  deleted: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Arg parsing (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
}

const KNOWN_FLAGS = new Set([
  "--table-agents",
  "--table-tools",
  "--dry-run",
  "--delete-orphans",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  let tableAgents = "";
  let tableTools = "";
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
    switch (arg) {
      case "--table-agents":
        tableAgents = argv[++i];
        break;
      case "--table-tools":
        tableTools = argv[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--delete-orphans":
        dryRun = false;
        break;
    }
  }

  if (!tableAgents || !tableTools) {
    console.error(
      "Usage: --table-agents <table> --table-tools <table> [--dry-run | --delete-orphans]",
    );
    process.exit(1);
  }
  return { tableAgents, tableTools, dryRun };
}

// ---------------------------------------------------------------------------
// Classification helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns true when the row is a projection row (has projectionVersion).
 */
export function isProjectionRow(
  item: Record<string, NativeAttributeValue>,
): boolean {
  return (
    item.projectionVersion !== undefined && item.projectionVersion !== null
  );
}

/**
 * Returns true when the row is a pointer row (has _canonicalRecordId).
 */
export function isPointerRow(
  item: Record<string, NativeAttributeValue>,
): boolean {
  return (
    item._canonicalRecordId !== undefined && item._canonicalRecordId !== null
  );
}

/**
 * Returns true when the row is a decision# side-row (tool table only).
 */
export function isDecisionRow(
  item: Record<string, NativeAttributeValue>,
): boolean {
  const id = String(item.toolId ?? "");
  return id.startsWith("decision#");
}

/**
 * Returns true when the row has a registryRecordId (is a known duplicate
 * of a registry-backed record — filtered out by the merge step).
 */
export function hasRegistryRecordId(
  item: Record<string, NativeAttributeValue>,
): boolean {
  return (
    typeof item.registryRecordId === "string" &&
    item.registryRecordId.length > 0
  );
}

/**
 * Returns true when the row is an orphan — not a projection, pointer,
 * decision, or registry-linked row.
 */
export function isOrphanRow(
  item: Record<string, NativeAttributeValue>,
  kind: "agent" | "tool",
): boolean {
  if (isProjectionRow(item)) return false;
  if (isPointerRow(item)) return false;
  if (kind === "tool" && isDecisionRow(item)) return false;
  if (hasRegistryRecordId(item)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Core reconciliation (exported for tests)
// ---------------------------------------------------------------------------

export interface ReconcileLegacyOptions {
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
  docClient: DynamoDBDocumentClient;
}

export async function runReconcileLegacy(
  opts: ReconcileLegacyOptions,
): Promise<{ summary: ReconcileLegacySummary; orphans: OrphanRow[] }> {
  const { tableAgents, tableTools, dryRun, docClient } = opts;

  const summary: ReconcileLegacySummary = {
    agentsScanned: 0,
    toolsScanned: 0,
    agentOrphansFound: 0,
    toolOrphansFound: 0,
    deleted: 0,
    errors: 0,
  };

  const orphans: OrphanRow[] = [];

  console.log(
    `[reconcile-legacy-rows] Mode: ${dryRun ? "DRY-RUN" : "DELETE-ORPHANS"} ` +
      `agents=${tableAgents} tools=${tableTools}`,
  );

  // Scan agents table
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableAgents,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      summary.agentsScanned++;
      if (isOrphanRow(item, "agent")) {
        const key = String(item.agentId ?? "");
        const name = typeof item.name === "string" ? item.name : key;
        orphans.push({
          tableName: tableAgents,
          key,
          name,
          orgId: String(item.orgId ?? ""),
          createdAt: String(item.createdAt ?? ""),
          kind: "agent",
        });
        summary.agentOrphansFound++;
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  // Scan tools table
  exclusiveStartKey = undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableTools,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      summary.toolsScanned++;
      if (isOrphanRow(item, "tool")) {
        const key = String(item.toolId ?? "");
        const name = (() => {
          try {
            const config =
              typeof item.config === "string"
                ? JSON.parse(item.config)
                : item.config;
            return typeof config?.name === "string" ? config.name : key;
          } catch {
            return key;
          }
        })();
        orphans.push({
          tableName: tableTools,
          key,
          name,
          orgId: String(item.orgId ?? ""),
          createdAt: String(item.createdAt ?? ""),
          kind: "tool",
        });
        summary.toolOrphansFound++;
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  // Report orphans
  for (const orphan of orphans) {
    console.log(
      `[reconcile-legacy-rows] ${dryRun ? "WOULD DELETE" : "DELETING"} ` +
        `${orphan.kind} orphan: key=${orphan.key} name=${orphan.name} ` +
        `orgId=${orphan.orgId} createdAt=${orphan.createdAt}`,
    );
  }

  // Delete if not dry-run
  if (!dryRun) {
    for (const orphan of orphans) {
      try {
        const keyAttr = orphan.kind === "agent" ? "agentId" : "toolId";
        await docClient.send(
          new DeleteCommand({
            TableName: orphan.tableName,
            Key: { [keyAttr]: orphan.key },
            // Conflict-safe: only delete if the row is still NOT a
            // projection/pointer/decision row (guards against a concurrent
            // registry-sync that may have upgraded the row).
            ConditionExpression:
              "attribute_not_exists(projectionVersion) AND " +
              "attribute_not_exists(#canonicalRecordId)" +
              (orphan.kind === "tool"
                ? " AND NOT begins_with(toolId, :dp)"
                : ""),
            ExpressionAttributeNames: {
              "#canonicalRecordId": "_canonicalRecordId",
            },
            ...(orphan.kind === "tool"
              ? {
                  ExpressionAttributeValues: { ":dp": "decision#" },
                }
              : {}),
          }),
        );
        summary.deleted++;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          console.log(
            `[reconcile-legacy-rows] Skipped ${orphan.key} — row was upgraded concurrently`,
          );
          continue;
        }
        console.error(
          `[reconcile-legacy-rows] Delete failed for ${orphan.key}:`,
          err,
        );
        summary.errors++;
      }
    }
  }

  console.log("[reconcile-legacy-rows] --- Summary ---");
  console.log(JSON.stringify(summary));

  return { summary, orphans };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || "us-west-2";
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const { summary } = await runReconcileLegacy({
    ...args,
    docClient,
  });

  if (summary.errors > 0) process.exit(1);
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    console.error("[reconcile-legacy-rows] Fatal:", err);
    process.exit(1);
  });
}
