/**
 * One-off, idempotent backfill: stamps `citadelKind` on existing registry
 * records that predate the explicit discriminator (CIT-247 PR 1).
 *
 * Algorithm:
 *   1. listResources('agent') — paginate all agent-type records.
 *   2. listResources('tool')  — paginate all tool-type records.
 *   3. For each record, parse customDescriptorContent:
 *      - Already has citadelKind → skip (idempotent).
 *      - manifest present        → kind = 'app'.
 *      - Registry type 'tool'    → kind = 'tool'.
 *      - Agent type, no manifest → kind = 'agent'.
 *      - Ambiguous (manifest === null vs absent) → log as ambiguous, skip.
 *   4. ONLY DRAFT records are tagged via updateResource.
 *      Non-DRAFT records are reported as "inferred (status X, not rewritten)"
 *      because rewriting customDescriptorContent on a non-DRAFT record is a
 *      content edit that demotes it to DRAFT (observed live three times —
 *      decision df5c0472).
 *
 * Usage:
 *   ts-node --project tsconfig.scripts.json scripts/backfill-citadel-kind.ts \
 *     --registry-id <id> [--apply]
 *
 * By default, dry-run mode. Pass --apply to write.
 */
import {
  RegistryService,
  type RegistryRecord,
  type ResourceType,
} from "../src/services/registry-service";
import {
  extractCitadelKind,
  inferKindFromShape,
  type CitadelKind,
} from "../src/utils/citadel-kind";

// ---------------------------------------------------------------------------
// Pure logic helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  scanned: number;
  tagged: number;
  alreadyTagged: number;
  skippedNonDraft: number;
  ambiguous: number;
  errors: number;
  byKind: Record<CitadelKind, number>;
  byStatus: Record<string, number>;
  ambiguousList: Array<{ recordId: string; status: string; reason: string }>;
  nonDraftInferred: Array<{
    recordId: string;
    status: string;
    inferred: CitadelKind;
  }>;
}

function emptySummary(): BackfillSummary {
  return {
    scanned: 0,
    tagged: 0,
    alreadyTagged: 0,
    skippedNonDraft: 0,
    ambiguous: 0,
    errors: 0,
    byKind: { agent: 0, app: 0, tool: 0 },
    byStatus: {},
    ambiguousList: [],
    nonDraftInferred: [],
  };
}

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[backfill-citadel-kind] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  registryId: string;
  apply: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let registryId: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--registry-id") {
      registryId = argv[++i];
    } else if (arg === "--apply") {
      apply = true;
    }
  }

  if (!registryId) throw new Error("--registry-id <id> is required");
  return { registryId, apply };
}

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------

/**
 * Returns a reason string when the record's kind cannot be confidently
 * inferred, or undefined when inference is unambiguous.
 */
export function detectAmbiguity(
  parsed: Record<string, unknown>,
  resourceType: ResourceType,
): string | undefined {
  if (resourceType === "tool") return undefined; // tool type is unambiguous
  // A `manifest` key that is explicitly null is ambiguous — was it an app
  // whose manifest was cleared, or an agent with a stray null field?
  if ("manifest" in parsed && parsed.manifest === null) {
    return "manifest key is null (app with cleared manifest? or stray field?)";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-record processing
// ---------------------------------------------------------------------------

export async function processRecord(
  record: RegistryRecord,
  resourceType: ResourceType,
  registry: RegistryService,
  apply: boolean,
  summary: BackfillSummary,
): Promise<void> {
  summary.scanned++;
  const status = record.status ?? "UNKNOWN";
  summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;

  // Already tagged → skip (idempotent).
  const existingKind = extractCitadelKind(record);
  if (existingKind) {
    summary.alreadyTagged++;
    summary.byKind[existingKind]++;
    return;
  }

  // Parse descriptor for inference.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record.customDescriptorContent ?? "{}");
  } catch (err) {
    log("error", `recordId=${record.recordId} unparseable descriptor: ${err}`);
    summary.errors++;
    return;
  }

  // Ambiguity check.
  const ambiguityReason = detectAmbiguity(parsed, resourceType);
  if (ambiguityReason) {
    summary.ambiguous++;
    summary.ambiguousList.push({
      recordId: record.recordId,
      status,
      reason: ambiguityReason,
    });
    log(
      "warn",
      `recordId=${record.recordId} ambiguous: ${ambiguityReason} — skipped`,
    );
    return;
  }

  const inferred = inferKindFromShape(record, resourceType);
  summary.byKind[inferred]++;

  // NON-DRAFT records: report inferred kind but do NOT write (decision
  // df5c0472 — rewriting customDescriptorContent demotes to DRAFT).
  if (status !== "DRAFT") {
    summary.skippedNonDraft++;
    summary.nonDraftInferred.push({
      recordId: record.recordId,
      status,
      inferred,
    });
    log(
      "info",
      `recordId=${record.recordId} inferred=${inferred} (status ${status}, not rewritten)`,
    );
    return;
  }

  // DRAFT record without citadelKind → tag it.
  if (!apply) {
    summary.tagged++;
    log(
      "info",
      `recordId=${record.recordId} → citadelKind=${inferred} (dry-run)`,
    );
    return;
  }

  try {
    parsed.citadelKind = inferred;
    await registry.updateResource(resourceType, record.recordId, {
      customMetadata: JSON.stringify(parsed),
    });
    summary.tagged++;
    log(
      "info",
      `recordId=${record.recordId} → citadelKind=${inferred} (tagged)`,
    );
  } catch (err) {
    log(
      "error",
      `recordId=${record.recordId} updateResource failed: ${String(err)}`,
    );
    summary.errors++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackfill(
  registryId: string,
  apply: boolean,
  registry: RegistryService,
): Promise<BackfillSummary> {
  const summary = emptySummary();
  log("info", `Mode: ${apply ? "APPLY" : "DRY-RUN"} registryId=${registryId}`);

  for (const resourceType of ["agent", "tool"] as ResourceType[]) {
    let records: RegistryRecord[];
    try {
      records = await registry.listResources(resourceType);
    } catch (err) {
      log("error", `listResources('${resourceType}') failed: ${String(err)}`);
      summary.errors++;
      continue;
    }

    log("info", `${resourceType} records found: ${records.length}`);
    for (const record of records) {
      await processRecord(record, resourceType, registry, apply, summary);
    }
  }

  return summary;
}

export async function main(): Promise<void> {
  const { registryId, apply } = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error(
      "AWS_REGION or AWS_DEFAULT_REGION must be set (no hardcoded default)",
    );
  }
  const registry = new RegistryService({ registryId, region });

  const summary = await runBackfill(registryId, apply, registry);

  log("info", "--- Backfill summary ---");
  console.log(JSON.stringify(summary, null, 2));

  if (summary.nonDraftInferred.length > 0) {
    log(
      "info",
      `${summary.nonDraftInferred.length} non-DRAFT record(s) with inferred kind (not rewritten):`,
    );
    for (const r of summary.nonDraftInferred) {
      console.log(
        `  ${r.recordId}: inferred=${r.inferred} (status ${r.status})`,
      );
    }
  }

  if (summary.ambiguousList.length > 0) {
    log("warn", `${summary.ambiguousList.length} ambiguous record(s):`);
    for (const r of summary.ambiguousList) {
      console.log(`  ${r.recordId}: ${r.reason} (status ${r.status})`);
    }
  }

  if (summary.errors > 0) {
    process.exit(1);
  }
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
    log("error", `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
