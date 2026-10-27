/**
 * One-off backfill: stamps orgId on projection rows (and DRAFT registry
 * records) whose orgId is absent.
 *
 * Context: 12 agent rows and 25 tool rows have orgId absent. The 25 tool
 * rows with absent orgId are all `decision#<id>` bookkeeping keys (not
 * actual tools) — these are always skipped. 9 agent rows and 1 tool row
 * carry orgId 'All Organizations' — also always skipped.
 *
 * By default the script only considers rows that have a citadelKind
 * attribute (projection rows). With --include-unkinded it also considers
 * rows lacking citadelKind whose orgId is absent — but ALWAYS skips keys
 * starting with `decision#` (bookkeeping, not records) and rows with
 * orgId 'All Organizations'.
 *
 * Dual-key cache twin resolution (PR #369): an agent/tool may have two
 * rows — one keyed by a recordId (UUID) and one keyed by its display
 * name (agentId == name).  For each candidate, the twin is resolved from
 * an in-memory index built from the full table scan (the script already
 * reads every row).  If the twin carries a non-absent orgId, the
 * candidate inherits that value (even 'All Organizations').  Otherwise
 * the --org flag value is stamped.  Dry-run output includes the resolved
 * orgId and its source (twin | flag) for each candidate.
 *
 * For single-tenant dev where the owner confirms all pre-tagging records
 * belong to a single organisation (e.g. 'Default').
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/backfill-record-org.ts \
 *     --org Default --registry-id <id> --table-agents <table> --table-tools <table> \
 *     [--dry-run] [--apply] [--include-unkinded]
 *
 * --dry-run (default):  scans and reports what would change.
 * --apply:              writes orgId to projection rows and DRAFT registry records.
 * --org:                REQUIRED — the orgId to stamp (used when no twin provides one).
 * --include-unkinded:   also consider rows lacking citadelKind whose orgId is
 *                       absent (default: off). Keys starting `decision#` and
 *                       rows with orgId 'All Organizations' are NEVER touched.
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
  "Usage: --org <orgId> --registry-id <id> --table-agents <table> --table-tools <table> [--apply] [--dry-run] [--include-unkinded]";

const KNOWN_FLAGS = new Set([
  "--org",
  "--registry-id",
  "--table-agents",
  "--table-tools",
  "--apply",
  "--dry-run",
  "--include-unkinded",
]);

export function parseArgs(argv: string[]): {
  org: string;
  registryId: string;
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
  includeUnkinded: boolean;
} {
  let org = "";
  let registryId = "";
  let tableAgents = "";
  let tableTools = "";
  let dryRun = true;
  let includeUnkinded = false;

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
      case "--include-unkinded":
        includeUnkinded = true;
        break;
    }
  }

  if (!org || !registryId || !tableAgents || !tableTools) {
    console.error(USAGE);
    process.exit(1);
  }
  return { org, registryId, tableAgents, tableTools, dryRun, includeUnkinded };
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

/** Sentinel orgId that marks system/shared rows — never overwritten. */
const ALL_ORGANIZATIONS = "All Organizations";

/** Key prefix for decision bookkeeping rows — never actual records. */
const DECISION_KEY_PREFIX = "decision#";

interface ScanResult {
  orphaned: Record<string, unknown>[];
  allItems: Record<string, unknown>[];
}

