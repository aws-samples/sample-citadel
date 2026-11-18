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
 * Required env: REGISTRY_ID, AWS_REGION (optional, defaults to us-west-2).
 */
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
  meta: ParsedDescriptor,
): boolean {
  if (KNOWN_PURE_COMPUTE_NAMES.has(name ?? "")) return true;
  const hasBindings =
    (Array.isArray(meta.integrationBindings) &&
      meta.integrationBindings.length > 0) ||
    (Array.isArray(meta.dataStoreBindings) &&
      meta.dataStoreBindings.length > 0);
  if (hasBindings) return false;
  // Agents with a config.filename but no bindings are pure-compute
  if (
    meta.config &&
    typeof meta.config === "object" &&
    "filename" in meta.config
  ) {
    return true;
  }
  return false;
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

  if (!registryId) throw new Error("REGISTRY_ID env var required");

  log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  if (targetRecordId) log(`Canary: --record-id ${targetRecordId}`);
  if (limitN !== undefined && !isNaN(limitN)) log(`Canary: --limit ${limitN}`);
  log(`REGISTRY_ID=${registryId} REGION=${region}`);

  const registry = new RegistryService({ registryId, region });
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
      // Default: treat as model-calling. The stamp script does not attempt
      // to resolve the exact model — that would require catalog access. It
      // stamps an empty requiredPermissions dict so the worker knows to
      // use the fail-closed credential path (the vender reads the model from
      // the agent's runtime config instead).
      fieldsToSet.requiredPermissions = {
        models: [],
        dataStores: [],
        integrations: [],
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
