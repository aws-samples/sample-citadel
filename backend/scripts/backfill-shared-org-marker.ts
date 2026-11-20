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
 *   Corrective mode — re-stamps records that were previously (incorrectly)
 *   marked ALL_ORGS because "fabricator" used to be in
 *   SEED_ALLOWLIST_CREATED_BY (see finding 85a5b270):
 *   ts-node backend/scripts/backfill-shared-org-marker.ts \
 *     --correct-fabricator-shared [--apply] [--record-id <id>] \
 *     [--limit <n>] [--delay-ms <ms>]
 *
 *   --correct-fabricator-shared  Enable corrective mode (default: off).
 *                                 Dry-run unless `--apply` is also given.
 *   --record-id <id>              Scope WRITES to a single record id (canary).
 *                                 The full planned set is still printed;
 *                                 only the matching record is ever mutated.
 *   --limit <n>                   Non-negative integer cap on how many
 *                                 records get WRITTEN in `--apply` mode
 *                                 (the plan/print phase is never bounded).
 *                                 Non-numeric values throw.
 *   --delay-ms <ms>                Non-negative integer base delay (ms) for
 *                                 the per-record exponential backoff used
 *                                 when re-fetching registry records whose
 *                                 detail GET was throttled. Default 1000.
 *                                 Retries target ONLY the specific dropped
 *                                 recordIds (concurrency 1), never the
 *                                 whole registry type, and give up after 5
 *                                 attempts per record.
 *
 * Required env (same convention as backfill-org-ids.ts):
 *   REGISTRY_ID           – AgentCore Registry id
 *   AGENT_CONFIG_TABLE     – DDB table name for legacy agent configs
 *   TOOL_CONFIG_TABLE      – DDB table name for legacy tool configs
 *   PROJECTS_TABLE         – DDB table name for projects (projectId ->
 *                            organization); REQUIRED only when
 *                            --correct-fabricator-shared is set, used to
 *                            resolve the tenant org for fabricator-created
 *                            agents (via sourceProjectId) and tools (via
 *                            their binding agents' sourceProjectId)
 *   AWS_REGION             – optional, defaults to us-west-2
 *
 * Constraints:
 *   - Dry-run by default. `--apply` flips to write mode.
 *   - Idempotent — re-running finds nothing left to update.
 *   - Ambiguous rows are reported (printed, counted) and NEVER
 *     auto-assigned, even in `--apply` mode.
 *   - Per-record errors are logged and swallowed; the main loop never
 *     throws.
 *   - Corrective mode refuses to act (error, exit non-zero) if any record
 *     is still unfetched after the targeted per-record retry — never a
 *     silent partial apply.
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
  ListResourcesResult,
} from "../src/services/registry-service";
import { ALL_ORGS } from "../src/utils/org-constants";
import { applyMarkerEdit } from "../src/utils/marker-registry-edit";

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
  sourceProjectId?: string;
  appId?: string;
}

/**
 * Org-resolution callbacks for fabricator-created records.
 *
 * `resolveAgentOrg` — given a record with `sourceProjectId`, look up the
 *   project in the projects table and return its `organization` field, or
 *   `undefined` if not resolvable.
 *
 * `resolveToolOrg` — given a record with `appId`, find agents that share
 *   the same `appId`, resolve their org via `sourceProjectId → project →
 *   organization`, and return:
 *     - the single org string if exactly one org is found
 *     - `"AMBIGUOUS"` if multiple distinct orgs are found
 *     - `undefined` if none resolve
 */
export interface OrgResolver {
  resolveAgentOrg: (rec: RecordShape) => string | undefined;
  resolveToolOrg: (rec: RecordShape) => string | undefined;
}

export type ClassifyOutcome =
  | { outcome: "already-shared"; targetOrgId: string }
  | { outcome: "already-unknown" }
  | { outcome: "already-tenant-owned" }
  | { outcome: "mark-shared"; targetOrgId: string; reason: string }
  | { outcome: "mark-tenant"; targetOrgId: string; reason: string }
  | { outcome: "mark-unknown" }
  | { outcome: "ambiguous"; resolvedOrgId: string };

/**
 * Classifies a single record. `resolveCreatedByOrg`, when supplied, is a
 * synchronous lookup (callers wrap an async Cognito/user lookup result)
 * from `createdBy` to a single resolvable tenant orgId, or `undefined` if
 * none resolves. `orgResolver`, when supplied, is used for the fabricator
 * tenant-resolution path (sourceProjectId for agents, appId → binding
 * agents for tools) — see `OrgResolver` doc comment. Never mutates `rec`.
 */
