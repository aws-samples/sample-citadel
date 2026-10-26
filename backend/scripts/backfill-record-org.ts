/**
 * One-off backfill: stamps orgId on projection rows (and DRAFT registry
 * records) whose orgId is absent / orgUnknown.
 *
 * Context: 47 of 53 projection rows have orgId '' because the registry
 * never stored an org for pre-tagging agents and the backfill coerced
 * missing → ''. After the code fix (projection writers now leave orgId
 * absent and set orgUnknown: true), this script assigns the correct org
 * to those orphaned rows.
 *
 * For single-tenant dev where the owner confirms all pre-tagging records
 * belong to a single organisation (e.g. 'Default').
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
 *     --org Default --registry-id <id> --table-agents <table> --table-tools <table> \
 *     [--dry-run] [--apply]
 *
 * --dry-run (default): scans and reports what would change.
 * --apply:             writes orgId to projection rows and DRAFT registry records.
 * --org:               REQUIRED — the orgId to stamp.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { RegistryService } from "../src/services/registry-service";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: --org <orgId> --registry-id <id> --table-agents <table> --table-tools <table> [--apply] [--dry-run]";

const KNOWN_FLAGS = new Set([
  "--org",
  "--registry-id",
  "--table-agents",
  "--table-tools",
  "--apply",
  "--dry-run",
]);

export function parseArgs(argv: string[]): {
  org: string;
  registryId: string;
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
} {
  let org = "";
  let registryId = "";
  let tableAgents = "";
  let tableTools = "";
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      process.exit(1);
    }
    switch (arg) {
      case "--org":
        org = argv[++i];
        break;
      case "--registry-id":
        registryId = argv[++i];
        break;
      case "--table-agents":
        tableAgents = argv[++i];
        break;
      case "--table-tools":
        tableTools = argv[++i];
        break;
      case "--apply":
        dryRun = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  if (!org || !registryId || !tableAgents || !tableTools) {
    console.error(USAGE);
    process.exit(1);
  }
  return { org, registryId, tableAgents, tableTools, dryRun };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BackfillCounters {
  agentProjectionUpdated: number;
  toolProjectionUpdated: number;
  registryUpdated: number;
  skipped: number;
  errors: number;
}

async function scanOrphanedRows(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  _keyAttr: string,
): Promise<Record<string, unknown>[]> {
  const orphaned: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    for (const item of resp.Items ?? []) {
      // Match rows that have orgUnknown: true, OR orgId absent, OR orgId ''
      // (legacy coerced rows from the old backfill).
      const hasOrgUnknown = item.orgUnknown === true;
      const orgAbsent = item.orgId === undefined || item.orgId === null;
      const orgEmpty = item.orgId === "";

      // Only pick up projection rows (citadelKind present).
      if (!item.citadelKind) continue;

      if (hasOrgUnknown || orgAbsent || orgEmpty) {
        orphaned.push(item);
      }
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return orphaned;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackfillRecordOrg(
  org: string,
  registryId: string,
  tableAgents: string,
  tableTools: string,
  dryRun: boolean,
): Promise<BackfillCounters> {
  console.log(
    `Backfill record org: org=${org} registry=${registryId} agents=${tableAgents} tools=${tableTools} dryRun=${dryRun}`,
  );

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const registryService = new RegistryService({
    registryId,
    region: process.env.AWS_REGION || "us-east-1",
  });

  const counters: BackfillCounters = {
    agentProjectionUpdated: 0,
    toolProjectionUpdated: 0,
    registryUpdated: 0,
    skipped: 0,
    errors: 0,
  };

  // Scan agents table for orphaned rows
  const agentOrphans = await scanOrphanedRows(
    docClient,
    tableAgents,
    "agentId",
  );
  console.log(`Found ${agentOrphans.length} orphaned agent projection rows`);

  for (const item of agentOrphans) {
    const id = item.agentId as string;
    const kind = item.citadelKind as string;
    if (!id) {
      counters.skipped++;
      continue;
    }

    try {
      if (dryRun) {
        console.log(
          `[DRY-RUN] Would update ${kind} projection ${id}: orgId=${org}, remove orgUnknown`,
        );
      } else {
        await docClient.send(
          new UpdateCommand({
            TableName: tableAgents,
            Key: { agentId: id },
            UpdateExpression: "SET #orgId = :org REMOVE #orgUnknown",
            ExpressionAttributeNames: {
              "#orgId": "orgId",
              "#orgUnknown": "orgUnknown",
            },
            ExpressionAttributeValues: {
              ":org": org,
            },
          }),
        );
        console.log(`Updated agent projection ${id}: orgId=${org}`);
      }
      counters.agentProjectionUpdated++;

      // If DRAFT, also stamp the registry record descriptor
      const regStatus = item.registryStatus as string | undefined;
      const recordId =
        (item.registryRecordId as string) || (item.agentId as string);
      if (regStatus === "DRAFT" && recordId) {
        try {
          const record = await registryService.getResource("agent", recordId);
          if (record) {
            const meta = record.customDescriptorContent
              ? JSON.parse(record.customDescriptorContent)
              : {};
            meta.orgId = org;
            if (dryRun) {
              console.log(
                `[DRY-RUN] Would update DRAFT registry record ${recordId}: orgId=${org}`,
              );
            } else {
              await registryService.updateResource("agent", recordId, {
                customMetadata: JSON.stringify(meta),
              });
              console.log(
                `Updated DRAFT registry record ${recordId}: orgId=${org}`,
              );
            }
            counters.registryUpdated++;
          }
        } catch (err) {
          console.error(
            `Registry update for ${recordId} failed (non-fatal):`,
            err,
          );
          // Non-fatal: projection row is the priority
        }
      }
    } catch (err) {
      console.error(`Agent ${id}: error:`, err);
      counters.errors++;
    }
  }

  // Scan tools table for orphaned rows
  const toolOrphans = await scanOrphanedRows(docClient, tableTools, "toolId");
  console.log(`Found ${toolOrphans.length} orphaned tool projection rows`);

  for (const item of toolOrphans) {
    const id = item.toolId as string;
    if (!id) {
      counters.skipped++;
      continue;
    }

    try {
      if (dryRun) {
        console.log(
          `[DRY-RUN] Would update tool projection ${id}: orgId=${org}, remove orgUnknown`,
        );
      } else {
        await docClient.send(
          new UpdateCommand({
            TableName: tableTools,
            Key: { toolId: id },
            UpdateExpression: "SET #orgId = :org REMOVE #orgUnknown",
            ExpressionAttributeNames: {
              "#orgId": "orgId",
              "#orgUnknown": "orgUnknown",
            },
            ExpressionAttributeValues: {
              ":org": org,
            },
          }),
        );
        console.log(`Updated tool projection ${id}: orgId=${org}`);
      }
      counters.toolProjectionUpdated++;
    } catch (err) {
      console.error(`Tool ${id}: error:`, err);
      counters.errors++;
    }
  }

  console.log(
    `Done. agentProjection=${counters.agentProjectionUpdated} toolProjection=${counters.toolProjectionUpdated} registry=${counters.registryUpdated} skipped=${counters.skipped} errors=${counters.errors} dryRun=${dryRun}`,
  );

  return counters;
}

async function main(): Promise<void> {
  const { org, registryId, tableAgents, tableTools, dryRun } = parseArgs(
    process.argv.slice(2),
  );

  const counters = await runBackfillRecordOrg(
    org,
    registryId,
    tableAgents,
    tableTools,
    dryRun,
  );

  if (counters.errors > 0) process.exit(1);
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
