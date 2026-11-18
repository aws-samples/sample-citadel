/**
 * PR-3 backfill: converts the old fail-open empty-string "system-shared"
 * convention into the explicit `ALL_ORGS` ("All Organizations") marker, and
 * flags genuinely unstamped/legacy records with `orgUnknown: true` so the
 * new fail-closed read paths (record-visibility.ts, agent-config-resolver.ts,
 * registry-service.ts mappers) exclude them instead of treating a blank
 * orgId as a cross-tenant wildcard.
 *
 * Per the orchestrator's design override: this script is documented to run
 * BEFORE deploying the fail-closed read-path change. The current (pre-PR-3)
 * code already honours ALL_ORGS wherever it checks for a wildcard, so
 * running this backfill first is a zero-behaviour-change operation — it
 * only adds the explicit marker ahead of time. There is no
 * ACCEPT_EMPTY_AS_SHARED alias to disable after the fact; once the
 * fail-closed code deploys, any record still blank/unstamped is excluded
 * immediately.
 *
 * How shared is told apart from unstamped (a blank orgId alone is
 * ambiguous):
 *   - LEGITIMATELY SHARED → positively identifiable via an allowlist:
 *       (a) record/agent NAME is a known platform seed
 *           (SEED_ALLOWLIST_NAMES), or
 *       (b) record is already stamped orgId === ALL_ORGS (no-op), or
 *       (c) `createdBy` is a platform/system principal
 *           (SEED_ALLOWLIST_CREATED_BY).
 *     These are rewritten to orgId = ALL_ORGS.
 *   - UNSTAMPED/LEGACY → everything else with a blank/absent orgId that is
 *     NOT in the allowlist and whose createdBy does not resolve to exactly
 *     one tenant org. These get `orgUnknown = true`; the orgId attribute is
 *     left absent (never coerced to anything) — matching
 *     `registry-sync.ts buildAgentProjectionRow`'s convention.
 *   - AMBIGUOUS → blank orgId, not in the allowlist, but `createdBy`
 *     resolves (via the caller-supplied `resolveCreatedByOrg` lookup) to
 *     exactly one tenant org. REPORTED, never auto-resolved — the caller
 *     (an owner) must decide.
 *   - Already-shared / already-unknown / already-tenant-owned records are
 *     no-ops — re-running the script finds nothing left to do
 *     (idempotent).
 *
 * Usage:
 *   ts-node backend/scripts/backfill-shared-org-marker.ts --dry-run (default)
 *   ts-node backend/scripts/backfill-shared-org-marker.ts --apply
 *
 * Required env (same convention as backfill-org-ids.ts):
 *   REGISTRY_ID           – AgentCore Registry id
 *   AGENT_CONFIG_TABLE     – DDB table name for legacy agent configs
 *   TOOL_CONFIG_TABLE      – DDB table name for legacy tool configs
 *   AWS_REGION             – optional, defaults to us-west-2
 *
 * Constraints:
 *   - Dry-run by default. `--apply` flips to write mode.
 *   - Idempotent — re-running finds nothing left to update.
 *   - Ambiguous rows are reported (printed, counted) and NEVER
 *     auto-assigned, even in `--apply` mode.
 *   - Per-record errors are logged and swallowed; the main loop never
 *     throws.
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
  ResourceType,
  RegistryRecord,
} from "../src/services/registry-service";
import { ALL_ORGS } from "../src/utils/org-constants";

// ---------------------------------------------------------------------------
// Allowlists — the ONLY positive signals for "legitimately shared"
// ---------------------------------------------------------------------------

/** Known platform-seeded record/agent names. Extend as new seeds land. */
export const SEED_ALLOWLIST_NAMES: readonly string[] = [
  "demo-echo-agent",
  "Echo Demo Agent",
  "fabricator",
];

/** Known platform/system principal values for `createdBy`. */
export const SEED_ALLOWLIST_CREATED_BY: readonly string[] = [
  "seedConfig",
  "system",
  "fabricator",
];

// ---------------------------------------------------------------------------
// Pure classifier (exported for unit tests)
// ---------------------------------------------------------------------------

export interface RecordShape {
  id: string;
  name?: string;
  orgId?: string;
  orgUnknown?: boolean;
  createdBy?: string;
}

