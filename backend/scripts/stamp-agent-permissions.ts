/**
 * stamp-agent-permissions — stamps requiredPermissions or credentialMode
 * on registry agent records that lack them.
 *
 * Dry-run by default; pass --apply to write.
 * Exits non-zero if errors > 0.
 *
 * Flags:
 *   --apply              Write mode (default: dry-run)
 *   --record-id <id>     Process only the specified record (canary mode)
 *   --limit N            Process at most N records (canary mode)
 *
 * Canary usage: run with --record-id on a single APPROVED record first to
 * confirm it ends APPROVED, then widen to --limit N, then full --apply.
 *
 * Required env:
 *   REGISTRY_ID           — AgentCore Registry id
 *   MODEL_CONFIG_TABLE    — DynamoDB table for model-selection config
 *                           (citadel-model-config-{env})
 *   MODEL_CATALOG_TABLE   — DynamoDB table for model catalog
 *                           (citadel-model-catalog-{env})
 *   AWS_REGION            — optional, defaults to us-west-2
 *
 * The script resolves each non-pure-compute agent's foundation model id
 * from the model-selection configuration: per-agent modelOverride from
 * bindings → fabricated_agent_default slot default → global default.
 * Refuses to stamp (error, non-zero exit) if no model can be resolved.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  RegistryService,
  RegistryRecord,
} from "../src/services/registry-service";
import {
  applyMarkerEdit,
  MarkerEditOptions,
  MarkerEditResult,
  AllowedMarkerField,
} from "../src/utils/marker-registry-edit";

// ---------------------------------------------------------------------------
// Pure-compute detection: agents with a filename but no integration/dataStore
// bindings and whose name matches a known pure-compute pattern.
// ---------------------------------------------------------------------------

const KNOWN_PURE_COMPUTE_NAMES = new Set([
  "demo-echo-agent",
  "Echo Demo Agent",
  "demo-router-agent",
  "Conditional Router",
  "smoke-idempotency-agent",
]);

interface ParsedDescriptor {
  config?: Record<string, unknown>;
  requiredPermissions?: Record<string, unknown>;
  credentialMode?: string;
  integrationBindings?: unknown[];
  dataStoreBindings?: unknown[];
}

function parseDescriptor(record: RegistryRecord): ParsedDescriptor | null {
  try {
    return record.customDescriptorContent
      ? JSON.parse(record.customDescriptorContent)
      : null;
  } catch {
    return null;
  }
}

function isPureCompute(
  name: string | undefined,
  _meta: ParsedDescriptor,
): boolean {
  // Only known pure-compute agents (no model calls) get credentialMode:none.
  // All other agents are treated as model-calling — safer to stamp
  // requiredPermissions.models (vends scoped credentials) than to stamp
  // credentialMode:none (zero credentials).
  return KNOWN_PURE_COMPUTE_NAMES.has(name ?? "");
}

function alreadyStamped(meta: ParsedDescriptor): boolean {
  const hasRP =
    meta.requiredPermissions &&
    typeof meta.requiredPermissions === "object" &&
    Array.isArray(
      (meta.requiredPermissions as Record<string, unknown>).models,
    ) &&
    ((meta.requiredPermissions as Record<string, unknown>).models as unknown[])
      .length > 0;
  const hasCM =
    typeof meta.credentialMode === "string" && meta.credentialMode !== "";
  return !!(hasRP || hasCM);
}

// ---------------------------------------------------------------------------
// Model resolution: resolve the foundation model id for a non-pure-compute
// agent from the model-selection configuration tables.
//
// Precedence: agent's per-binding modelOverride (descriptor.config.modelOverride)
//   → fabricated_agent_default slot default → global default.
//
// Uses foundation model ids (baseModelId, e.g. "anthropic.claude-sonnet-5"),
// not inference-profile ids — matching the vender's convention.
// ---------------------------------------------------------------------------

interface ModelConfigRow {
  globalDefaultKey?: string | null;
  slotDefaults?: Record<string, string>;
  agentOverrides?: Record<string, string>;
}

interface CatalogRow {
  modelKey: string;
  baseModelId: string;
  status: string;
  regionProfiles?: Record<string, string>;
}

/** Loaded once and reused across all records. */
interface ModelContext {
  config: ModelConfigRow | null;
  catalog: Map<string, CatalogRow>;
}

