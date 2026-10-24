/**
 * One-off, idempotent backfill: stamps `citadelKind` on existing registry
 * records that predate the explicit discriminator (CIT-247 PR 1).
 *
 * Algorithm:
 *   1. listResourceSummaries() — paginate all CUSTOM records (cheap, no
 *      per-record GETs).
 *   2. For each summary, SEQUENTIALLY fetch the full record via
 *      GetRegistryRecord with a configurable inter-call delay.
 *   3. Classify by manifest presence (agent vs tool) and infer citadelKind.
 *   4. ONLY DRAFT records are tagged via updateResource.
 *      Non-DRAFT records are reported as "inferred (status X, not rewritten)"
 *      because rewriting customDescriptorContent on a non-DRAFT record is a
 *      content edit that demotes it to DRAFT (observed live three times —
 *      decision df5c0472).
 *
 * Throttle-safe: records are read STRICTLY sequentially (one GetRegistryRecord
 * at a time) with a configurable inter-call delay (`--delay-ms`, default 250).
 * Retries use exponential backoff with jitter (base 1 s, max 6 attempts) and
 * honour 'Request rate exceeded' as retryable.
 *
 * Usage:
 *   ts-node --project tsconfig.scripts.json scripts/backfill-citadel-kind.ts \
 *     --registry-id <id> [--apply] [--delay-ms 250] [--limit 50]
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
import {
  readRegistrySequentially,
  withBackoff,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
} from "./lib/registry-sequential-reader";

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
  delayMs: number;
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let registryId: string | undefined;
  let apply = false;
  let delayMs = 250;
  let limit = Infinity;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--registry-id") {
      registryId = argv[++i];
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--delay-ms") {
      delayMs = parseInt(argv[++i], 10);
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("--delay-ms must be a non-negative integer");
      }
    } else if (arg === "--limit") {
      limit = parseInt(argv[++i], 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
    }
  }

  if (!registryId) throw new Error("--registry-id <id> is required");
  return { registryId, apply, delayMs, limit };
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
  if ("manifest" in parsed && parsed.manifest === null) {
    return "manifest key is null (app with cleared manifest? or stray field?)";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Retry helpers re-exported from shared module for test compatibility
// ---------------------------------------------------------------------------

export {
  isThrottleError,
  backoffDelay,
  withBackoff,
  hydrateRecord,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
} from "./lib/registry-sequential-reader";
export type { HydratedRecord } from "./lib/registry-sequential-reader";

// ---------------------------------------------------------------------------
// Sleep helper (local — used as default in processRecord)
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
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

  // NON-DRAFT records: report inferred kind but do NOT write.
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
    await withBackoff(
      () =>
        registry.updateResource(resourceType, record.recordId, {
          customMetadata: JSON.stringify(parsed),
        }),
      RETRY_MAX_ATTEMPTS,
      RETRY_BASE_MS,
      sleepFn,
    );
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

export interface RunBackfillOptions {
  delayMs: number;
  limit: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function runBackfill(
  registryId: string,
  apply: boolean,
  registry: RegistryService,
  options: RunBackfillOptions,
): Promise<BackfillSummary> {
  const summary = emptySummary();
  const { sleepFn = defaultSleep } = options;

  log("info", `Mode: ${apply ? "APPLY" : "DRY-RUN"} registryId=${registryId}`);
  if (options.limit !== Infinity) {
    log("info", `Limit: ${options.limit} records`);
  }
  log("info", `Inter-call delay: ${options.delayMs}ms`);

  // Delegate the sequential list-then-hydrate to the shared reader.
  const {
    agents: agentRecords,
    tools: toolRecords,
    errors: fetchErrors,
  } = await readRegistrySequentially(registry, {
    delayMs: options.delayMs,
    limit: options.limit,
    sleepFn,
  });
  summary.errors += fetchErrors;

  // Step 3: process agent records, then tool records.
  log("info", `agent records: ${agentRecords.length}`);
  for (const record of agentRecords) {
    await processRecord(record, "agent", registry, apply, summary, sleepFn);
    logProgress(summary);
  }

  log("info", `tool records: ${toolRecords.length}`);
  for (const record of toolRecords) {
    await processRecord(record, "tool", registry, apply, summary, sleepFn);
    logProgress(summary);
  }

  return summary;
}

function logProgress(summary: BackfillSummary): void {
  if (summary.scanned % 20 === 0) {
    const kindCounts = Object.entries(summary.byKind)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    log(
      "info",
      `processed: ${summary.scanned} — kinds so far: ${kindCounts || "none"}`,
    );
  }
}

export async function main(): Promise<void> {
  const { registryId, apply, delayMs, limit } = parseArgs(
    process.argv.slice(2),
  );
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error(
      "AWS_REGION or AWS_DEFAULT_REGION must be set (no hardcoded default)",
    );
  }
  const registry = new RegistryService({ registryId, region });

  const summary = await runBackfill(registryId, apply, registry, {
    delayMs,
    limit,
  });

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