export type ClassifyOutcome =
  | { outcome: "already-shared"; targetOrgId: string }
  | { outcome: "already-unknown" }
  | { outcome: "already-tenant-owned" }
  | { outcome: "mark-shared"; targetOrgId: string; reason: string }
  | { outcome: "mark-unknown" }
  | { outcome: "ambiguous"; resolvedOrgId: string };

/**
 * Classifies a single record. `resolveCreatedByOrg`, when supplied, is a
 * synchronous lookup (callers wrap an async Cognito/user lookup result)
 * from `createdBy` to a single resolvable tenant orgId, or `undefined` if
 * none resolves. Never mutates `rec`.
 */
export function classifyRecord(
  rec: RecordShape,
  resolveCreatedByOrg?: (createdBy: string) => string | undefined,
): ClassifyOutcome {
  // Idempotency fast paths — nothing left to do.
  if (rec.orgUnknown === true) {
    return { outcome: "already-unknown" };
  }
  if (rec.orgId === ALL_ORGS) {
    return { outcome: "already-shared", targetOrgId: ALL_ORGS };
  }
  if (rec.orgId !== undefined && rec.orgId !== "") {
    // A real, non-ALL_ORGS orgId is already tenant-owned — out of scope.
    return { outcome: "already-tenant-owned" };
  }

  // From here, orgId is blank ("") or absent (undefined), and orgUnknown is
  // not already set — this is the ambiguous case the backfill exists for.

  const nameMatch =
    rec.name !== undefined && SEED_ALLOWLIST_NAMES.includes(rec.name);
  if (nameMatch) {
    return {
      outcome: "mark-shared",
      targetOrgId: ALL_ORGS,
      reason: "name-allowlist",
    };
  }

  const createdByMatch =
    rec.createdBy !== undefined &&
    SEED_ALLOWLIST_CREATED_BY.includes(rec.createdBy);
  if (createdByMatch) {
    return {
      outcome: "mark-shared",
      targetOrgId: ALL_ORGS,
      reason: "createdBy-allowlist",
    };
  }

  if (rec.createdBy !== undefined && resolveCreatedByOrg) {
    const resolved = resolveCreatedByOrg(rec.createdBy);
    if (resolved !== undefined) {
      return { outcome: "ambiguous", resolvedOrgId: resolved };
    }
  }

  return { outcome: "mark-unknown" };
}

// ---------------------------------------------------------------------------
// Summary accumulation
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  scanned: number;
  markedShared: number;
  markedUnknown: number;
  alreadyShared: number;
  alreadyUnknown: number;
  ambiguousReported: number;
  errors: number;
}

export function emptySummary(): BackfillSummary {
  return {
    scanned: 0,
    markedShared: 0,
    markedUnknown: 0,
    alreadyShared: 0,
    alreadyUnknown: 0,
    ambiguousReported: 0,
    errors: 0,
  };
}

