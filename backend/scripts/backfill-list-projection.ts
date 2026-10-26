/**
 * Backfill: writes projection rows for every agent and tool in the registry
 * so the LIST_FROM_PROJECTION read path has data without waiting for
 * individual EventBridge events.
 *
 * READ-ONLY on the registry — never modifies registry status.
 * Writes projection rows to the DynamoDB cache tables.
 *
 * Throttle-safe: records are read STRICTLY sequentially (one
 * GetRegistryRecord at a time) with a configurable inter-call delay
 * (`--delay-ms`, default 250). Retries use exponential backoff with jitter
 * (base 1 s, max 6 attempts) and honour 'Request rate exceeded' as
 * retryable. See lib/registry-sequential-reader.ts.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-list-projection.ts \
 *     --registry-id <id> --table-agents <agents-table> --table-tools <tools-table> \
 *     [--dry-run] [--apply] [--delay-ms 250] [--limit 0]
 *
 * --dry-run (default): reads registry, logs what would be written, no writes.
 * --apply:             writes projection rows to DynamoDB.
 * --delay-ms:          delay between GetRegistryRecord calls (default 250ms).
 * --limit:             max records to process (0 = unlimited, default 0).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  RegistryService,
  type RegistryRecord,
} from "../src/services/registry-service";
import { resolveKind } from "../src/utils/citadel-kind";
import { readRegistrySequentially } from "./lib/registry-sequential-reader";
import { buildFullToolConfig } from "../src/lambda/registry-sync";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: --registry-id <id> --table-agents <table> --table-tools <table> [--apply] [--dry-run] [--delay-ms N] [--limit N]";

const KNOWN_FLAGS = new Set([
  "--registry-id",
  "--table-agents",
  "--table-tools",
  "--apply",
  "--dry-run",
  "--delay-ms",
  "--limit",
]);

export function parseArgs(argv: string[]): {
  registryId: string;
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
  delayMs: number;
  limit: number;
} {
  let registryId = "";
  let tableAgents = "";
  let tableTools = "";
  let dryRun = true;
  let delayMs = 250;
  let limit = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      process.exit(1);
    }
    switch (arg) {
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
        // No-op alias — dry run is the default.
        dryRun = true;
        break;
      case "--delay-ms":
        delayMs = Number(argv[++i]);
        break;
      case "--limit":
        limit = Number(argv[++i]);
        break;
    }
  }

  if (!registryId || !tableAgents || !tableTools) {
    console.error(USAGE);
    process.exit(1);
  }
  return { registryId, tableAgents, tableTools, dryRun, delayMs, limit };
}

// ---------------------------------------------------------------------------
// Projection row builder (mirrors registry-sync.ts)
// ---------------------------------------------------------------------------

const PROJECTION_VERSION = 1;

function buildProjectionItem(
  record: RegistryRecord,
  kind: "agent" | "tool",
  registryService: RegistryService,
): Record<string, unknown> {
  const meta = registryService.deserializeCustomMetadata<
    Record<string, unknown>
  >(record.customDescriptorContent ?? null, {});
  const now = new Date().toISOString();

  if (kind === "agent") {
    const mapped = registryService.mapToAgentConfig(record);
    const sourceOrgId = mapped.orgId;
    const orgUnknown = sourceOrgId === undefined || sourceOrgId === null;
    const item: Record<string, unknown> = {
      agentId: record.recordId,
      name: mapped.name,
      description: mapped.description,
      config: mapped.config,
      state: mapped.state,
      categories: mapped.categories || [],
      manifest: meta.manifest,
      icon: meta.icon ?? "",
      appId: meta.appId,
      createdBy: meta.createdBy,
      sourceProjectId: meta.sourceProjectId,
      createdAt: record.createdAt?.toISOString() ?? now,
      updatedAt: record.updatedAt?.toISOString() ?? now,
      registryStatus: record.status,
      registryRecordId: record.recordId,
      statusUpdatedAt: now,
      tags: meta.tags,
      citadelKind: "agent",
      projectionVersion: PROJECTION_VERSION,
      projectedAt: now,
      decidedBy: meta.decidedBy,
      decidedAt: meta.decidedAt,
      statusReason: meta.statusReason,
    };
    if (orgUnknown) {
      // Leave orgId absent (do NOT coerce to '') — mark as unknown so
      // readers can fail-closed.
      item.orgUnknown = true;
    } else {
      item.orgId = sourceOrgId;
    }
    return item;
  }

  // tool — use the shared buildFullToolConfig to produce the same full
  // config JSON that buildToolProjectionRow in registry-sync.ts writes,
  // so rerunning the backfill repairs the 132 sparse rows.
  const fullConfig = buildFullToolConfig(
    meta.config as string | undefined,
    record.description,
    record.name,
  );
  const toolOrgId = meta.orgId as string | undefined;
  const toolOrgUnknown = toolOrgId === undefined;
  const toolItem: Record<string, unknown> = {
    toolId: record.recordId,
    config: fullConfig,
    description: record.description ?? "",
    name: record.name ?? "",
    state: registryService.mapToToolConfig(record).state,
    categories: (meta.categories as string[]) || [],
    integrationBindings: meta.integrationBindings,
    dataStoreBindings: meta.dataStoreBindings,
    icon: (meta.icon as string) ?? "",
    appId: meta.appId,
    createdAt: record.createdAt?.toISOString() ?? now,
    updatedAt: record.updatedAt?.toISOString() ?? now,
    tags: meta.tags,
    citadelKind: "tool",
    projectionVersion: PROJECTION_VERSION,
    projectedAt: now,
    createdBy: meta.createdBy,
    registryStatus: record.status,
    decidedBy: meta.decidedBy,
    decidedAt: meta.decidedAt,
    statusReason: meta.statusReason,
  };
  if (toolOrgUnknown) {
    toolItem.orgUnknown = true;
  } else {
    toolItem.orgId = toolOrgId;
  }
  return toolItem;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runProjectionBackfill(
  registryId: string,
  tableAgents: string,
  tableTools: string,
  dryRun: boolean,
  delayMs: number,
  limit: number,
): Promise<{ agents: number; tools: number; skipped: number; errors: number }> {
  console.log(
    `Backfill list-projection: registry=${registryId} agents=${tableAgents} tools=${tableTools} dryRun=${dryRun} delayMs=${delayMs} limit=${limit || "unlimited"}`,
  );

  const registryService = new RegistryService({
    registryId,
    region: process.env.AWS_REGION || "us-east-1",
  });
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // Sequential read — no concurrent N+1 fan-out.
  const {
    agents: agentRecords,
    tools: toolRecords,
    errors: fetchErrors,
  } = await readRegistrySequentially(registryService, { delayMs, limit });

  console.log(
    `Found ${agentRecords.length} agent records, ${toolRecords.length} tool records`,
  );

  const counters = { agents: 0, tools: 0, skipped: 0, errors: fetchErrors };

  // Process agents
  for (const record of agentRecords) {
    const kind = resolveKind(record);
    if (kind !== "agent") {
      counters.skipped++;
      continue;
    }

    try {
      const item = buildProjectionItem(record, "agent", registryService);
      if (dryRun) {
        console.log(
          `[DRY-RUN] Would write agent projection: ${record.recordId} (${record.name})`,
        );
      } else {
        await docClient.send(
          new PutCommand({ TableName: tableAgents, Item: item }),
        );
        console.log(
          `Wrote agent projection: ${record.recordId} (${record.name})`,
        );
      }
      counters.agents++;
    } catch (err) {
      console.error(`Agent ${record.recordId}: error:`, err);
      counters.errors++;
    }
  }

  // Process tools
  for (const record of toolRecords) {
    try {
      const item = buildProjectionItem(record, "tool", registryService);
      if (dryRun) {
        console.log(
          `[DRY-RUN] Would write tool projection: ${record.recordId} (${record.name})`,
        );
      } else {
        await docClient.send(
          new PutCommand({ TableName: tableTools, Item: item }),
        );
        console.log(
          `Wrote tool projection: ${record.recordId} (${record.name})`,
        );
      }
      counters.tools++;
    } catch (err) {
      console.error(`Tool ${record.recordId}: error:`, err);
      counters.errors++;
    }
  }

  console.log(
    `Done. agents=${counters.agents} tools=${counters.tools} skipped=${counters.skipped} errors=${counters.errors} dryRun=${dryRun}`,
  );

  return counters;
}

async function main(): Promise<void> {
  const { registryId, tableAgents, tableTools, dryRun, delayMs, limit } =
    parseArgs(process.argv.slice(2));

  const counters = await runProjectionBackfill(
    registryId,
    tableAgents,
    tableTools,
    dryRun,
    delayMs,
    limit,
  );

  if (counters.errors > 0) process.exit(1);
}

/**
 * Entry-point guard (CommonJS via ts-node or ESM — see
 * backfill-registry-status.ts for full rationale).
 */
const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
