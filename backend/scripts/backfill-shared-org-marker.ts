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
      // Not reachable from the default (non-corrective) pass, which never
      // supplies an orgResolver — corrective mode re-stamps via
      // correctFabricatorRecord instead. Handled here only for exhaustiveness.
      summary.markedTenant++;
      log(
        "info",
        `[${type}] recordId=${recordId} -> orgId=${classification.targetOrgId} (${classification.reason})`,
      );
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
          case "mark-tenant":
            // Not reachable from the default (non-corrective) pass. Handled
            // here only for exhaustiveness — corrective mode re-stamps via
            // correctFabricatorRecord instead.
            summary.markedTenant++;
            log(
              "info",
              `[${kind}] id=${id} -> orgId=${classification.targetOrgId} (${classification.reason})`,
            );
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
async function applyCorrectiveEntry(
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
 * Scans one registry resource type for corrective-mode targets, logging the
 * previous value of every planned entry. Refuses (returns an error summary)
 * if the underlying list is partial/throttled — per spec, a throttled or
 * failed read is an error, never a silent partial apply.
 */
async function runCorrectiveForRegistryType(
  type: ResourceType,
  registry: RegistryService,
  orgResolver: OrgResolver,
  apply: boolean,
  limit: number | undefined,
  summary: BackfillSummary,
  tableName: string,
  docClient: DynamoDBDocumentClient,
): Promise<CorrectivePlanEntry[]> {
  const plan: CorrectivePlanEntry[] = [];
  const kind = type === "agent" ? "agent" : "tool";

  const listed = await registry.listResourcesChecked(type);
  summary.scanned += listed.items.length;

  if (listed.partial || listed.throttled) {
    log(
      "error",
      `[correct-fabricator:${type}] registry list is partial/throttled (droppedCount=${listed.droppedCount}) — refusing to act on a known-partial list`,
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

    if (apply) {
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
  const limit =
    limitIdx !== -1 && args[limitIdx + 1] !== undefined
      ? Number(args[limitIdx + 1])
      : undefined;

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
    );
    return;
  }

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
): Promise<void> {
  log("info", `Corrective mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (recordId) log("info", `Scoped to single record id=${recordId} (canary)`);

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
        log("error", `Projects table scan failed: ${String(err)}`);
        process.exit(1);
        return;
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
        log(
          "error",
          `Agent table scan failed (for tool org resolution): ${String(err)}`,
        );
        process.exit(1);
        return;
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

  const orgResolver = buildOrgResolverFromMaps(projectOrgById, agentsByAppId);
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
  );

  fullPlan.push(
    ...(recordId
      ? [...agentPlan, ...toolPlan].filter((e) => e.id === recordId)
      : [...agentPlan, ...toolPlan]),
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