export function addSummary(dst: BackfillSummary, src: BackfillSummary): void {
  dst.scanned += src.scanned;
  dst.markedShared += src.markedShared;
  dst.markedUnknown += src.markedUnknown;
  dst.alreadyShared += src.alreadyShared;
  dst.alreadyUnknown += src.alreadyUnknown;
  dst.ambiguousReported += src.ambiguousReported;
  dst.errors += src.errors;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const prefix =
    level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  const line = `${ts} [${prefix}] ${msg}`;
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Registry processing
// ---------------------------------------------------------------------------

async function processRegistryRecord(
  type: ResourceType,
  registry: RegistryService,
  record: RegistryRecord,
  apply: boolean,
  summary: BackfillSummary,
): Promise<void> {
  summary.scanned++;
  const recordId = record.recordId;

  let meta: Record<string, unknown>;
  try {
    meta = record.customDescriptorContent
      ? JSON.parse(record.customDescriptorContent)
      : {};
  } catch (err) {
    log(
      "error",
      `[${type}] recordId=${recordId} malformed customDescriptorContent: ${String(err)}`,
    );
    summary.errors++;
    return;
  }

  const rec: RecordShape = {
    id: recordId,
    name: record.name,
    orgId: typeof meta.orgId === "string" ? meta.orgId : undefined,
    orgUnknown: meta.orgUnknown === true,
    createdBy: typeof meta.createdBy === "string" ? meta.createdBy : undefined,
  };

  const classification = classifyRecord(rec);

  switch (classification.outcome) {
    case "already-shared":
      summary.alreadyShared++;
      log(
        "info",
        `[${type}] recordId=${recordId} already shared (ALL_ORGS) — skip`,
      );
      return;
    case "already-unknown":
      summary.alreadyUnknown++;
      log("info", `[${type}] recordId=${recordId} already orgUnknown — skip`);
      return;
    case "already-tenant-owned":
      log(
        "info",
        `[${type}] recordId=${recordId} already tenant-owned (orgId=${rec.orgId}) — skip`,
      );
      return;
    case "ambiguous":
      summary.ambiguousReported++;
      log(
        "warn",
        `[${type}] recordId=${recordId} AMBIGUOUS — createdBy=${rec.createdBy} resolves to org=${classification.resolvedOrgId}; NOT auto-assigned, owner decision required`,
      );
      return;
    case "mark-shared": {
      summary.markedShared++;
      log(
        "info",
        `[${type}] recordId=${recordId} -> orgId=${ALL_ORGS} (${classification.reason})`,
      );
      if (!apply) return;
      try {
        const updatedMeta = { ...meta, orgId: ALL_ORGS };
        await registry.updateResource(type, recordId, {
          customMetadata: JSON.stringify(updatedMeta),
        });
      } catch (err) {
        log(
          "error",
          `[${type}] recordId=${recordId} registry write failed: ${String(err)}`,
        );
        summary.errors++;
      }
      return;
    }
    case "mark-unknown": {
      summary.markedUnknown++;
      log(
        "info",
        `[${type}] recordId=${recordId} -> orgUnknown=true (no positive shared signal)`,
      );
      if (!apply) return;
      try {
        const updatedMeta: Record<string, unknown> = {
          ...meta,
          orgUnknown: true,
        };
        delete updatedMeta.orgId;
        await registry.updateResource(type, recordId, {
          customMetadata: JSON.stringify(updatedMeta),
        });
      } catch (err) {
        log(
          "error",
          `[${type}] recordId=${recordId} registry write failed: ${String(err)}`,
        );
        summary.errors++;
      }
      return;
    }
  }
}

async function processRegistry(
  type: ResourceType,
  registry: RegistryService,
  apply: boolean,
): Promise<BackfillSummary> {
  const summary = emptySummary();
  log("info", `--- Processing registry '${type}' records ---`);

  let records: RegistryRecord[];
  try {
    records = await registry.listResources(type);
  } catch (err) {
    log("error", `Failed to list ${type} registry records: ${String(err)}`);
    summary.errors++;
    return summary;
  }

  for (const rec of records) {
    try {
      await processRegistryRecord(type, registry, rec, apply, summary);
    } catch (err) {
      log(
        "error",
        `[${type}] recordId=${rec.recordId} unexpected error: ${String(err)}`,
      );
      summary.errors++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// DDB-legacy table processing
// ---------------------------------------------------------------------------

async function processDdbTable(
  kind: "agent" | "tool",
  tableName: string,
  docClient: DynamoDBDocumentClient,
  apply: boolean,
): Promise<BackfillSummary> {
  const summary = emptySummary();
  log("info", `--- Processing DDB '${kind}' table: ${tableName} ---`);

  const pkName = kind === "agent" ? "agentId" : "toolId";
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    let scanResult;
    try {
      scanResult = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      log("error", `DDB scan failed for ${tableName}: ${String(err)}`);
      summary.errors++;
      return summary;
    }

    for (const item of scanResult.Items || []) {
      summary.scanned++;
      const id = item[pkName];
      try {
        const rec: RecordShape = {
          id,
          name: typeof item.name === "string" ? item.name : undefined,
          orgId: typeof item.orgId === "string" ? item.orgId : undefined,
          orgUnknown: item.orgUnknown === true,
          createdBy:
            typeof item.createdBy === "string" ? item.createdBy : undefined,
        };

        const classification = classifyRecord(rec);

        switch (classification.outcome) {
          case "already-shared":
            summary.alreadyShared++;
            log("info", `[${kind}] id=${id} already shared (ALL_ORGS) — skip`);
            continue;
          case "already-unknown":
            summary.alreadyUnknown++;
            log("info", `[${kind}] id=${id} already orgUnknown — skip`);
            continue;
          case "already-tenant-owned":
            log(
              "info",
              `[${kind}] id=${id} already tenant-owned (orgId=${rec.orgId}) — skip`,
            );
            continue;
          case "ambiguous":
            summary.ambiguousReported++;
            log(
              "warn",
              `[${kind}] id=${id} AMBIGUOUS — createdBy=${rec.createdBy} resolves to org=${classification.resolvedOrgId}; NOT auto-assigned, owner decision required`,
            );
            continue;
          case "mark-shared":
            summary.markedShared++;
            log(
              "info",
              `[${kind}] id=${id} -> orgId=${ALL_ORGS} (${classification.reason})`,
            );
            if (apply) {
              await docClient.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { [pkName]: id },
                  UpdateExpression:
                    "SET #orgId = :orgId, #updatedAt = :updatedAt",
                  ExpressionAttributeNames: {
                    "#orgId": "orgId",
                    "#updatedAt": "updatedAt",
                  },
                  ExpressionAttributeValues: {
                    ":orgId": ALL_ORGS,
                    ":updatedAt": new Date().toISOString(),
                  },
                  ReturnValues: "UPDATED_NEW",
                }),
              );
            }
            continue;
          case "mark-unknown":
            summary.markedUnknown++;
            log(
              "info",
              `[${kind}] id=${id} -> orgUnknown=true (no positive shared signal)`,
            );
            if (apply) {
              await docClient.send(
                new UpdateCommand({
                  TableName: tableName,
                  Key: { [pkName]: id },
                  UpdateExpression:
                    "REMOVE #orgId SET #orgUnknown = :orgUnknown, #updatedAt = :updatedAt",
                  ExpressionAttributeNames: {
                    "#orgId": "orgId",
                    "#orgUnknown": "orgUnknown",
                    "#updatedAt": "updatedAt",
                  },
                  ExpressionAttributeValues: {
                    ":orgUnknown": true,
                    ":updatedAt": new Date().toISOString(),
                  },
                  ReturnValues: "UPDATED_NEW",
                }),
              );
            }
            continue;
        }
      } catch (err) {
        log("error", `[${kind}] id=${id} unexpected error: ${String(err)}`);
        summary.errors++;
      }
    }

    exclusiveStartKey = scanResult.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;

  const registryId = process.env.REGISTRY_ID;
  const region = process.env.AWS_REGION || "us-west-2";
  const agentTable = process.env.AGENT_CONFIG_TABLE;
  const toolTable = process.env.TOOL_CONFIG_TABLE;

  if (!registryId) throw new Error("REGISTRY_ID env var required");
  if (!agentTable) throw new Error("AGENT_CONFIG_TABLE env var required");
  if (!toolTable) throw new Error("TOOL_CONFIG_TABLE env var required");

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  log("info", `REGISTRY_ID=${registryId} REGION=${region}`);
  log(
    "info",
    `AGENT_CONFIG_TABLE=${agentTable} TOOL_CONFIG_TABLE=${toolTable}`,
  );

  const registry = new RegistryService({ registryId, region });
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const totals = emptySummary();

  addSummary(totals, await processRegistry("agent", registry, apply));
  addSummary(totals, await processRegistry("tool", registry, apply));
  addSummary(
    totals,
    await processDdbTable("agent", agentTable, docClient, apply),
  );
  addSummary(
    totals,
    await processDdbTable("tool", toolTable, docClient, apply),
  );

  log("info", "--- Backfill summary ---");
  log("info", `mode:              ${dryRun ? "dry-run" : "apply"}`);
  log("info", `scanned:           ${totals.scanned}`);
  log("info", `markedShared:      ${totals.markedShared}`);
  log("info", `markedUnknown:     ${totals.markedUnknown}`);
  log("info", `alreadyShared:     ${totals.alreadyShared}`);
  log("info", `alreadyUnknown:    ${totals.alreadyUnknown}`);
  log("info", `ambiguousReported: ${totals.ambiguousReported}`);
  log("info", `errors:            ${totals.errors}`);

  if (totals.ambiguousReported > 0) {
    log(
      "warn",
      `${totals.ambiguousReported} ambiguous record(s) require an owner decision — re-run after resolving them manually.`,
    );
  }
}

/**
 * Entry-point guard — see backfill-org-ids.ts for the dual CJS/ESM rationale.
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