async function loadModelContext(
  docClient: DynamoDBDocumentClient,
  configTable: string,
  catalogTable: string,
): Promise<ModelContext> {
  let config: ModelConfigRow | null = null;
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: configTable, Key: { scope: "platform" } }),
    );
    config = (result.Item as ModelConfigRow) ?? null;
  } catch (err) {
    log(`WARN: failed to read model config: ${String(err)}`);
  }

  const catalog = new Map<string, CatalogRow>();
  try {
    const result = await docClient.send(
      new ScanCommand({ TableName: catalogTable }),
    );
    for (const item of result.Items ?? []) {
      const row = item as CatalogRow;
      if (row.modelKey) catalog.set(row.modelKey, row);
    }
  } catch (err) {
    log(`WARN: failed to scan model catalog: ${String(err)}`);
  }

  return { config, catalog };
}

/**
 * Resolve the foundation model id for an agent.
 *
 * Returns the baseModelId or null if no model can be resolved.
 */
export function resolveAgentModel(
  meta: ParsedDescriptor,
  modelCtx: ModelContext,
): string | null {
  // 1. Per-agent modelOverride from descriptor
  const agentModelOverride =
    meta.config && typeof meta.config === "object"
      ? (meta.config as Record<string, unknown>).modelOverride
      : undefined;
  if (typeof agentModelOverride === "string" && agentModelOverride) {
    const entry = modelCtx.catalog.get(agentModelOverride);
    if (entry && entry.status === "enabled" && entry.baseModelId) {
      return entry.baseModelId;
    }
  }

  if (!modelCtx.config) return null;

  // 2. fabricated_agent_default slot default
  const slotKey = modelCtx.config.slotDefaults?.fabricated_agent_default;
  if (slotKey) {
    const entry = modelCtx.catalog.get(slotKey);
    if (entry && entry.status === "enabled" && entry.baseModelId) {
      return entry.baseModelId;
    }
  }

  // 3. Global default
  const globalKey = modelCtx.config.globalDefaultKey;
  if (globalKey) {
    const entry = modelCtx.catalog.get(globalKey);
    if (entry && entry.status === "enabled" && entry.baseModelId) {
      return entry.baseModelId;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface StampSummary {
  scanned: number;
  stamped: number;
  skipped: number;
  reapproved: number;
  errors: number;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [stamp-agent-permissions] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;

  // Canary flags
  const recordIdIdx = args.indexOf("--record-id");
  const targetRecordId =
    recordIdIdx >= 0 && args[recordIdIdx + 1]
      ? args[recordIdIdx + 1]
      : undefined;
  const limitIdx = args.indexOf("--limit");
  const limitN =
    limitIdx >= 0 && args[limitIdx + 1]
      ? parseInt(args[limitIdx + 1], 10)
      : undefined;

  const registryId = process.env.REGISTRY_ID;
  const region = process.env.AWS_REGION || "us-west-2";
  const modelConfigTable = process.env.MODEL_CONFIG_TABLE;
  const modelCatalogTable = process.env.MODEL_CATALOG_TABLE;

  if (!registryId) throw new Error("REGISTRY_ID env var required");
  if (!modelConfigTable) throw new Error("MODEL_CONFIG_TABLE env var required");
  if (!modelCatalogTable)
    throw new Error("MODEL_CATALOG_TABLE env var required");

  log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  if (targetRecordId) log(`Canary: --record-id ${targetRecordId}`);
  if (limitN !== undefined && !isNaN(limitN)) log(`Canary: --limit ${limitN}`);
  log(`REGISTRY_ID=${registryId} REGION=${region}`);
  log(`MODEL_CONFIG_TABLE=${modelConfigTable}`);
  log(`MODEL_CATALOG_TABLE=${modelCatalogTable}`);

  const registry = new RegistryService({ registryId, region });
  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const modelCtx = await loadModelContext(
    dynamodb,
    modelConfigTable,
    modelCatalogTable,
  );
  if (!modelCtx.config) {
    log("ERROR: no model config found — cannot resolve models");
    process.exit(1);
  }
  if (modelCtx.catalog.size === 0) {
    log("ERROR: model catalog is empty — cannot resolve models");
    process.exit(1);
  }

  const summary: StampSummary = {
    scanned: 0,
    stamped: 0,
    skipped: 0,
    reapproved: 0,
    errors: 0,
  };

  let records: RegistryRecord[];
  try {
    records = await registry.listResources("agent");
  } catch (err) {
    log(`ERROR: Failed to list agent records: ${String(err)}`);
    process.exit(1);
  }

  // Canary: filter to --record-id if specified
  if (targetRecordId) {
    records = records.filter((r) => r.recordId === targetRecordId);
    if (records.length === 0) {
      log(`ERROR: --record-id ${targetRecordId} not found in registry`);
      process.exit(1);
    }
  }

  // Canary: cap to --limit N if specified
  if (limitN !== undefined && !isNaN(limitN) && limitN > 0) {
    records = records.slice(0, limitN);
  }

  const options: MarkerEditOptions = {
    registryService: registry,
    dryRun,
    operationLabel: "stamp-agent-permissions",
  };

  for (const record of records) {
    summary.scanned++;
    const meta = parseDescriptor(record);
    if (!meta) {
      log(`WARN: recordId=${record.recordId} malformed descriptor — skipping`);
      summary.errors++;
      continue;
    }

    if (alreadyStamped(meta)) {
      summary.skipped++;
      continue;
    }

    const fieldsToSet: Partial<Record<AllowedMarkerField, unknown>> = {};

    if (isPureCompute(record.name, meta)) {
      fieldsToSet.credentialMode = "none";
    } else {
      // Resolve the foundation model id for this agent
      const modelId = resolveAgentModel(meta, modelCtx);
      if (!modelId) {
        log(
          `ERROR: recordId=${record.recordId} name=${record.name} — ` +
            "cannot resolve model from config; refusing to stamp",
        );
        summary.errors++;
        continue;
      }

      // Derive integrations/dataStores from the agent's bindings
      const integrations: string[] = [];
      const dataStores: string[] = [];
      if (Array.isArray(meta.integrationBindings)) {
        for (const b of meta.integrationBindings) {
          if (
            b &&
            typeof b === "object" &&
            "integrationId" in (b as Record<string, unknown>)
          ) {
            integrations.push(
              (b as Record<string, unknown>).integrationId as string,
            );
          }
        }
      }
      if (Array.isArray(meta.dataStoreBindings)) {
        for (const b of meta.dataStoreBindings) {
          if (
            b &&
            typeof b === "object" &&
            "dataStoreId" in (b as Record<string, unknown>)
          ) {
            dataStores.push(
              (b as Record<string, unknown>).dataStoreId as string,
            );
          }
        }
      }

      fieldsToSet.requiredPermissions = {
        models: [modelId],
        dataStores,
        integrations,
      };
      fieldsToSet.credentialMode = "scoped";
    }

    let result: MarkerEditResult;
    try {
      result = await applyMarkerEdit(
        { recordId: record.recordId, type: "agent", fieldsToSet },
        options,
      );
    } catch (err) {
      log(
        `ERROR: recordId=${record.recordId} unexpected error: ${String(err)}`,
      );
      summary.errors++;
      continue;
    }

    if (result.error) {
      log(`ERROR: recordId=${record.recordId} ${result.error}`);
      summary.errors++;
      continue;
    }

    if (result.fieldsChanged.length > 0) {
      summary.stamped++;
      log(
        `${dryRun ? "WOULD STAMP" : "STAMPED"} recordId=${record.recordId} ` +
          `name=${record.name} fields=[${result.fieldsChanged.join(", ")}] ` +
          `prior=${result.priorStatus} post=${result.postStatus}` +
          (result.reapproved ? " (re-approved)" : ""),
      );
      if (result.reapproved) summary.reapproved++;
    } else {
      summary.skipped++;
    }
  }

  log("--- Summary ---");
  log(`mode:        ${dryRun ? "dry-run" : "apply"}`);
  log(`scanned:     ${summary.scanned}`);
  log(`stamped:     ${summary.stamped}`);
  log(`skipped:     ${summary.skipped}`);
  log(`reapproved:  ${summary.reapproved}`);
  log(`errors:      ${summary.errors}`);

  if (summary.errors > 0) {
    log(`ERROR: ${summary.errors} error(s) — exiting non-zero`);
    process.exit(1);
  }
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    log(`Fatal: ${String(err)}`);
    process.exit(1);
  });
}