export function classifyRecord(
  rec: RecordShape,
  resolveCreatedByOrg?: (createdBy: string) => string | undefined,
  orgResolver?: OrgResolver,
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

  // Fabricator-created records are tenant artifacts, never platform-shared.
  // "fabricator" is intentionally NOT in SEED_ALLOWLIST_CREATED_BY — resolve
  // the owning tenant org instead of stamping ALL_ORGS. A record with a
  // `sourceProjectId` is treated as agent-shaped regardless of `createdBy`
  // (the agent's own fabricator provenance may not always be stamped);
  // records with `appId` and no `sourceProjectId` are tool-shaped.
  if (orgResolver) {
    if (rec.sourceProjectId !== undefined) {
      const resolved = orgResolver.resolveAgentOrg(rec);
      if (resolved === "AMBIGUOUS") {
        return { outcome: "ambiguous", resolvedOrgId: "AMBIGUOUS" };
      }
      if (resolved !== undefined) {
        return {
          outcome: "mark-tenant",
          targetOrgId: resolved,
          reason: "fabricator-agent-sourceProjectId",
        };
      }
      return { outcome: "mark-unknown" };
    }

    if (rec.appId !== undefined) {
      const resolved = orgResolver.resolveToolOrg(rec);
      if (resolved === "AMBIGUOUS") {
        return { outcome: "ambiguous", resolvedOrgId: "AMBIGUOUS" };
      }
      if (resolved !== undefined) {
        return {
          outcome: "mark-tenant",
          targetOrgId: resolved,
          reason: "fabricator-tool-appId",
        };
      }
      return { outcome: "mark-unknown" };
    }
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
  markedTenant: number;
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
    markedTenant: 0,
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
  dst.markedTenant += src.markedTenant;
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
  orgResolver?: OrgResolver,
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
    sourceProjectId:
      typeof meta.sourceProjectId === "string"
        ? meta.sourceProjectId
        : undefined,
    appId: typeof meta.appId === "string" ? meta.appId : undefined,
  };

  const classification = classifyRecord(rec, undefined, orgResolver);

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
        const editResult = await applyMarkerEdit(
          { recordId, type, fieldsToSet: { orgId: ALL_ORGS } },
          {
            registryService: registry,
            dryRun: false,
            operationLabel: "backfill-shared-org-marker",
          },
        );
        if (editResult.error) {
          log(
            "error",
            `[${type}] recordId=${recordId} marker edit failed: ${editResult.error}`,
          );
          summary.errors++;
        }
      } catch (err) {
        log(
          "error",
          `[${type}] recordId=${recordId} registry write failed: ${String(err)}`,
        );
        summary.errors++;
      }
      return;
    }
    case "mark-tenant": {
      // Reachable from the default pass when an orgResolver is supplied
      // (see processRegistry/main) — a blank-orgId fabricator-created
      // record resolves to its tenant org instead of falling through to
      // orgUnknown. Corrective mode re-stamps already-ALL_ORGS records via
      // the separate runCorrectiveForRegistryType/applyCorrectiveEntry path.
      summary.markedTenant++;
      log(
        "info",
        `[${type}] recordId=${recordId} -> orgId=${classification.targetOrgId} (${classification.reason})`,
      );
      if (!apply) return;
      try {
        const editResult = await applyMarkerEdit(
          {
            recordId,
            type,
            fieldsToSet: { orgId: classification.targetOrgId },
          },
          {
            registryService: registry,
            dryRun: false,
            operationLabel: "backfill-shared-org-marker",
          },
        );
        if (editResult.error) {
          log(
            "error",
            `[${type}] recordId=${recordId} marker edit failed: ${editResult.error}`,
          );
          summary.errors++;
        }
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
        const editResult = await applyMarkerEdit(
          {
            recordId,
            type,
            fieldsToSet: { orgUnknown: true },
            fieldsToRemove: ["orgId"],
          },
          {
            registryService: registry,
            dryRun: false,
            operationLabel: "backfill-shared-org-marker",
          },
        );
        if (editResult.error) {
          log(
            "error",
            `[${type}] recordId=${recordId} marker edit failed: ${editResult.error}`,
          );
          summary.errors++;
        }
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

export async function processRegistry(
  type: ResourceType,
  registry: RegistryService,
  apply: boolean,
  orgResolver?: OrgResolver,
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
      await processRegistryRecord(
        type,
        registry,
        rec,
        apply,
        summary,
        orgResolver,
      );
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

export async function processDdbTable(
  kind: "agent" | "tool",
  tableName: string,
  docClient: DynamoDBDocumentClient,
  apply: boolean,
  orgResolver?: OrgResolver,
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
          sourceProjectId:
            typeof item.sourceProjectId === "string"
              ? item.sourceProjectId
              : undefined,
          appId: typeof item.appId === "string" ? item.appId : undefined,
        };

        const classification = classifyRecord(rec, undefined, orgResolver);

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
          case "mark-tenant":
            // Reachable from the default pass when an orgResolver is
            // supplied (see processDdbTable callers/main) — a blank-orgId
            // fabricator-created record resolves to its tenant org instead
            // of falling through to orgUnknown.
            summary.markedTenant++;
            log(
              "info",
              `[${kind}] id=${id} -> orgId=${classification.targetOrgId} (${classification.reason})`,
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
                    ":orgId": classification.targetOrgId,
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
// Corrective mode — re-stamp ALL_ORGS+fabricator+non-seed-name records
// ---------------------------------------------------------------------------

/**
 * A single planned/applied corrective re-stamp, logged with the previous
 * value so a manual restore is possible (no inverse mode required).
 */
export interface CorrectivePlanEntry {
  id: string;
  name: string | undefined;
  kind: "agent" | "tool";
  previousOrgId: string;
  resolvedOrgId: string | undefined;
  reason: string;
}

/**
 * True when a record is in scope for corrective re-stamping: currently
 * marked ALL_ORGS, created by "fabricator", and not a genuine platform
 * seed by name.
 */
export function isCorrectiveTarget(rec: RecordShape): boolean {
  return (
    rec.orgId === ALL_ORGS &&
    rec.createdBy === "fabricator" &&
    (rec.name === undefined || !SEED_ALLOWLIST_NAMES.includes(rec.name))
  );
}

/**
 * Resolves the corrective plan entry for one in-scope record, or `undefined`
 * if the record is not in scope. Never writes — pure planning function so
 * dry-run and apply share the identical decision.
 */
export function planCorrectiveEntry(
  rec: RecordShape,
  kind: "agent" | "tool",
  orgResolver: OrgResolver,
): CorrectivePlanEntry | undefined {
  if (!isCorrectiveTarget(rec)) return undefined;

  const resolved =
    kind === "agent"
      ? orgResolver.resolveAgentOrg(rec)
      : orgResolver.resolveToolOrg(rec);

  const reason =
    resolved === undefined
      ? "unresolvable-orgUnknown"
      : resolved === "AMBIGUOUS"
        ? "ambiguous-multi-org"
        : kind === "agent"
          ? "fabricator-agent-sourceProjectId"
          : "fabricator-tool-appId";

  return {
    id: rec.id,
    name: rec.name,
    kind,
    previousOrgId: ALL_ORGS,
    resolvedOrgId: resolved === "AMBIGUOUS" ? undefined : resolved,
    reason,
  };
}

/**
 * Applies one planned corrective entry to BOTH stores: the registry
 * descriptor (via the approval-preserving marker-edit helper, never a raw
 * Put) and the DynamoDB agents/tools projection row. Conditional on the
 * record still holding its previously-observed value, to avoid clobbering a
 * concurrent write. Ambiguous and unresolvable entries are never written —
 * only planned/reported.
 */
export async function applyCorrectiveEntry(
  entry: CorrectivePlanEntry,
  type: ResourceType,
  registry: RegistryService,
  tableName: string,
  docClient: DynamoDBDocumentClient,
): Promise<{ error?: string }> {
  if (entry.reason === "ambiguous-multi-org") {
    return { error: undefined };
  }
  if (
    entry.reason === "unresolvable-orgUnknown" ||
    entry.resolvedOrgId === undefined
  ) {
    const editResult = await applyMarkerEdit(
      {
        recordId: entry.id,
        type,
        fieldsToSet: { orgUnknown: true },
        fieldsToRemove: ["orgId"],
      },
      {
        registryService: registry,
        dryRun: false,
        operationLabel: "backfill-shared-org-marker-correct-fabricator",
      },
    );
    if (editResult.error) return { error: editResult.error };

    const pkName = type === "agent" ? "agentId" : "toolId";
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { [pkName]: entry.id },
        UpdateExpression:
          "REMOVE #orgId SET #orgUnknown = :orgUnknown, #updatedAt = :updatedAt",
        ConditionExpression: "#orgId = :previousOrgId",
        ExpressionAttributeNames: {
          "#orgId": "orgId",
          "#orgUnknown": "orgUnknown",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":orgUnknown": true,
          ":updatedAt": new Date().toISOString(),
          ":previousOrgId": entry.previousOrgId,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return {};
  }

  const editResult = await applyMarkerEdit(
    { recordId: entry.id, type, fieldsToSet: { orgId: entry.resolvedOrgId } },
    {
      registryService: registry,
      dryRun: false,
      operationLabel: "backfill-shared-org-marker-correct-fabricator",
    },
  );
  if (editResult.error) return { error: editResult.error };

  const pkName = type === "agent" ? "agentId" : "toolId";
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { [pkName]: entry.id },
      UpdateExpression: "SET #orgId = :orgId, #updatedAt = :updatedAt",
      ConditionExpression: "#orgId = :previousOrgId",
      ExpressionAttributeNames: {
        "#orgId": "orgId",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":orgId": entry.resolvedOrgId,
        ":updatedAt": new Date().toISOString(),
        ":previousOrgId": entry.previousOrgId,
      },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return {};
}

/**
 * Default minimum attempts for retrying a single dropped record's detail
 * fetch before giving up on it. Per spec: "per-record exponential backoff
 * in seconds (>=5 attempts)".
 */
const CORRECTIVE_RECORD_RETRY_MIN_ATTEMPTS = 5;
/** Base delay (ms) for the per-record backoff schedule — overridable via `--delay-ms`. */
const CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Injectable backoff schedule: given an attempt number (1-based) and the
 * base delay in ms, returns how long to wait before the next attempt.
 * Exponential in seconds, matching {@link RegistryService}'s own retry
 * shape but exposed here so tests can supply a zero/near-zero schedule.
 */
export type RetryDelayFn = (attempt: number, baseDelayMs: number) => number;

export const defaultRetryDelay: RetryDelayFn = (attempt, baseDelayMs) =>
  baseDelayMs * Math.pow(2, attempt - 1);

/**
 * Re-fetches exactly the records whose detail GET failed on the initial
 * {@link RegistryService.listResourcesChecked} pass, one at a time
 * (concurrency 1, never re-listing the whole type), with per-record
 * exponential backoff. A record still unfetched after `maxAttempts` stays
 * dropped — the caller (which refuses to act on any remaining drop) is
 * responsible for treating that as an error.
 *
 * This deliberately does NOT retry via the registry's own list+detail
 * pass: re-listing the whole type re-triggers RegistryService's internal
 * concurrency-3 detail fetch across every record (not just the failed
 * ones), which re-saturates the same rate limit that caused the drops in
 * the first place and can make droppedCount grow across attempts instead
 * of shrink. Targeting only the known-bad recordIds, at concurrency 1,
 * keeps each retry pass small enough to fit under the limit.
 */
export async function reconcileDroppedRecords(
  registry: RegistryService,
  type: ResourceType,
  initial: ListResourcesResult,
  maxAttempts: number = CORRECTIVE_RECORD_RETRY_MIN_ATTEMPTS,
  baseDelayMs: number = CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS,
  delayFn: RetryDelayFn = defaultRetryDelay,
): Promise<ListResourcesResult> {
  const dropped = initial.droppedRecordIds ?? [];
  if (dropped.length === 0) {
    return initial;
  }

  const items = [...initial.items];
  let remaining = [...dropped];

  for (
    let attempt = 1;
    attempt <= maxAttempts && remaining.length > 0;
    attempt++
  ) {
    const stillMissing: string[] = [];
    for (const recordId of remaining) {
      try {
        const record = await registry.getResource(type, recordId);
        if (record) {
          items.push(record);
        } else {
          // Record genuinely gone (404) — not a throttle; do not keep
          // retrying something that will never resolve.
          log(
            "warn",
            `[correct-fabricator:${type}] recordId=${recordId} no longer exists (404) — dropping from plan`,
          );
        }
      } catch (err) {
        // A TypeMismatchError means the original detail-fetch drop was
        // never a throttle failure for THIS type — the record is the
        // other kind (agent vs tool) and listResourcesChecked's own
        // in-flight type filter would have excluded it anyway. Treat it
        // the same as that "filtered" outcome: drop silently, never
        // retry, never count as an unresolved partial.
        if (err instanceof Error && err.name === "TypeMismatchError") {
          log(
            "info",
            `[correct-fabricator:${type}] recordId=${recordId} is the other resource type — filtered, not a throttle failure`,
          );
          continue;
        }
        stillMissing.push(recordId);
        log(
          "warn",
          `[correct-fabricator:${type}] recordId=${recordId} targeted re-fetch failed (attempt ${attempt}/${maxAttempts}): ${String(err)}`,
        );
      }
    }
    remaining = stillMissing;
    if (remaining.length > 0 && attempt < maxAttempts) {
      const delayMs = delayFn(attempt, baseDelayMs);
      log(
        "warn",
        `[correct-fabricator:${type}] ${remaining.length} record(s) still unfetched — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delayMs);
    }
  }

  return {
    items,
    partial: remaining.length > 0,
    droppedCount: remaining.length,
    throttled: remaining.length > 0,
    droppedRecordIds: remaining.length > 0 ? remaining : undefined,
  };
}

/**
 * Scans one registry resource type for corrective-mode targets, logging the
 * previous value of every planned entry. Refuses (returns an error summary)
 * if the underlying list is partial/throttled — per spec, a throttled or
 * failed read is an error, never a silent partial apply.
 */
export async function runCorrectiveForRegistryType(
  type: ResourceType,
  registry: RegistryService,
  orgResolver: OrgResolver,
  apply: boolean,
  limit: number | undefined,
  summary: BackfillSummary,
  tableName: string,
  docClient: DynamoDBDocumentClient,
  recordId: string | undefined,
  retryDelayMs: number = CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS,
  retryMaxAttempts: number = CORRECTIVE_RECORD_RETRY_MIN_ATTEMPTS,
): Promise<CorrectivePlanEntry[]> {
  const plan: CorrectivePlanEntry[] = [];
  const kind = type === "agent" ? "agent" : "tool";

  const initialList = await registry.listResourcesChecked(type);
  const listed = await reconcileDroppedRecords(
    registry,
    type,
    initialList,
    retryMaxAttempts,
    retryDelayMs,
  );
  summary.scanned += listed.items.length;

  if (listed.partial || listed.throttled) {
    log(
      "error",
      `[correct-fabricator:${type}] ${listed.droppedCount} record(s) still unfetched after targeted retry (recordIds=${(listed.droppedRecordIds ?? []).join(",")}) — refusing to act on a known-partial list`,
    );
    summary.errors++;
    return plan;
  }

  for (const record of listed.items) {
    let meta: Record<string, unknown>;
    try {
      meta = record.customDescriptorContent
        ? JSON.parse(record.customDescriptorContent)
        : {};
    } catch (err) {
      log(
        "error",
        `[correct-fabricator:${type}] recordId=${record.recordId} malformed customDescriptorContent: ${String(err)}`,
      );
      summary.errors++;
      continue;
    }

    const rec: RecordShape = {
      id: record.recordId,
      name: record.name,
      orgId: typeof meta.orgId === "string" ? meta.orgId : undefined,
      orgUnknown: meta.orgUnknown === true,
      createdBy:
        typeof meta.createdBy === "string" ? meta.createdBy : undefined,
      sourceProjectId:
        typeof meta.sourceProjectId === "string"
          ? meta.sourceProjectId
          : undefined,
      appId: typeof meta.appId === "string" ? meta.appId : undefined,
    };

    const entry = planCorrectiveEntry(rec, kind, orgResolver);
    if (!entry) continue;

    plan.push(entry);
    log(
      "info",
      `[correct-fabricator:${type}] PLAN id=${entry.id} name=${entry.name ?? "<none>"} kind=${entry.kind} previousOrgId=${entry.previousOrgId} resolvedOrgId=${entry.resolvedOrgId ?? "<unresolved>"} reason=${entry.reason}`,
    );

    if (entry.reason === "ambiguous-multi-org") {
      summary.ambiguousReported++;
      continue;
    }

    // `--record-id` scopes WRITES to a single canary record. Every target
    // is still planned/printed (the operator needs to see the full set),
    // but only the matching record is ever mutated.
    const inCanaryScope = recordId === undefined || entry.id === recordId;

    if (apply && inCanaryScope) {
      if (
        limit !== undefined &&
        summary.markedTenant + summary.markedUnknown >= limit
      ) {
        continue;
      }
      try {
        const result = await applyCorrectiveEntry(
          entry,
          type,
          registry,
          tableName,
          docClient,
        );
        if (result.error) {
          log(
            "error",
            `[correct-fabricator:${type}] recordId=${entry.id} write failed: ${result.error}`,
          );
          summary.errors++;
          continue;
        }
      } catch (err) {
        log(
          "error",
          `[correct-fabricator:${type}] recordId=${entry.id} unexpected write error: ${String(err)}`,
        );
        summary.errors++;
        continue;
      }
      if (entry.resolvedOrgId !== undefined) summary.markedTenant++;
      else summary.markedUnknown++;
    }
  }

  return plan;
}

/**
 * Scans a DDB agents/tools projection table directly for corrective-mode
 * targets that the registry-sourced scan in {@link runCorrectiveForRegistryType}
 * would miss: rows where the DDB projection still holds
 * ALL_ORGS+fabricator+non-seed-name, independent of what the matching
 * registry record currently holds.
 *
 * This exists because a prior `--apply` run could leave the two stores
 * disagreeing — e.g. the registry write was throttled (never landed) or
 * was already corrected by a different path, while the DDB row is still
 * stuck at ALL_ORGS. Filtering on the registry listing alone (as the
 * original registry-sourced pass does) can never find these DDB-only
 * drift rows, because by definition their registry record is NOT ALL_ORGS
 * and so never matches `isCorrectiveTarget` there.
 *
 * `alreadyPlannedIds` — ids already covered by the registry-sourced plan
 * for this type; skipped here to avoid a duplicate plan entry (and a
 * duplicate write) for the same record.
 */
export async function findDdbOnlyCorrectiveTargets(
  kind: "agent" | "tool",
  tableName: string,
  docClient: DynamoDBDocumentClient,
  orgResolver: OrgResolver,
  alreadyPlannedIds: ReadonlySet<string>,
): Promise<CorrectivePlanEntry[]> {
  const entries: CorrectivePlanEntry[] = [];
  const pkName = kind === "agent" ? "agentId" : "toolId";
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of scanResult.Items || []) {
      const id = item[pkName];
      if (typeof id !== "string" || alreadyPlannedIds.has(id)) continue;

      const rec: RecordShape = {
        id,
        name: typeof item.name === "string" ? item.name : undefined,
        orgId: typeof item.orgId === "string" ? item.orgId : undefined,
        orgUnknown: item.orgUnknown === true,
        createdBy:
          typeof item.createdBy === "string" ? item.createdBy : undefined,
        sourceProjectId:
          typeof item.sourceProjectId === "string"
            ? item.sourceProjectId
            : undefined,
        appId: typeof item.appId === "string" ? item.appId : undefined,
      };

      const entry = planCorrectiveEntry(rec, kind, orgResolver);
      if (entry) entries.push(entry);
    }

    exclusiveStartKey = scanResult.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return entries;
}

/**
 * Builds a synchronous {@link OrgResolver} from pre-fetched lookup maps.
 * Corrective mode fetches projects and agent-binding data ONCE up front
 * (one projects-table scan, one agent-table scan) so the resolver itself
 * stays a pure, synchronous function — matching the `OrgResolver` contract
 * and keeping `classifyRecord`/`planCorrectiveEntry` free of I/O.
 *
 * `projectOrgById` — projectId -> organization (projects table).
 * `agentsByAppId` — appId -> list of { sourceProjectId } for every agent
 *   bound to that app (used to resolve a tool's org via its binding agents).
 */
export function buildOrgResolverFromMaps(
  projectOrgById: ReadonlyMap<string, string>,
  agentsByAppId: ReadonlyMap<
    string,
    ReadonlyArray<{ sourceProjectId?: string }>
  >,
): OrgResolver {
  return {
    resolveAgentOrg: (rec: RecordShape) => {
      if (rec.sourceProjectId === undefined) return undefined;
      return projectOrgById.get(rec.sourceProjectId);
    },
    resolveToolOrg: (rec: RecordShape) => {
      if (rec.appId === undefined) return undefined;
      const boundAgents = agentsByAppId.get(rec.appId);
      if (!boundAgents || boundAgents.length === 0) return undefined;

      const orgs = new Set<string>();
      for (const agent of boundAgents) {
        if (agent.sourceProjectId === undefined) continue;
        const org = projectOrgById.get(agent.sourceProjectId);
        if (org !== undefined) orgs.add(org);
      }

      if (orgs.size === 0) return undefined;
      if (orgs.size > 1) return "AMBIGUOUS";
      return [...orgs][0];
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;
  const correctFabricatorShared = args.includes("--correct-fabricator-shared");
  const recordIdIdx = args.indexOf("--record-id");
  const recordId =
    recordIdIdx !== -1 && args[recordIdIdx + 1] !== undefined
      ? args[recordIdIdx + 1]
      : undefined;
  const limitIdx = args.indexOf("--limit");
  const limitRaw =
    limitIdx !== -1 && args[limitIdx + 1] !== undefined
      ? args[limitIdx + 1]
      : undefined;
  if (limitRaw !== undefined && !/^\d+$/.test(limitRaw)) {
    throw new Error(
      `--limit must be a non-negative integer, got "${limitRaw}"`,
    );
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

  const delayMsIdx = args.indexOf("--delay-ms");
  const delayMsRaw =
    delayMsIdx !== -1 && args[delayMsIdx + 1] !== undefined
      ? args[delayMsIdx + 1]
      : undefined;
  if (delayMsRaw !== undefined && !/^\d+$/.test(delayMsRaw)) {
    throw new Error(
      `--delay-ms must be a non-negative integer, got "${delayMsRaw}"`,
    );
  }
  const delayMs =
    delayMsRaw !== undefined
      ? Number(delayMsRaw)
      : CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS;

  const registryId = process.env.REGISTRY_ID;
  const region = process.env.AWS_REGION || "us-west-2";
  const agentTable = process.env.AGENT_CONFIG_TABLE;
  const toolTable = process.env.TOOL_CONFIG_TABLE;
  const projectsTable = process.env.PROJECTS_TABLE;

  if (!registryId) throw new Error("REGISTRY_ID env var required");
  if (!agentTable) throw new Error("AGENT_CONFIG_TABLE env var required");
  if (!toolTable) throw new Error("TOOL_CONFIG_TABLE env var required");
  if (correctFabricatorShared && !projectsTable) {
    throw new Error(
      "PROJECTS_TABLE env var required when --correct-fabricator-shared is set",
    );
  }

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  log("info", `REGISTRY_ID=${registryId} REGION=${region}`);
  log(
    "info",
    `AGENT_CONFIG_TABLE=${agentTable} TOOL_CONFIG_TABLE=${toolTable}`,
  );

  const registry = new RegistryService({ registryId, region });
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  if (correctFabricatorShared) {
    await runCorrectiveMode(
      registry,
      docClient,
      agentTable,
      toolTable,
      // projectsTable is guaranteed defined by the guard above
      projectsTable as string,
      apply,
      limit,
      recordId,
      delayMs,
    );
    return;
  }

  // Default pass: resolve fabricator-created blank-orgId records to their
  // tenant org too (not just corrective mode) — see R1 fix. Best-effort:
  // if PROJECTS_TABLE isn't configured, or the resolver scan itself fails,
  // fall back to the pre-existing behaviour (orgUnknown) rather than
  // failing the whole run.
  let defaultPassOrgResolver: OrgResolver | undefined;
  if (projectsTable) {
    try {
      defaultPassOrgResolver = await buildOrgResolverFromTables(
        docClient,
        projectsTable,
        agentTable,
      );
    } catch (err) {
      log(
        "warn",
        `Org resolver setup failed — fabricator-created blank-orgId records will be marked orgUnknown instead of resolved: ${String(err)}`,
      );
    }
  } else {
    log(
      "warn",
      "PROJECTS_TABLE not set — fabricator-created blank-orgId records will be marked orgUnknown instead of resolved to their tenant org",
    );
  }

  const totals = emptySummary();

  addSummary(
    totals,
    await processRegistry("agent", registry, apply, defaultPassOrgResolver),
  );
  addSummary(
    totals,
    await processRegistry("tool", registry, apply, defaultPassOrgResolver),
  );
  addSummary(
    totals,
    await processDdbTable(
      "agent",
      agentTable,
      docClient,
      apply,
      defaultPassOrgResolver,
    ),
  );
  addSummary(
    totals,
    await processDdbTable(
      "tool",
      toolTable,
      docClient,
      apply,
      defaultPassOrgResolver,
    ),
  );

  log("info", "--- Backfill summary ---");
  log("info", `mode:              ${dryRun ? "dry-run" : "apply"}`);
  log("info", `scanned:           ${totals.scanned}`);
  log("info", `markedShared:      ${totals.markedShared}`);
  log("info", `markedTenant:      ${totals.markedTenant}`);
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

  if (totals.errors > 0) {
    process.exit(1);
  }
}

/**
 * Scans the projects table (projectId -> organization) and the agents
 * table (appId -> binding agents' sourceProjectId) once, and builds a
 * synchronous {@link OrgResolver} from the resulting maps via
 * {@link buildOrgResolverFromMaps}. Shared by both the default pass
 * (R1 fix — resolves fabricator org outside corrective mode too) and
 * {@link runCorrectiveMode}. Throws on a scan failure; callers decide
 * whether that's fatal (corrective mode) or best-effort (default pass).
 */
export async function buildOrgResolverFromTables(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  agentTable: string,
): Promise<OrgResolver> {
  const projectOrgById = new Map<string, string>();
  {
    let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
    do {
      let scanResult;
      try {
        scanResult = await docClient.send(
          new ScanCommand({
            TableName: projectsTable,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
      } catch (err) {
        throw new Error(`Projects table scan failed: ${String(err)}`);
      }
      for (const item of scanResult.Items || []) {
        const projectId = item.projectId ?? item.id;
        if (
          typeof projectId === "string" &&
          typeof item.organization === "string"
        ) {
          projectOrgById.set(projectId, item.organization);
        }
      }
      exclusiveStartKey = scanResult.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  const agentsByAppId = new Map<string, Array<{ sourceProjectId?: string }>>();
  {
    let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
    do {
      let scanResult;
      try {
        scanResult = await docClient.send(
          new ScanCommand({
            TableName: agentTable,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
      } catch (err) {
        throw new Error(
          `Agent table scan failed (for tool org resolution): ${String(err)}`,
        );
      }
      for (const item of scanResult.Items || []) {
        const appId = item.appId;
        if (typeof appId !== "string") continue;
        const list = agentsByAppId.get(appId) ?? [];
        list.push({
          sourceProjectId:
            typeof item.sourceProjectId === "string"
              ? item.sourceProjectId
              : undefined,
        });
        agentsByAppId.set(appId, list);
      }
      exclusiveStartKey = scanResult.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  return buildOrgResolverFromMaps(projectOrgById, agentsByAppId);
}

/**
 * Corrective-mode entry point. Pre-fetches the projects table (projectId ->
 * organization) and the agents table (appId -> binding agents) once, builds
 * a synchronous OrgResolver from those maps, then scans the agent and tool
 * registries for ALL_ORGS+fabricator+non-seed-name records and re-stamps
 * BOTH the registry descriptor and the DynamoDB projection row for each
 * resolvable one. Dry-run by default; `--record-id` scopes to a single
 * canary record; `--limit` bounds how many records get WRITTEN in apply
 * mode (the plan/print phase is never bounded).
 */
async function runCorrectiveMode(
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  agentTable: string,
  toolTable: string,
  projectsTable: string,
  apply: boolean,
  limit: number | undefined,
  recordId: string | undefined,
  delayMs: number = CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS,
): Promise<void> {
  log("info", `Corrective mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (recordId) log("info", `Scoped to single record id=${recordId} (canary)`);

  let orgResolver: OrgResolver;
  try {
    orgResolver = await buildOrgResolverFromTables(
      docClient,
      projectsTable,
      agentTable,
    );
  } catch (err) {
    log("error", String(err));
    process.exit(1);
    return;
  }

  const summary = emptySummary();
  const fullPlan: CorrectivePlanEntry[] = [];

  const agentPlan = await runCorrectiveForRegistryType(
    "agent",
    registry,
    orgResolver,
    apply,
    limit,
    summary,
    agentTable,
    docClient,
    recordId,
    delayMs,
  );
  const toolPlan = await runCorrectiveForRegistryType(
    "tool",
    registry,
    orgResolver,
    apply,
    limit,
    summary,
    toolTable,
    docClient,
    recordId,
    delayMs,
  );

  // R2: the registry-sourced scans above only find records whose CURRENT
  // registry orgId is still ALL_ORGS. A prior partial/throttled --apply
  // can leave a DDB projection row stuck at ALL_ORGS while its matching
  // registry record has already diverged (corrected by another path, or
  // simply never written) — that row would otherwise never be planned.
  // Scan each DDB table directly for the same ALL_ORGS+fabricator+
  // non-seed-name signature, skipping ids already covered above so no
  // record is planned (or written) twice.
  const registryPlannedIds = new Set<string>([
    ...agentPlan.map((e) => e.id),
    ...toolPlan.map((e) => e.id),
  ]);
  const agentDdbOnlyPlan = await findDdbOnlyCorrectiveTargets(
    "agent",
    agentTable,
    docClient,
    orgResolver,
    registryPlannedIds,
  );
  const toolDdbOnlyPlan = await findDdbOnlyCorrectiveTargets(
    "tool",
    toolTable,
    docClient,
    orgResolver,
    registryPlannedIds,
  );

  for (const entry of [...agentDdbOnlyPlan, ...toolDdbOnlyPlan]) {
    log(
      "info",
      `[correct-fabricator:ddb-only:${entry.kind}] PLAN id=${entry.id} name=${entry.name ?? "<none>"} previousOrgId=${entry.previousOrgId} resolvedOrgId=${entry.resolvedOrgId ?? "<unresolved>"} reason=${entry.reason}`,
    );

    if (entry.reason === "ambiguous-multi-org") {
      summary.ambiguousReported++;
      continue;
    }

    const inCanaryScope = recordId === undefined || entry.id === recordId;
    if (!apply || !inCanaryScope) continue;
    if (
      limit !== undefined &&
      summary.markedTenant + summary.markedUnknown >= limit
    ) {
      continue;
    }

    try {
      const type: ResourceType = entry.kind === "agent" ? "agent" : "tool";
      const tableName = entry.kind === "agent" ? agentTable : toolTable;
      const result = await applyCorrectiveEntry(
        entry,
        type,
        registry,
        tableName,
        docClient,
      );
      if (result.error) {
        log(
          "error",
          `[correct-fabricator:ddb-only:${entry.kind}] recordId=${entry.id} write failed: ${result.error}`,
        );
        summary.errors++;
        continue;
      }
    } catch (err) {
      log(
        "error",
        `[correct-fabricator:ddb-only:${entry.kind}] recordId=${entry.id} unexpected write error: ${String(err)}`,
      );
      summary.errors++;
      continue;
    }
    if (entry.resolvedOrgId !== undefined) summary.markedTenant++;
    else summary.markedUnknown++;
  }

  fullPlan.push(
    ...(recordId
      ? [
          ...agentPlan,
          ...toolPlan,
          ...agentDdbOnlyPlan,
          ...toolDdbOnlyPlan,
        ].filter((e) => e.id === recordId)
      : [...agentPlan, ...toolPlan, ...agentDdbOnlyPlan, ...toolDdbOnlyPlan]),
  );

  log("info", "--- Corrective mode planned set ---");
  for (const entry of fullPlan) {
    log(
      "info",
      `SET id=${entry.id} name=${entry.name ?? "<none>"} kind=${entry.kind} currentOrg=${entry.previousOrgId} resolvedOrg=${entry.resolvedOrgId ?? "<unresolved>"} reason=${entry.reason}`,
    );
  }

  log("info", "--- Corrective mode summary ---");
  log("info", `mode:              ${apply ? "apply" : "dry-run"}`);
  log("info", `scanned:           ${summary.scanned}`);
  log("info", `plannedTotal:      ${fullPlan.length}`);
  log("info", `markedTenant:      ${summary.markedTenant}`);
  log("info", `markedUnknown:     ${summary.markedUnknown}`);
  log("info", `ambiguousReported: ${summary.ambiguousReported}`);
  log("info", `errors:            ${summary.errors}`);

  if (summary.errors > 0) {
    process.exit(1);
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
