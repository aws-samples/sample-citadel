/**
 * Shared sequential registry reader — lists summaries page by page, then
 * fetches each full record via GetRegistryRecord ONE AT A TIME with a
 * configurable inter-call delay, exponential backoff (base 1 s, jitter,
 * 6 attempts), and progress logging every 20 records.
 *
 * Extracted from backfill-citadel-kind.ts (#373) so that every backfill
 * script avoids the concurrent N+1 fan-out in RegistryService.listResources
 * that causes 'Request rate exceeded' storms.
 */
import { GetRegistryRecordCommand } from "@aws-sdk/client-agent-registry-control";
import {
  RegistryService,
  type RegistryRecord,
  type ResourceType,
} from "../../src/services/registry-service";
import { inferKindFromParsed } from "../../src/utils/citadel-kind";

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter
// ---------------------------------------------------------------------------

/** Default: base delay 1 000 ms, max 6 attempts. */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_ATTEMPTS = 6;

export function isThrottleError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message ?? "";
    const name = (err as { name?: string }).name ?? "";
    if (
      msg.includes("Request rate exceeded") ||
      msg.includes("ThrottlingException") ||
      msg.includes("TooManyRequestsException") ||
      name === "ThrottlingException" ||
      name === "TooManyRequestsException"
    ) {
      return true;
    }
  }
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }
  return false;
}

/**
 * Computes the backoff schedule: delay[i] = base * 2^i (before jitter).
 * Exported for unit tests.
 */
export function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * Math.pow(2, attempt);
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = RETRY_MAX_ATTEMPTS,
  baseMs: number = RETRY_BASE_MS,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (!isThrottleError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const delay = backoffDelay(attempt, baseMs);
      const jitter = Math.floor(Math.random() * delay);
      const totalDelay = delay + jitter;
      log(
        "warn",
        `Throttled (attempt ${attempt + 1}/${maxAttempts}), retrying in ${totalDelay}ms`,
      );
      await sleepFn(totalDelay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Sleep helper (injectable for tests)
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Log helper
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[registry-sequential-reader] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Hydrated record
// ---------------------------------------------------------------------------

export interface HydratedRecord {
  record: RegistryRecord;
  resourceType: ResourceType;
}

/**
 * Fetches the full registry record using the SDK client directly, bypassing
 * the type-specific getResource() to avoid TypeMismatchError. Classifies
 * the record as agent or tool based on manifest presence in the descriptor.
 */
export async function hydrateRecord(
  registry: RegistryService,
  recordId: string,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<HydratedRecord | null> {
  const result = await withBackoff(
    async () =>
      registry.getClient().send(
        new GetRegistryRecordCommand({
          registryId: registry.getRegistryId(),
          recordId,
        }),
      ),
    RETRY_MAX_ATTEMPTS,
    RETRY_BASE_MS,
    sleepFn,
  );

  const customDescriptorContent = result.descriptors?.custom?.data;
  const record: RegistryRecord = {
    recordId: result.recordId ?? recordId,
    name: result.name ?? "",
    description: result.description,
    status: result.status ?? "",
    customDescriptorContent,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };

  let resourceType: ResourceType;
  try {
    const meta = customDescriptorContent
      ? JSON.parse(customDescriptorContent)
      : {};
    const kind = inferKindFromParsed(meta);
    resourceType = kind === "tool" ? "tool" : "agent";
  } catch {
    resourceType = "agent"; // default on parse failure
  }

  return { record, resourceType };
}

// ---------------------------------------------------------------------------
// Sequential reader options and result
// ---------------------------------------------------------------------------

export interface SequentialReaderOptions {
  /** Inter-call delay between GetRegistryRecord calls (ms). Default 250. */
  delayMs: number;
  /** Max records to fetch. Infinity or 0 = unlimited. */
  limit: number;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface SequentialReaderResult {
  agents: RegistryRecord[];
  tools: RegistryRecord[];
  errors: number;
}

/**
 * Lists all registry record summaries page by page (cheap — no per-record
 * GETs), then hydrates each summary STRICTLY sequentially: one
 * GetRegistryRecord at a time with a configurable inter-call delay,
 * exponential backoff on throttle errors, and progress logging every 20
 * records.
 */
export async function readRegistrySequentially(
  registry: RegistryService,
  options: SequentialReaderOptions,
): Promise<SequentialReaderResult> {
  const { sleepFn = defaultSleep } = options;
  const effectiveLimit =
    options.limit === 0 || !Number.isFinite(options.limit)
      ? Infinity
      : options.limit;

  // Step 1: cheap paginated list (no per-record GETs).
  let allSummaries: Array<{ recordId: string }>;
  try {
    allSummaries = (await registry.listResourceSummaries()).filter(
      (s): s is typeof s & { recordId: string } => !!s.recordId,
    );
  } catch (err) {
    log("error", `listResourceSummaries() failed: ${String(err)}`);
    return { agents: [], tools: [], errors: 1 };
  }

  const total = Math.min(allSummaries.length, effectiveLimit);
  log("info", `Total summaries: ${allSummaries.length}, processing: ${total}`);

  // Step 2: hydrate each summary STRICTLY sequentially.
  const agents: RegistryRecord[] = [];
  const tools: RegistryRecord[] = [];
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const { recordId } = allSummaries[i];
    try {
      const hydrated = await hydrateRecord(registry, recordId!, sleepFn);
      if (hydrated) {
        if (hydrated.resourceType === "agent") {
          agents.push(hydrated.record);
        } else {
          tools.push(hydrated.record);
        }
      }
    } catch (err) {
      log("error", `recordId=${recordId} detail GET failed: ${String(err)}`);
      errors++;
    }

    // Progress every 20 records
    if ((i + 1) % 20 === 0 || i + 1 === total) {
      log(
        "info",
        `fetch progress: ${i + 1}/${total} (agents=${agents.length}, tools=${tools.length})`,
      );
    }

    // Inter-call delay (skip after last)
    if (options.delayMs > 0 && i < total - 1) {
      await sleepFn(options.delayMs);
    }
  }

  return { agents, tools, errors };
}
