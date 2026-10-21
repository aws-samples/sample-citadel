/**
 * One-off reconcile: for every name-keyed agents-table row whose
 * registryRecordId points to a recordId-keyed row with a newer
 * registryStatus, copies the approval fields (registryStatus,
 * statusUpdatedAt, decidedBy) from the recordId row onto the name row.
 *
 * Never creates new rows. Only updates existing name-keyed rows whose
 * registryRecordId differs from their agentId (i.e. the agentId IS the
 * name, not the recordId).
 *
 * Usage:
 *   ts-node backend/scripts/reconcile-approval-cache.ts \
 *     --table <AGENT_CONFIG_TABLE> [--dry-run]
 *
 * --dry-run (default): scans and reports mismatches; no writes.
 * --apply: performs the corrective UpdateItem writes.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  REGISTRY_STATUS_FIELD,
  REGISTRY_RECORD_ID_FIELD,
  STATUS_UPDATED_AT_FIELD,
} from "../src/lambda/approval-cache-fields";

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  scanned: number;
  stale: number;
  fixed: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const RECORD_ID_SHAPE = /^[A-Za-z0-9]{12}$/;

/**
 * Returns true when the row is a name-keyed row whose registryRecordId
 * points to a different (recordId-keyed) row.
 */
export function isNameKeyedRowWithRecordId(
  item: Record<string, NativeAttributeValue>,
): boolean {
  const agentId = item.agentId;
  const recordId = item[REGISTRY_RECORD_ID_FIELD];
  if (typeof agentId !== "string" || typeof recordId !== "string") return false;
  if (recordId === "" || agentId === recordId) return false;
  // The agentId should NOT look like a recordId (it should be a name)
  return !RECORD_ID_SHAPE.test(agentId);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[reconcile-approval-cache] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  table: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let table: string | undefined;
  let dryRun = true; // default

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--table") {
      table = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      dryRun = false;
    }
  }

  if (!table) throw new Error("--table <agents table> is required");
  return { table, dryRun };
}

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

export async function runReconcile(
  tableName: string,
  dryRun: boolean,
  docClient: DynamoDBDocumentClient,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    scanned: 0,
    stale: 0,
    fixed: 0,
    skipped: 0,
    errors: 0,
  };

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"} table=${tableName}`);

  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    let page;
    try {
      page = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      log("error", `Scan failed: ${String(err)}`);
      summary.errors++;
      return summary;
    }

    for (const item of page.Items ?? []) {
      summary.scanned++;

      if (!isNameKeyedRowWithRecordId(item)) {
        summary.skipped++;
        continue;
      }

      const agentId = item.agentId as string;
      const recordId = item[REGISTRY_RECORD_ID_FIELD] as string;
      const nameStatus = item[REGISTRY_STATUS_FIELD] as string | undefined;

      // Fetch the recordId-keyed row
      let recordIdRow: Record<string, unknown> | undefined;
      try {
        const result = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { agentId: recordId },
          }),
        );
        recordIdRow = result.Item as Record<string, unknown> | undefined;
      } catch (err) {
        log(
          "error",
          `agentId="${agentId}": GetItem for recordId="${recordId}" failed: ${String(err)}`,
        );
        summary.errors++;
        continue;
      }

      if (!recordIdRow) {
        summary.skipped++;
        continue;
      }

      const recordIdStatus = recordIdRow[REGISTRY_STATUS_FIELD] as
        string | undefined;

      // Compare: if the recordId row has a newer/different status, copy it
      if (recordIdStatus === undefined || recordIdStatus === nameStatus) {
        summary.skipped++;
        continue;
      }

      summary.stale++;
      log(
        "info",
        `STALE: agentId="${agentId}" recordId="${recordId}" ` +
          `nameStatus=${nameStatus ?? "UNSET"} -> recordIdStatus=${recordIdStatus}`,
      );

      if (dryRun) continue;

      // Apply fix
      const now = new Date().toISOString();
      const names: Record<string, string> = {
        "#agentId": "agentId",
        "#registryStatus": REGISTRY_STATUS_FIELD,
        "#statusUpdatedAt": STATUS_UPDATED_AT_FIELD,
      };
      const values: Record<string, unknown> = {
        ":registryStatus": recordIdStatus,
        ":statusUpdatedAt":
          (recordIdRow[STATUS_UPDATED_AT_FIELD] as string) ?? now,
      };
      let updateExpr =
        "SET #registryStatus = :registryStatus, #statusUpdatedAt = :statusUpdatedAt";

      // Copy decidedBy if the recordId row has it
      const decidedBy = recordIdRow.decidedBy as string | undefined;
      if (decidedBy !== undefined) {
        names["#decidedBy"] = "decidedBy";
        values[":decidedBy"] = decidedBy;
        updateExpr += ", #decidedBy = :decidedBy";
      }

      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { agentId },
            ConditionExpression: "attribute_exists(#agentId)",
            UpdateExpression: updateExpr,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        summary.fixed++;
        log(
          "info",
          `FIXED: agentId="${agentId}" registryStatus=${recordIdStatus}`,
        );
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          summary.skipped++;
          continue;
        }
        log("error", `agentId="${agentId}": UpdateItem failed: ${String(err)}`);
        summary.errors++;
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { table, dryRun } = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || "us-west-2";
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const summary = await runReconcile(table, dryRun, docClient);

  log("info", "--- Reconcile summary ---");
  console.log(JSON.stringify(summary));

  if (summary.errors > 0) {
    process.exit(1);
  }
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    log("error", `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
