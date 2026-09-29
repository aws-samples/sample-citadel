/**
 * One-off, idempotent backfill: denormalizes the Registry's approval
 * status onto existing AGENT_CONFIG_TABLE cache rows that predate the
 * registryStatus/registryRecordId/statusUpdatedAt fields introduced by
 * registry-sync.ts / ensure-agent-config-rows.ts (see
 * backend/src/lambda/approval-cache-fields.ts for the field-name
 * contract).
 *
 * For each scanned row:
 *   - Legacy slug-keyed rows (no registryRecordId AND agentId does not
 *     look like a 12-char alphanumeric Registry recordId) never had a
 *     Registry record to begin with — skipped, counted as skippedLegacy.
 *   - Otherwise, agentId is treated as the Registry recordId and fetched
 *     via GetRegistryRecord (RegistryService.getResource). A
 *     ResourceNotFoundException leaves the row untouched and is counted
 *     as notFound.
 *   - On success, a conditional UpdateItem SETs registryStatus,
 *     registryRecordId, and statusUpdatedAt, plus createdAt only if the
 *     row doesn't already have one (from record.createdAt).
 *
 * Usage:
 *   ts-node backend/scripts/backfill-registry-status.ts --table <table> --registry-id <id> [--dry-run]
 *
 * Constraints:
 *   - Idempotent — re-running finds the fields already set and simply
 *     overwrites them with the same values (no drift, no duplicate work).
 *   - --dry-run performs the Scan and GetRegistryRecord lookups but issues
 *     no writes.
 *   - Never logs account ids — only agentId/recordId (both opaque
 *     Registry-assigned identifiers, no ARNs are printed).
 *   - Per-row errors are logged and counted; the scan continues. The
 *     process exits non-zero if any errors occurred.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  RegistryService,
  RegistryRecord,
} from "../src/services/registry-service";
import {
  REGISTRY_STATUS_FIELD,
  REGISTRY_RECORD_ID_FIELD,
  STATUS_UPDATED_AT_FIELD,
} from "../src/lambda/approval-cache-fields";

// ---------------------------------------------------------------------------
// Pure logic helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Registry recordIds are 12-char alphanumeric strings (AgentCore Registry
 * convention — see RegistryService.extractRecordIdFromArn's own use of the
 * same shape). Legacy slug-keyed agentIds never match this. */
const RECORD_ID_SHAPE = /^[A-Za-z0-9]{12}$/;

export interface AgentCacheItemShape {
  agentId: string;
  registryRecordId?: string | null;
  createdAt?: string | null;
}

/**
 * Returns true when `item` is a legacy slug-keyed row with no Registry
 * record behind it — i.e. it has no `registryRecordId` AND its `agentId`
 * does not look like a 12-char alphanumeric Registry recordId. Such rows
 * predate the Registry entirely and must be skipped rather than probed.
 */
export function isLegacyRow(item: AgentCacheItemShape): boolean {
  const hasRecordId =
    typeof item.registryRecordId === "string" &&
    item.registryRecordId.length > 0;
  if (hasRecordId) return false;
  return !RECORD_ID_SHAPE.test(item.agentId);
}

export interface Summary {
  scanned: number;
  updated: number;
  skippedLegacy: number;
  notFound: number;
  errors: number;
}

function emptySummary(): Summary {
  return { scanned: 0, updated: 0, skippedLegacy: 0, notFound: 0, errors: 0 };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[backfill-registry-status] ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  table: string;
  registryId: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let table: string | undefined;
  let registryId: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--table") {
      table = argv[++i];
    } else if (arg === "--registry-id") {
      registryId = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!table) throw new Error("--table <agents table> is required");
  if (!registryId) throw new Error("--registry-id <id> is required");

  return { table, registryId, dryRun };
}

// ---------------------------------------------------------------------------
// Per-row processing
// ---------------------------------------------------------------------------

async function processItem(
  item: Record<string, NativeAttributeValue>,
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  dryRun: boolean,
  summary: Summary,
): Promise<void> {
  summary.scanned++;
  const agentId = String(item.agentId);

  if (isLegacyRow(item as AgentCacheItemShape)) {
    summary.skippedLegacy++;
    return;
  }

  let record: RegistryRecord | null;
  try {
    record = await registry.getResource("agent", agentId);
  } catch (err) {
    log("error", `agentId=${agentId} GetRegistryRecord failed: ${String(err)}`);
    summary.errors++;
    return;
  }

  if (!record) {
    summary.notFound++;
    log("warn", `agentId=${agentId} not found in registry; row left untouched`);
    return;
  }

  const hasCreatedAt =
    typeof item.createdAt === "string" && item.createdAt.length > 0;
  const createdAt = record.createdAt
    ? record.createdAt.toISOString()
    : undefined;

  if (dryRun) {
    summary.updated++;
    log(
      "info",
      `agentId=${agentId} recordId=${record.recordId} -> registryStatus=${record.status} (dry-run)`,
    );
    return;
  }

  const names: Record<string, string> = {
    "#status": REGISTRY_STATUS_FIELD,
    "#recordId": REGISTRY_RECORD_ID_FIELD,
    "#statusUpdatedAt": STATUS_UPDATED_AT_FIELD,
  };
  const values: Record<string, NativeAttributeValue> = {
    ":status": record.status,
    ":recordId": record.recordId,
    ":statusUpdatedAt": new Date().toISOString(),
  };
  let updateExpr =
    "SET #status = :status, #recordId = :recordId, #statusUpdatedAt = :statusUpdatedAt";

  if (!hasCreatedAt && createdAt !== undefined) {
    names["#createdAt"] = "createdAt";
    values[":createdAt"] = createdAt;
    updateExpr += ", #createdAt = :createdAt";
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { agentId },
        ConditionExpression: "attribute_exists(agentId)",
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    summary.updated++;
    log(
      "info",
      `agentId=${agentId} recordId=${record.recordId} -> registryStatus=${record.status} (updated)`,
    );
  } catch (err) {
    log("error", `agentId=${agentId} UpdateItem failed: ${String(err)}`);
    summary.errors++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackfill(
  tableName: string,
  registryId: string,
  dryRun: boolean,
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
): Promise<Summary> {
  const summary = emptySummary();
  log(
    "info",
    `Mode: ${dryRun ? "DRY-RUN" : "APPLY"} table=${tableName} registryId=${registryId}`,
  );

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
      await processItem(item, registry, docClient, tableName, dryRun, summary);
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  return summary;
}

export async function main(): Promise<void> {
  const { table, registryId, dryRun } = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || "us-west-2";

  const registry = new RegistryService({ registryId, region });
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const summary = await runBackfill(
    table,
    registryId,
    dryRun,
    registry,
    docClient,
  );

  log("info", "--- Backfill summary ---");
  console.log(JSON.stringify(summary));

  if (summary.errors > 0) {
    process.exit(1);
  }
}

/**
 * Entry-point guard that works under BOTH module systems this script is
 * actually invoked with (see backfill-org-ids.ts for the full rationale):
 *   - ts-node / ts-jest (CommonJS): checked via `require.main === module`.
 *   - Node's native TypeScript execution (ESM): `require` is undefined.
 */
const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    log("error", `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
