/**
 * Backfill: writes projection rows for every agent and tool in the registry
 * so the LIST_FROM_PROJECTION read path has data without waiting for
 * individual EventBridge events.
 *
 * READ-ONLY on the registry — never modifies registry status.
 * Writes projection rows to the DynamoDB cache tables.
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

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): {
  registryId: string;
  tableAgents: string;
  tableTools: string;
  dryRun: boolean;
  delayMs: number;
  limit: number;
} {
  const args = process.argv.slice(2);
  let registryId = "";
  let tableAgents = "";
  let tableTools = "";
  let dryRun = true;
  let delayMs = 250;
  let limit = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--registry-id":
        registryId = args[++i];
        break;
      case "--table-agents":
        tableAgents = args[++i];
        break;
      case "--table-tools":
        tableTools = args[++i];
        break;
      case "--apply":
        dryRun = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--delay-ms":
        delayMs = Number(args[++i]);
        break;
      case "--limit":
        limit = Number(args[++i]);
        break;
    }
  }

  if (!registryId || !tableAgents || !tableTools) {
    console.error(
      "Usage: --registry-id <id> --table-agents <table> --table-tools <table> [--apply] [--delay-ms N] [--limit N]",
    );
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
    return {
      agentId: record.recordId,
      name: mapped.name,
      description: mapped.description,
      orgId: mapped.orgId ?? "",
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
  }

  // tool
  const mapped = registryService.mapToToolConfig(record);
  return {
    toolId: record.recordId,
    config: mapped.config,
    state: mapped.state,
    categories: mapped.categories || [],
    integrationBindings: meta.integrationBindings,
    dataStoreBindings: meta.dataStoreBindings,
    icon: meta.icon ?? "",
    appId: meta.appId,
    createdAt: record.createdAt?.toISOString() ?? now,
    updatedAt: record.updatedAt?.toISOString() ?? now,
    tags: meta.tags,
    citadelKind: "tool",
    projectionVersion: PROJECTION_VERSION,
    projectedAt: now,
    orgId: meta.orgId,
    createdBy: meta.createdBy,
    registryStatus: record.status,
    decidedBy: meta.decidedBy,
    decidedAt: meta.decidedAt,
    statusReason: meta.statusReason,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { registryId, tableAgents, tableTools, dryRun, delayMs, limit } =
    parseArgs();

  console.log(
    `Backfill list-projection: registry=${registryId} agents=${tableAgents} tools=${tableTools} dryRun=${dryRun} delayMs=${delayMs} limit=${limit || "unlimited"}`,
  );

  const registryService = new RegistryService({
    registryId,
    region: process.env.AWS_REGION || "us-east-1",
  });
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // List all records (agents first, then tools)
  const agentRecords = await registryService.listResources("agent");
  const toolRecords = await registryService.listResources("tool");
  console.log(
    `Found ${agentRecords.length} agent records, ${toolRecords.length} tool records`,
  );

  const counters = { agents: 0, tools: 0, skipped: 0, errors: 0 };
  let processed = 0;

  // Process agents
  for (const listRecord of agentRecords) {
    if (limit > 0 && processed >= limit) break;

    const kind = resolveKind(listRecord);
    if (kind !== "agent") {
      counters.skipped++;
      continue;
    }

    try {
      // Hydrate full record
      const record = await registryService.getResource(
        "agent",
        listRecord.recordId,
      );
      if (!record) {
        console.warn(
          `Agent ${listRecord.recordId}: not found on hydration, skipping`,
        );
        counters.skipped++;
        continue;
      }

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
      console.error(`Agent ${listRecord.recordId}: error:`, err);
      counters.errors++;
    }

    processed++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // Process tools
  for (const listRecord of toolRecords) {
    if (limit > 0 && processed >= limit) break;

    try {
      const record = await registryService.getResource(
        "tool",
        listRecord.recordId,
      );
      if (!record) {
        console.warn(
          `Tool ${listRecord.recordId}: not found on hydration, skipping`,
        );
        counters.skipped++;
        continue;
      }

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
      console.error(`Tool ${listRecord.recordId}: error:`, err);
      counters.errors++;
    }

    processed++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(
    `Done. agents=${counters.agents} tools=${counters.tools} skipped=${counters.skipped} errors=${counters.errors} dryRun=${dryRun}`,
  );
  if (counters.errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