async function scanOrphanedRows(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  keyAttr: string,
  includeUnkinded: boolean = false,
): Promise<ScanResult> {
  const orphaned: Record<string, unknown>[] = [];
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    for (const item of resp.Items ?? []) {
      allItems.push(item);
      const key = (item[keyAttr] as string) ?? "";

      // ALWAYS skip decision bookkeeping rows (not records).
      if (key.startsWith(DECISION_KEY_PREFIX)) continue;

      // ALWAYS skip system rows.
      if (item.orgId === ALL_ORGANIZATIONS) continue;

      const hasOrgUnknown = item.orgUnknown === true;
      const orgAbsent = item.orgId === undefined || item.orgId === null;
      const hasKind = !!item.citadelKind;

      // Default: only pick up rows with citadelKind present.
      // --include-unkinded: also pick up rows lacking citadelKind whose orgId is absent.
      if (hasKind) {
        if (hasOrgUnknown || orgAbsent) {
          orphaned.push(item);
        }
      } else if (includeUnkinded && orgAbsent) {
        orphaned.push(item);
      }
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return { orphaned, allItems };
}

/**
 * Dual-key cache twin lookup (PR #369).
 *
 * An agent may have two rows: one keyed by a recordId (UUID) and one
 * keyed by the display name (agentId == name).  For a candidate whose
 * orgId is absent, look up its twin:
 *
 *   - candidate is recordId-keyed → twin key = candidate.name
 *   - candidate is name-keyed     → twin is the row whose `name` field
 *     equals candidate's key (found via the full-table items already
 *     scanned, to avoid N+1 queries)
 *
 * If the twin has a non-absent orgId the candidate INHERITS it
 * (including 'All Organizations').  Otherwise the --org flag value is
 * used.
 */
interface ResolvedOrg {
  orgId: string;
  source: "twin" | "flag";
}

/**
 * Build an in-memory index: name → rows for fast twin lookup.
 */
function buildNameIndex(
  allItems: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const idx = new Map<string, Record<string, unknown>[]>();
  for (const item of allItems) {
    const name = item.name as string | undefined;
    if (!name) continue;
    let arr = idx.get(name);
    if (!arr) {
      arr = [];
      idx.set(name, arr);
    }
    arr.push(item);
  }
  return idx;
}

/**
 * Build an in-memory index: key → row for fast key lookup.
 */
function buildKeyIndex(
  allItems: Record<string, unknown>[],
  keyAttr: string,
): Map<string, Record<string, unknown>> {
  const idx = new Map<string, Record<string, unknown>>();
  for (const item of allItems) {
    const key = item[keyAttr] as string | undefined;
    if (key) idx.set(key, item);
  }
  return idx;
}

function resolveTwinOrg(
  keyAttr: string,
  candidate: Record<string, unknown>,
  nameIndex: Map<string, Record<string, unknown>[]>,
  keyIndex: Map<string, Record<string, unknown>>,
  flagOrg: string,
): ResolvedOrg {
  const candidateKey = candidate[keyAttr] as string;
  const candidateName = (candidate.name as string) ?? "";

  // Heuristic: if the key is a UUID the candidate is recordId-keyed;
  // otherwise it is name-keyed (agentId == display name).
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isRecordIdKeyed = UUID_RE.test(candidateKey);

  if (isRecordIdKeyed && candidateName) {
    // Twin is the name-keyed row: key = candidate.name
    const twinItem = keyIndex.get(candidateName);
    if (twinItem && twinItem !== candidate && twinItem.orgId != null) {
      return { orgId: twinItem.orgId as string, source: "twin" };
    }
  } else {
    // Candidate is name-keyed; twin is the recordId-keyed row whose
    // `name` field equals the candidate's key.
    const siblings = nameIndex.get(candidateKey) ?? [];
    for (const sibling of siblings) {
      if (sibling !== candidate && sibling[keyAttr] !== candidateKey) {
        if (sibling.orgId != null) {
          return { orgId: sibling.orgId as string, source: "twin" };
        }
      }
    }
  }

  return { orgId: flagOrg, source: "flag" };
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
  includeUnkinded: boolean = false,
): Promise<BackfillCounters> {
  console.log(
    `Backfill record org: org=${org} registry=${registryId} agents=${tableAgents} tools=${tableTools} dryRun=${dryRun} includeUnkinded=${includeUnkinded}`,
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
  const { orphaned: agentOrphans, allItems: allAgentItems } =
    await scanOrphanedRows(docClient, tableAgents, "agentId", includeUnkinded);
  const agentNameIndex = buildNameIndex(allAgentItems);
  const agentKeyIndex = buildKeyIndex(allAgentItems, "agentId");
  console.log(`Found ${agentOrphans.length} orphaned agent projection rows`);

  for (const item of agentOrphans) {
    const id = item.agentId as string;
    const _kind = item.citadelKind as string | undefined;
    if (!id) {
      counters.skipped++;
      continue;
    }

    try {
      // Dual-key twin resolution (PR #369)
      const resolved = resolveTwinOrg(
        "agentId",
        item,
        agentNameIndex,
        agentKeyIndex,
        org,
      );
      const stampOrg = resolved.orgId;

      if (dryRun) {
        console.log(
          `[DRY-RUN] Would update agent: key=${id} name=${item.name ?? "(none)"} orgId=${stampOrg} source=${resolved.source} hasRecordId=${!!item.registryRecordId} createdAt=${item.createdAt ?? "(none)"}`,
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
              ":org": stampOrg,
            },
          }),
        );
        console.log(
          `Updated agent projection ${id}: orgId=${stampOrg} (${resolved.source})`,
        );
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
            meta.orgId = stampOrg;
            if (dryRun) {
              console.log(
                `[DRY-RUN] Would update DRAFT registry record ${recordId}: orgId=${stampOrg}`,
              );
            } else {
              await registryService.updateResource("agent", recordId, {
                customMetadata: JSON.stringify(meta),
              });
              console.log(
                `Updated DRAFT registry record ${recordId}: orgId=${stampOrg}`,
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
  const { orphaned: toolOrphans, allItems: allToolItems } =
    await scanOrphanedRows(docClient, tableTools, "toolId", includeUnkinded);
  const toolNameIndex = buildNameIndex(allToolItems);
  const toolKeyIndex = buildKeyIndex(allToolItems, "toolId");
  console.log(`Found ${toolOrphans.length} orphaned tool projection rows`);

  for (const item of toolOrphans) {
    const id = item.toolId as string;
    if (!id) {
      counters.skipped++;
      continue;
    }

    try {
      // Dual-key twin resolution (PR #369)
      const resolved = resolveTwinOrg(
        "toolId",
        item,
        toolNameIndex,
        toolKeyIndex,
        org,
      );
      const stampOrg = resolved.orgId;

      if (dryRun) {
        console.log(
          `[DRY-RUN] Would update tool: key=${id} name=${item.name ?? "(none)"} orgId=${stampOrg} source=${resolved.source} hasRecordId=${!!item.registryRecordId} createdAt=${item.createdAt ?? "(none)"}`,
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
              ":org": stampOrg,
            },
          }),
        );
        console.log(
          `Updated tool projection ${id}: orgId=${stampOrg} (${resolved.source})`,
        );
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
  const { org, registryId, tableAgents, tableTools, dryRun, includeUnkinded } =
    parseArgs(process.argv.slice(2));

  const counters = await runBackfillRecordOrg(
    org,
    registryId,
    tableAgents,
    tableTools,
    dryRun,
    includeUnkinded,
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
