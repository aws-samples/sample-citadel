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
 *   --fallback-org <org>           Owner-supplied explicit fallback,
 *                                 OFF by default, valid ONLY together with
 *                                 --correct-fabricator-shared. Applies
 *                                 ONLY to records that are createdBy
 *                                 fabricator, non-seed-name, and otherwise
 *                                 unresolvable (reason `fallback-org`) —
 *                                 never to ambiguous, seed-name,
 *                                 non-fabricator, or normally-resolvable
 *                                 records. The value must match an
 *                                 `organization` value that actually
 *                                 exists in the projects table; otherwise
 *                                 the script exits non-zero before any
 *                                 write. The dry run always prints the
 *                                 complete fallback candidate list.
 *   --call-delay-ms <ms>           Non-negative integer inter-call pacing
 *                                 (ms) applied between registry calls
 *                                 (getResource, updateResource,
 *                                 waitForStableState poll,
 *                                 submitForApproval, decide) in the
 *                                 marker-edit/corrective path — separate
 *                                 from the per-record `--delay-ms` retry
 *                                 backoff. Defaults to 300 when --apply is
 *                                 set and the flag is omitted (0 in
 *                                 dry-run, which never writes).
 *   --restore-approval <id,...>    Comma-separated registry recordId(s)
 *                                 whose org marker is already correct but
 *                                 whose registry status was left DRAFT by
 *                                 a partial write (see `needsReapproval`
 *                                 in the corrective-mode summary). Runs
 *                                 wait-stable -> submitForApproval ->
 *                                 decide(APPROVED) and verifies the final
 *                                 status. Dry-run by default (prints the
 *                                 plan); no-op for an already-APPROVED
 *                                 record; exits non-zero if restoration
 *                                 fails. Valid ONLY together with
 *                                 --correct-fabricator-shared.
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
  GetCommand,
  ScanCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  RegistryService,
  ResourceType,
  RegistryRecord,
  ListResourcesResult,
  RegistryRecordStatusValues,
} from "../src/services/registry-service";
import { ALL_ORGS } from "../src/utils/org-constants";
import { applyMarkerEdit } from "../src/utils/marker-registry-edit";
import {
  buildAgentProjectionRow,
  buildToolProjectionRow,
  writeProjectionRow,
} from "../src/lambda/registry-sync";

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
}

/**
 * Org-resolution callbacks for fabricator-created records.
 *
 * `resolveAgentOrg` — given a record with `sourceProjectId`, look up the
 *   project in the projects table and return its `organization` field, or
 *   `undefined` if not resolvable.
 *
 * `resolveToolOrg` — given a tool record, look up its `name` in a
 *   pre-built toolName -> set(org) index (see {@link buildToolNameOrgIndex})
 *   and return:
 *     - the single org string if the name maps to exactly one distinct org
 *     - `"AMBIGUOUS"` if the name maps to multiple distinct orgs
 *     - `undefined` if the name has no entry (orgUnknown) or is absent
 *   Tool->agent binding is NAME-based: a tool name is matched against the
 *   set of tool names referenced by every known agent's
 *   `config.schema.tools[]` (plus non-empty `manifest.tools[]`), never via
 *   `appId` (removed — no live data ever populated that binding).
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
 * tenant-resolution path (sourceProjectId for agents, tool NAME → the
 * toolName -> org index for tools) — see `OrgResolver` doc comment. Never
 * mutates `rec`.
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
  // a record with neither `sourceProjectId` nor a name-allowlist/createdBy-
  // allowlist match is tool-shaped and resolved by NAME via `resolveToolOrg`
  // (see `OrgResolver` doc comment — this never uses `appId`, which no live
  // agent/tool record ever populated).
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

    const resolved = orgResolver.resolveToolOrg(rec);
    if (resolved === "AMBIGUOUS") {
      return { outcome: "ambiguous", resolvedOrgId: "AMBIGUOUS" };
    }
    if (resolved !== undefined) {
      return {
        outcome: "mark-tenant",
        targetOrgId: resolved,
        reason: "fabricator-tool-name",
      };
    }
    return { outcome: "mark-unknown" };
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
  markedFallback: number;
  alreadyShared: number;
  alreadyUnknown: number;
  ambiguousReported: number;
  errors: number;
  /**
   * Records attempted (written) in corrective apply mode, regardless of
   * outcome — successes AND failures. `--limit` bounds this count, never
   * the success-only counters, so a throttled/failed write still consumes
   * the limit instead of letting the loop silently touch more than N
   * records (the exact incident gap: a failure "did not count toward
   * --limit").
   */
  attempted: number;
  /**
   * Records whose UpdateRegistryRecord write landed (the registry demoted
   * them to DRAFT) but whose post-write approval restoration failed —
   * distinct from `errors`, which covers failures BEFORE the write landed.
   * Never abandoned: the main loop continues to the next record, and one
   * more pass runs over this bucket at the end of a corrective apply.
   */
  needsReapproval: number;
  /**
   * Records whose registry write landed and converged fine, EXCEPT the
   * registry-backed path never writes DDB directly anymore (Required
   * change 1) — it WAITS (bounded, injectable clock) for registry-sync to
   * project the new orgId/registryStatus into the DDB row. A record that
   * does not converge within the wait window is bucketed here, distinct
   * from `errors`, and the loop continues to the next record. The
   * end-of-run resync pass (Required change 2) gets one more attempt at
   * every id in this bucket; only an id STILL unconverged after that pass
   * counts toward a non-zero exit.
   */
  projectionLag: number;
}

export function emptySummary(): BackfillSummary {
  return {
    scanned: 0,
    markedShared: 0,
    markedTenant: 0,
    markedUnknown: 0,
    markedFallback: 0,
    alreadyShared: 0,
    alreadyUnknown: 0,
    ambiguousReported: 0,
    errors: 0,
    attempted: 0,
    needsReapproval: 0,
    projectionLag: 0,
  };
}

export function addSummary(dst: BackfillSummary, src: BackfillSummary): void {
  dst.scanned += src.scanned;
  dst.markedShared += src.markedShared;
  dst.markedTenant += src.markedTenant;
  dst.markedUnknown += src.markedUnknown;
  dst.markedFallback += src.markedFallback;
  dst.alreadyShared += src.alreadyShared;
  dst.alreadyUnknown += src.alreadyUnknown;
  dst.ambiguousReported += src.ambiguousReported;
  dst.errors += src.errors;
  dst.attempted += src.attempted;
  dst.needsReapproval += src.needsReapproval;
  dst.projectionLag += src.projectionLag;
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
 *
 * `fallbackOrg`, when supplied, is applied ONLY when the record would
 * otherwise be `unresolvable-orgUnknown` — i.e. it is already known (via
 * {@link isCorrectiveTarget}) to be createdBy fabricator and non-seed-name,
 * and the normal resolution path (sourceProjectId / tool-name index) found
 * nothing. It NEVER overrides an `ambiguous-multi-org` result or a
 * normally-resolvable one. The resulting entry carries
 * `reason: "fallback-org"`.
 */
export function planCorrectiveEntry(
  rec: RecordShape,
  kind: "agent" | "tool",
  orgResolver: OrgResolver,
  fallbackOrg?: string,
): CorrectivePlanEntry | undefined {
  if (!isCorrectiveTarget(rec)) return undefined;

  const resolved =
    kind === "agent"
      ? orgResolver.resolveAgentOrg(rec)
      : orgResolver.resolveToolOrg(rec);

  if (resolved === undefined && fallbackOrg !== undefined) {
    return {
      id: rec.id,
      name: rec.name,
      kind,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: fallbackOrg,
      reason: "fallback-org",
    };
  }

  const reason =
    resolved === undefined
      ? "unresolvable-orgUnknown"
      : resolved === "AMBIGUOUS"
        ? "ambiguous-multi-org"
        : kind === "agent"
          ? "fabricator-agent-sourceProjectId"
          : "fabricator-tool-name";

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
 * True when an {@link MarkerEditResult}-shaped response indicates the
 * registry write landed (UpdateRegistryRecord succeeded, demoting the
 * record to DRAFT) but the post-write approval-restoration steps
 * (submitForApproval / decide) failed to bring it back to APPROVED —
 * `applyMarkerEdit` swallows that failure internally (console.warn) and
 * returns successfully with `reapproved: false`, `error: undefined`. That
 * is indistinguishable from "nothing needed restoring" UNLESS the record
 * was APPROVED beforehand, so the check requires `priorStatus ===
 * "APPROVED"` — never flags a record that was already DRAFT/other.
 */
function editResultNeedsReapproval(editResult: {
  priorStatus: string;
  postStatus: string;
  reapproved: boolean;
  error?: string;
}): boolean {
  return (
    editResult.error === undefined &&
    editResult.priorStatus === "APPROVED" &&
    !editResult.reapproved
  );
}

/**
 * Injectable clock/sleep pair for the bounded projection-convergence wait
 * below — mirrors the `RetryDelayFn`/`CallPacer` injection pattern already
 * used elsewhere in this file, so tests can supply a synthetic clock with
 * zero real delay instead of waiting out a real 60s window.
 */
export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Default bounded wait window (ms) for projection convergence. */
export const DEFAULT_PROJECTION_WAIT_MS = 60000;
/** Default poll interval (ms) for projection convergence. */
export const DEFAULT_PROJECTION_POLL_INTERVAL_MS = 2000;

/**
 * The desired post-edit projection state a convergence wait polls for.
 * `expectedOrgId: undefined` together with `expectedOrgUnknown: true`
 * covers the orgUnknown branch (orgId attribute absent, orgUnknown=true);
 * otherwise `expectedOrgId` names the resolved tenant org and
 * `expectedOrgUnknown` must be absent/false.
 */
export interface ProjectionExpectation {
  expectedOrgId?: string;
  expectedOrgUnknown?: boolean;
  /** The pre-edit registry status the projection should still show (e.g. APPROVED). */
  expectedRegistryStatus: string;
}

/**
 * Bounded poll (injectable clock) for registry-sync to project the new
 * orgId/registryStatus into the DDB row — the single-writer replacement
 * for the removed direct DDB write in the registry-backed corrective path
 * (Required change 1). Never writes; read-only `GetCommand` polling.
 *
 * Converged when the row's `orgId` (or absence + `orgUnknown===true`)
 * matches the expectation AND `registryStatus` equals
 * `expectedRegistryStatus` (the pre-edit status, since a marker-only edit
 * does not change registry status). Returns `true` on convergence within
 * `maxWaitMs`, `false` otherwise — the caller buckets a `false` result into
 * `projectionLag`, never `errors`.
 */
export async function waitForProjectionConvergence(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  pkName: "agentId" | "toolId",
  id: string,
  expectation: ProjectionExpectation,
  maxWaitMs: number = DEFAULT_PROJECTION_WAIT_MS,
  pollIntervalMs: number = DEFAULT_PROJECTION_POLL_INTERVAL_MS,
  clock: Clock = defaultClock,
): Promise<boolean> {
  const start = clock.now();
  const matches = (item: Record<string, unknown> | undefined): boolean => {
    if (!item) return false;
    if (item.registryStatus !== expectation.expectedRegistryStatus) {
      return false;
    }
    if (expectation.expectedOrgUnknown) {
      return item.orgUnknown === true && item.orgId === undefined;
    }
    return item.orgId === expectation.expectedOrgId && item.orgUnknown !== true;
  };

  for (;;) {
    let result;
    try {
      result = await docClient.send(
        new GetCommand({ TableName: tableName, Key: { [pkName]: id } }),
      );
    } catch {
      // A transient read failure during the wait is treated as "not yet
      // converged" — the loop retries until the deadline rather than
      // propagating, since a poll read failure is not itself an error in
      // the corrective write (which already landed in the registry).
      result = undefined;
    }
    if (matches(result?.Item)) return true;
    if (clock.now() - start >= maxWaitMs) return false;
    await clock.sleep(pollIntervalMs);
  }
}

/**
 * Applies one planned corrective entry to the registry ONLY — via the
 * approval-preserving marker-edit helper, never a raw Put — and then WAITS
 * (bounded, injectable clock) for registry-sync to project the new
 * orgId/registryStatus into the DDB row, instead of writing DDB directly
 * (Required change 1: single-writer, registry-sync owns the DDB
 * projection). Ambiguous and unresolvable-without-fallback entries are
 * never written — only planned/reported.
 *
 * `needsReapproval: true` means the org marker landed but the registry
 * record was left DRAFT instead of its prior APPROVED — bucketed distinct
 * from `error`, retried by the end-of-run re-approval pass /
 * `--restore-approval`. `projectionLag: true` means the registry write (and
 * reapproval, if any) succeeded but the DDB projection had not converged
 * within the wait window — bucketed distinct from both `error` and
 * `needsReapproval`, retried by the end-of-run resync pass /
 * `--resync-projection`.
 */
export async function applyCorrectiveEntry(
  entry: CorrectivePlanEntry,
  type: ResourceType,
  registry: RegistryService,
  tableName: string,
  docClient: DynamoDBDocumentClient,
  callDelayMs: number = DEFAULT_CALL_DELAY_MS,
  callPacer: CallPacer = defaultCallPacer,
  waitMs: number = DEFAULT_PROJECTION_WAIT_MS,
  pollIntervalMs: number = DEFAULT_PROJECTION_POLL_INTERVAL_MS,
  clock: Clock = defaultClock,
): Promise<{
  error?: string;
  needsReapproval?: boolean;
  projectionLag?: boolean;
}> {
  if (entry.reason === "ambiguous-multi-org") {
    return { error: undefined };
  }

  const pkName: "agentId" | "toolId" = type === "agent" ? "agentId" : "toolId";
  const isUnresolvable =
    entry.reason === "unresolvable-orgUnknown" ||
    entry.resolvedOrgId === undefined;

  const editResult = await applyMarkerEdit(
    isUnresolvable
      ? {
          recordId: entry.id,
          type,
          fieldsToSet: { orgUnknown: true },
          fieldsToRemove: ["orgId"],
        }
      : {
          recordId: entry.id,
          type,
          fieldsToSet: { orgId: entry.resolvedOrgId },
        },
    {
      registryService: registry,
      dryRun: false,
      operationLabel: "backfill-shared-org-marker-correct-fabricator",
      callDelayMs,
      callPacer,
    },
  );
  if (editResult.error) return { error: editResult.error };
  const needsReapproval = editResultNeedsReapproval(editResult);

  const converged = await waitForProjectionConvergence(
    docClient,
    tableName,
    pkName,
    entry.id,
    isUnresolvable
      ? {
          expectedOrgUnknown: true,
          expectedRegistryStatus: editResult.priorStatus,
        }
      : {
          expectedOrgId: entry.resolvedOrgId,
          expectedRegistryStatus: editResult.priorStatus,
        },
    waitMs,
    pollIntervalMs,
    clock,
  );

  const result: {
    error?: string;
    needsReapproval?: boolean;
    projectionLag?: boolean;
  } = {};
  if (needsReapproval) result.needsReapproval = true;
  if (!converged) result.projectionLag = true;
  return result;
}

/**
 * Applies one planned corrective entry that is DDB-only drift (see
 * {@link findDdbOnlyCorrectiveTargets}): the registry record has no
 * matching corrective signature (already corrected, or never written),
 * but the DDB projection row is still stuck. This is the ONE remaining
 * direct-DDB-write path (Required change 3) — conditioned on the row
 * still holding its previously-observed value. A
 * `ConditionalCheckFailedException` is treated as potential convergence,
 * not an automatic failure: the row is re-read, and if it is ALREADY in
 * the desired state (idempotent convergence — e.g. registry-sync or a
 * concurrent run already moved it) this returns success; otherwise it is
 * a genuine conflict and returns `error`.
 */
export async function applyDdbOnlyCorrectiveEntry(
  entry: CorrectivePlanEntry,
  type: ResourceType,
  registry: RegistryService,
  tableName: string,
  docClient: DynamoDBDocumentClient,
  callDelayMs: number = DEFAULT_CALL_DELAY_MS,
  callPacer: CallPacer = defaultCallPacer,
): Promise<{ error?: string; needsReapproval?: boolean }> {
  if (entry.reason === "ambiguous-multi-org") {
    return { error: undefined };
  }

  const pkName = type === "agent" ? "agentId" : "toolId";
  const isUnresolvable =
    entry.reason === "unresolvable-orgUnknown" ||
    entry.resolvedOrgId === undefined;

  const editResult = await applyMarkerEdit(
    isUnresolvable
      ? {
          recordId: entry.id,
          type,
          fieldsToSet: { orgUnknown: true },
          fieldsToRemove: ["orgId"],
        }
      : {
          recordId: entry.id,
          type,
          fieldsToSet: { orgId: entry.resolvedOrgId },
        },
    {
      registryService: registry,
      dryRun: false,
      operationLabel: "backfill-shared-org-marker-correct-fabricator",
      callDelayMs,
      callPacer,
    },
  );
  if (editResult.error) return { error: editResult.error };
  const needsReapproval = editResultNeedsReapproval(editResult);

  const ddbFieldsToSet = isUnresolvable
    ? {
        UpdateExpression:
          "REMOVE #orgId SET #orgUnknown = :orgUnknown, #updatedAt = :updatedAt",
        names: {
          "#orgId": "orgId",
          "#orgUnknown": "orgUnknown",
          "#updatedAt": "updatedAt",
        } as Record<string, string>,
        values: {
          ":orgUnknown": true,
          ":updatedAt": new Date().toISOString(),
          ":previousOrgId": entry.previousOrgId,
        },
      }
    : {
        UpdateExpression: "SET #orgId = :orgId, #updatedAt = :updatedAt",
        names: { "#orgId": "orgId", "#updatedAt": "updatedAt" } as Record<
          string,
          string
        >,
        values: {
          ":orgId": entry.resolvedOrgId,
          ":updatedAt": new Date().toISOString(),
          ":previousOrgId": entry.previousOrgId,
        },
      };

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { [pkName]: entry.id },
        UpdateExpression: ddbFieldsToSet.UpdateExpression,
        ConditionExpression: "#orgId = :previousOrgId",
        ExpressionAttributeNames: ddbFieldsToSet.names,
        ExpressionAttributeValues: ddbFieldsToSet.values,
        ReturnValues: "UPDATED_NEW",
      }),
    );
  } catch (err) {
    const isConditionalCheckFailed =
      err instanceof Error && err.name === "ConditionalCheckFailedException";
    if (!isConditionalCheckFailed) {
      return { error: `DDB write failed: ${String(err)}` };
    }
    // Re-read and treat "already in the desired state" as idempotent
    // success — a concurrent writer (registry-sync, or another run) may
    // have already converged this row to exactly what we were about to
    // write.
    let current;
    try {
      current = await docClient.send(
        new GetCommand({ TableName: tableName, Key: { [pkName]: entry.id } }),
      );
    } catch (readErr) {
      return {
        error: `ConditionalCheckFailedException and re-read failed: ${String(readErr)}`,
      };
    }
    const item = current.Item as Record<string, unknown> | undefined;
    const alreadyDesired = isUnresolvable
      ? item?.orgUnknown === true && item?.orgId === undefined
      : item?.orgId === entry.resolvedOrgId && item?.orgUnknown !== true;
    if (!alreadyDesired) {
      return {
        error:
          "ConditionalCheckFailedException and row is not in the desired state",
      };
    }
  }

  return needsReapproval ? { needsReapproval: true } : {};
}

/**
 * Result of a single `--resync-projection <id>` attempt (or an end-of-run
 * resync pass iteration).
 */
export interface ResyncProjectionResult {
  id: string;
  type: ResourceType;
  wouldRebuild?: boolean;
  alreadyMatches?: boolean;
  rebuilt?: boolean;
  error?: string;
  /** Set when `getResource` failed in a way consistent with the id being
   * the other resource type — lets the caller retry as the other kind. */
  recordNotFoundOrWrongType?: boolean;
}

/**
 * Rebuilds a single DDB projection row from its registry record through
 * registry-sync's OWN mapping/writer module (Required change 2):
 * {@link buildAgentProjectionRow}/{@link buildToolProjectionRow} for the
 * mapping, {@link writeProjectionRow} for the write — the exact same two
 * functions the live registry-sync lambda uses, so the rebuilt row carries
 * identical ordering/version fields (`projectionVersion`, `projectedAt`,
 * `registryStatus`, `statusUpdatedAt`) and is never rejected or regressed
 * by a later live registry-sync event.
 *
 * Dry-run by default (`apply: false`): reads the registry record and
 * reports whether a rebuild would change anything, without writing. No-op
 * when the current DDB row already matches what the mapper would produce
 * (compares `orgId`, `orgUnknown`, `registryStatus`). Never throws —
 * returns `error` on failure so the caller (CLI `--resync-projection` or
 * the end-of-run resync pass) decides on exit code / retry.
 */
export async function resyncProjectionForId(
  id: string,
  type: ResourceType,
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  apply: boolean,
): Promise<ResyncProjectionResult> {
  let record: RegistryRecord | null;
  try {
    record = await registry.getResource(type, id);
  } catch (err) {
    return {
      id,
      type,
      error: `getResource failed: ${String(err)}`,
      recordNotFoundOrWrongType: true,
    };
  }

  if (!record) {
    return {
      id,
      type,
      error: "Record not found (null)",
      recordNotFoundOrWrongType: true,
    };
  }

  const mappedRow =
    type === "agent"
      ? buildAgentProjectionRow(record)
      : buildToolProjectionRow(record);
  const pkName = type === "agent" ? "agentId" : "toolId";

  let current;
  try {
    current = await docClient.send(
      new GetCommand({ TableName: tableName, Key: { [pkName]: id } }),
    );
  } catch (err) {
    return { id, type, error: `DDB read failed: ${String(err)}` };
  }

  const existing = current.Item as Record<string, unknown> | undefined;
  const mapped = mappedRow as unknown as Record<string, unknown>;
  const alreadyMatches =
    existing !== undefined &&
    existing.orgId === mapped.orgId &&
    existing.orgUnknown === mapped.orgUnknown &&
    existing.registryStatus === mapped.registryStatus;

  if (alreadyMatches) {
    log("info", `[resync-projection] id=${id} already matches — no-op`);
    return { id, type, alreadyMatches: true };
  }

  if (!apply) {
    log(
      "info",
      `[resync-projection] PLAN id=${id} type=${type} currentOrgId=${existing?.orgId ?? "<absent>"} currentRegistryStatus=${existing?.registryStatus ?? "<absent>"} -> orgId=${mapped.orgId ?? "<absent>"} orgUnknown=${mapped.orgUnknown ?? false} registryStatus=${mapped.registryStatus}`,
    );
    return { id, type, wouldRebuild: true };
  }

  try {
    await writeProjectionRow(docClient, tableName, type, id, record);
  } catch (err) {
    return { id, type, error: `writeProjectionRow failed: ${String(err)}` };
  }

  return { id, type, rebuilt: true };
}

/**
 * `--resync-projection <id,...>` CLI entry point. Tries each id as an
 * agent first, then a tool, mirroring `--restore-approval`'s wrong-type
 * retry — the caller does not need to know the record's kind up front.
 */
export async function resyncProjectionIds(
  ids: readonly string[],
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  agentTable: string,
  toolTable: string,
  apply: boolean,
): Promise<ResyncProjectionResult[]> {
  const results: ResyncProjectionResult[] = [];
  for (const id of ids) {
    let result = await resyncProjectionForId(
      id,
      "agent",
      registry,
      docClient,
      agentTable,
      apply,
    );
    if (result.error && result.recordNotFoundOrWrongType) {
      result = await resyncProjectionForId(
        id,
        "tool",
        registry,
        docClient,
        toolTable,
        apply,
      );
    }
    results.push(result);
  }
  return results;
}

export interface RestoreApprovalResult {
  recordId: string;
  wouldRestore?: boolean;
  alreadyApproved?: boolean;
  restored?: boolean;
  error?: string;
  /**
   * Set when `getResource` failed in a way consistent with the id simply
   * being the other resource type (agent vs tool) — lets the end-of-run
   * pass retry the other type without treating a type mismatch as a hard
   * failure.
   */
  recordNotFoundOrWrongType?: boolean;
}

/**
 * Restores approval for a single record whose org marker is already
 * correct but whose registry status was left DRAFT by a partial write
 * (the `needsReapproval` signature). Runs the post-update steps in order
 * — waitForStableState happens implicitly inside `submitForApproval` /
 * `updateResourceStatus` on the `RegistryService` side — submitForApproval
 * then, if still PENDING_APPROVAL, decide(APPROVED); verifies the final
 * status is APPROVED before reporting success.
 *
 * Dry-run by default (`apply: false`): prints the plan (what WOULD be
 * restored) without calling any mutating registry operation. No-op for a
 * record that is already APPROVED, in either mode. Never throws — returns
 * `error` on failure so the caller (CLI `--restore-approval` or the
 * end-of-run pass) decides on exit code / retry.
 */
export async function restoreApprovalForRecord(
  recordId: string,
  type: ResourceType,
  registry: RegistryService,
  apply: boolean,
): Promise<RestoreApprovalResult> {
  let record: RegistryRecord | null;
  try {
    record = await registry.getResource(type, recordId);
  } catch (err) {
    return {
      recordId,
      error: `getResource failed: ${String(err)}`,
      recordNotFoundOrWrongType: true,
    };
  }

  if (!record) {
    return {
      recordId,
      error: "Record not found (null)",
      recordNotFoundOrWrongType: true,
    };
  }

  if (record.status === "APPROVED") {
    log(
      "info",
      `[restore-approval] recordId=${recordId} already APPROVED — no-op`,
    );
    return { recordId, alreadyApproved: true };
  }

  if (!apply) {
    log(
      "info",
      `[restore-approval] PLAN recordId=${recordId} currentStatus=${record.status} -> would run submitForApproval -> decide(APPROVED)`,
    );
    return { recordId, wouldRestore: true };
  }

  try {
    const submitted = await registry.submitForApproval(recordId);
    let finalStatus = submitted.status ?? "PENDING_APPROVAL";

    if (finalStatus === "PENDING_APPROVAL") {
      const decided = await registry.updateResourceStatus(
        type,
        recordId,
        RegistryRecordStatusValues.APPROVED,
        "restore-approval: restoring status after partial corrective write",
      );
      finalStatus = decided.status ?? "APPROVED";
    }

    if (finalStatus !== "APPROVED") {
      return {
        recordId,
        error: `Restoration did not reach APPROVED (ended at ${finalStatus})`,
      };
    }

    // Verify by re-fetching — never trust the mutation response alone.
    const verified = await registry.getResource(type, recordId);
    if (!verified || verified.status !== "APPROVED") {
      return {
        recordId,
        error: `Post-restoration verification failed (status=${verified?.status ?? "<null>"})`,
      };
    }

    return { recordId, restored: true };
  } catch (err) {
    return { recordId, error: `Restoration failed: ${String(err)}` };
  }
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
 * Default inter-call pacing (ms) applied between registry calls in apply
 * mode via `--call-delay-ms`, separate from the per-record `--delay-ms`
 * backoff schedule. 0 by default here; `main()` applies the spec's
 * ">= 300 when --apply" floor when the flag is omitted in apply mode.
 */
export const DEFAULT_CALL_DELAY_MS = 0;

/**
 * Spec floor for `--call-delay-ms` when `--apply` is set and the flag is
 * omitted — inter-call pacing between registry calls, separate from the
 * per-record `--delay-ms` retry backoff.
 */
export const MIN_APPLY_CALL_DELAY_MS = 300;

/** Injectable inter-call pacing hook — overridable in tests. */
export type CallPacer = (delayMs: number) => Promise<void>;

export const defaultCallPacer: CallPacer = (delayMs) => sleep(delayMs);

/**
 * Scans one registry resource type for corrective-mode targets, logging the
 * previous value of every planned entry. Refuses (returns an error summary)
 * if the underlying list is partial/throttled — per spec, a throttled or
 * failed read is an error, never a silent partial apply.
 *
 * `limit` bounds the number of records ATTEMPTED (`summary.attempted`) —
 * successes AND failures — never just successes, so a throttled/failed
 * write still consumes the limit (incident: a failure "did not count
 * toward --limit"). A `needsReapproval` outcome from
 * {@link applyCorrectiveEntry} is bucketed into `summary.needsReapproval`
 * and the loop CONTINUES to the next record — it is never treated as an
 * abandon-the-run error.
 *
 * `callDelayMs`/`callPacer` add inter-call pacing between attempted
 * registry writes, separate from the per-record retry backoff in
 * {@link reconcileDroppedRecords}.
 */
export interface NeedsReapprovalEntry {
  id: string;
  type: ResourceType;
}

/**
 * An id flagged `projectionLag: true` by {@link applyCorrectiveEntry} —
 * tracked separately so the end-of-run resync pass (Required change 1)
 * iterates exactly these ids, never the full planned set.
 */
export interface ProjectionLagEntry {
  id: string;
  type: ResourceType;
}

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
  fallbackOrg?: string,
  callDelayMs: number = DEFAULT_CALL_DELAY_MS,
  callPacer: CallPacer = defaultCallPacer,
  needsReapprovalEntries: NeedsReapprovalEntry[] = [],
  projectionLagEntries: ProjectionLagEntry[] = [],
  projectionWaitMs: number = DEFAULT_PROJECTION_WAIT_MS,
  projectionPollIntervalMs: number = DEFAULT_PROJECTION_POLL_INTERVAL_MS,
  projectionClock: Clock = defaultClock,
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
    };

    const entry = planCorrectiveEntry(rec, kind, orgResolver, fallbackOrg);
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
      if (limit !== undefined && summary.attempted >= limit) {
        continue;
      }
      summary.attempted++;
      try {
        const result = await applyCorrectiveEntry(
          entry,
          type,
          registry,
          tableName,
          docClient,
          callDelayMs,
          callPacer,
          projectionWaitMs,
          projectionPollIntervalMs,
          projectionClock,
        );
        if (result.error) {
          log(
            "error",
            `[correct-fabricator:${type}] recordId=${entry.id} write failed: ${result.error}`,
          );
          summary.errors++;
          continue;
        }
        if (result.needsReapproval) {
          summary.needsReapproval++;
          needsReapprovalEntries.push({ id: entry.id, type });
          log(
            "warn",
            `[correct-fabricator:${type}] recordId=${entry.id} org marker updated but approval restoration failed — bucketed into needsReapproval, continuing with next record`,
          );
        }
        if (result.projectionLag) {
          summary.projectionLag++;
          projectionLagEntries.push({ id: entry.id, type });
          log(
            "warn",
            `[correct-fabricator:${type}] recordId=${entry.id} registry write landed but the DDB projection has not converged within the wait window — bucketed into projectionLag, continuing with next record`,
          );
        }
      } catch (err) {
        log(
          "error",
          `[correct-fabricator:${type}] recordId=${entry.id} unexpected write error: ${String(err)}`,
        );
        summary.errors++;
        continue;
      }
      if (entry.reason === "fallback-org") summary.markedFallback++;
      else if (entry.resolvedOrgId !== undefined) summary.markedTenant++;
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
  fallbackOrg?: string,
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
      };

      const entry = planCorrectiveEntry(rec, kind, orgResolver, fallbackOrg);
      if (entry) entries.push(entry);
    }

    exclusiveStartKey = scanResult.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return entries;
}

/**
 * Minimal shape of an agent record needed to contribute to the
 * toolName -> org index (see {@link buildToolNameOrgIndex}). `config` is
 * the agent's raw config as persisted — in live DDB rows this is most
 * often a MAP (plain object), occasionally a JSON STRING, occasionally
 * absent. Both shapes are accepted and normalised once; missing/unparsable
 * config is tolerated (logged once by the caller if desired, contributes
 * nothing here). `manifest` is the agent's manifest object; only a
 * non-empty `tools[]` array on it contributes.
 */
export interface AgentConfigLike {
  name?: string;
  orgId?: string;
  orgUnknown?: boolean;
  createdBy?: string;
  sourceProjectId?: string;
  config?: string | Record<string, unknown>;
  manifest?: Record<string, unknown>;
}

/**
 * Normalises an agent's raw `config` (object/map OR JSON string) into a
 * parsed object, or `undefined` if absent/unparsable. Never throws.
 */
function normalizeAgentConfig(
  config: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (config === undefined) return undefined;
  if (typeof config === "object" && config !== null) return config;
  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Builds, ONCE per run, the toolName -> set(resolved org) index that
 * backs the NAME-based tool->agent binding (option A). `config` is
 * accepted as either an object/map (live DDB rows are mostly maps) or a
 * JSON string; both are normalised via {@link normalizeAgentConfig}. For
 * every agent:
 *   - a seed-name (SEED_ALLOWLIST_NAMES) or orgUnknown agent contributes
 *     nothing (no positive org signal to propagate to a tool).
 *   - an agent with an explicit, real tenant `orgId` (not ALL_ORGS, not
 *     blank) contributes that org directly.
 *   - an agent currently stamped ALL_ORGS that is itself a corrective
 *     target (createdBy fabricator, non-seed-name — see
 *     {@link isCorrectiveTarget}) contributes its RESOLVED org via
 *     `resolveAgentOrg`/`sourceProjectId`, never its current ALL_ORGS
 *     value; if unresolvable it contributes nothing.
 *   - any other blank/absent-orgId agent resolves its org via
 *     `sourceProjectId` through `resolveAgentOrg` (typically projectId ->
 *     projects table -> organization); if unresolvable, it contributes
 *     nothing.
 * For every contributing agent, every tool name in its parsed
 * `config.schema.tools[]` plus every tool name in a non-empty
 * `manifest.tools[]` gets that agent's resolved org added to its set.
 * Agents whose `config` is missing/unparsable, or that have no
 * `schema.tools`/`manifest.tools` at all, are logged once (by the caller
 * if desired) and simply contribute nothing — never throws.
 */
export function buildToolNameOrgIndex(
  agents: readonly AgentConfigLike[],
  resolveAgentOrg: (rec: RecordShape) => string | undefined,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  const addToolNames = (names: readonly string[], org: string): void => {
    for (const toolName of names) {
      if (typeof toolName !== "string" || toolName === "") continue;
      let orgs = index.get(toolName);
      if (!orgs) {
        orgs = new Set<string>();
        index.set(toolName, orgs);
      }
      orgs.add(org);
    }
  };

  for (const agent of agents) {
    // Seed-name / orgUnknown agents contribute nothing.
    if (agent.orgUnknown === true) continue;
    if (agent.name !== undefined && SEED_ALLOWLIST_NAMES.includes(agent.name))
      continue;

    let org: string | undefined;
    if (
      agent.orgId !== undefined &&
      agent.orgId !== "" &&
      agent.orgId !== ALL_ORGS
    ) {
      // Explicit, real tenant orgId — use it directly.
      org = agent.orgId;
    } else if (
      agent.orgId === ALL_ORGS &&
      !(
        agent.createdBy === "fabricator" &&
        (agent.name === undefined || !SEED_ALLOWLIST_NAMES.includes(agent.name))
      )
    ) {
      // ALL_ORGS but not itself a fabricator corrective target (e.g. a
      // genuine platform-shared record via createdBy allowlist) —
      // contributes nothing; its current value is not a tenant org.
      continue;
    } else {
      // Either blank/absent orgId, or an ALL_ORGS fabricator corrective
      // target — resolve the RESOLVED org via sourceProjectId, never the
      // current ALL_ORGS value.
      org = resolveAgentOrg({
        id: "",
        sourceProjectId: agent.sourceProjectId,
      });
    }
    if (org === undefined) continue;

    const parsedConfig = normalizeAgentConfig(agent.config);
    let schemaTools: unknown;
    if (parsedConfig !== undefined) {
      const schema = parsedConfig.schema;
      schemaTools =
        schema !== null && typeof schema === "object"
          ? (schema as Record<string, unknown>).tools
          : undefined;
    }
    if (Array.isArray(schemaTools)) {
      addToolNames(schemaTools as string[], org);
    }

    const manifestTools = agent.manifest?.tools;
    if (Array.isArray(manifestTools) && manifestTools.length > 0) {
      addToolNames(manifestTools as string[], org);
    }
  }

  return index;
}

/**
 * Resolves a tool's org from the pre-built toolName -> set(org) index.
 * Seed-name tools are never targeted (no-op even if the index somehow
 * contains an entry for one). Returns the single org, `"AMBIGUOUS"` for
 * more than one distinct org, or `undefined` when the name has no entry.
 */
function resolveToolOrgFromIndex(
  rec: RecordShape,
  toolNameOrgIndex: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (rec.name === undefined) return undefined;
  if (SEED_ALLOWLIST_NAMES.includes(rec.name)) return undefined;

  const orgs = toolNameOrgIndex.get(rec.name);
  if (!orgs || orgs.size === 0) return undefined;
  if (orgs.size > 1) return "AMBIGUOUS";
  return [...orgs][0];
}

/**
 * Builds a synchronous {@link OrgResolver} from pre-fetched lookup data.
 * Corrective mode fetches projects and the toolName -> org index ONCE up
 * front (one projects-table scan, one agent-table scan feeding
 * {@link buildToolNameOrgIndex}) so the resolver itself stays a pure,
 * synchronous function — matching the `OrgResolver` contract and keeping
 * `classifyRecord`/`planCorrectiveEntry` free of I/O.
 *
 * `projectOrgById` — projectId -> organization (projects table).
 * `toolNameOrgIndex` — toolName -> set(resolved org), built by
 *   {@link buildToolNameOrgIndex} from every known agent's
 *   `config.schema.tools[]` / non-empty `manifest.tools[]`.
 */
export function buildOrgResolverFromMaps(
  projectOrgById: ReadonlyMap<string, string>,
  toolNameOrgIndex: ReadonlyMap<string, ReadonlySet<string>>,
): OrgResolver {
  return {
    resolveAgentOrg: (rec: RecordShape) => {
      if (rec.sourceProjectId === undefined) return undefined;
      return projectOrgById.get(rec.sourceProjectId);
    },
    resolveToolOrg: (rec: RecordShape) =>
      resolveToolOrgFromIndex(rec, toolNameOrgIndex),
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

  const fallbackOrgIdx = args.indexOf("--fallback-org");
  const fallbackOrg =
    fallbackOrgIdx !== -1 && args[fallbackOrgIdx + 1] !== undefined
      ? args[fallbackOrgIdx + 1]
      : undefined;
  if (fallbackOrgIdx !== -1 && fallbackOrg === undefined) {
    throw new Error("--fallback-org requires a value");
  }

  const callDelayMsIdx = args.indexOf("--call-delay-ms");
  const callDelayMsRaw =
    callDelayMsIdx !== -1 && args[callDelayMsIdx + 1] !== undefined
      ? args[callDelayMsIdx + 1]
      : undefined;
  if (callDelayMsRaw !== undefined && !/^\d+$/.test(callDelayMsRaw)) {
    throw new Error(
      `--call-delay-ms must be a non-negative integer, got "${callDelayMsRaw}"`,
    );
  }
  // Spec default: >= 300ms inter-call pacing when --apply is set and the
  // flag is omitted; 0 (off) in dry-run, where no registry writes happen.
  const callDelayMs =
    callDelayMsRaw !== undefined
      ? Number(callDelayMsRaw)
      : apply
        ? MIN_APPLY_CALL_DELAY_MS
        : DEFAULT_CALL_DELAY_MS;

  const restoreApprovalIdx = args.indexOf("--restore-approval");
  const restoreApprovalRaw =
    restoreApprovalIdx !== -1 && args[restoreApprovalIdx + 1] !== undefined
      ? args[restoreApprovalIdx + 1]
      : undefined;
  if (restoreApprovalIdx !== -1 && restoreApprovalRaw === undefined) {
    throw new Error("--restore-approval requires a comma-separated id list");
  }
  const restoreApprovalIds = restoreApprovalRaw
    ? restoreApprovalRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  const resyncProjectionIdx = args.indexOf("--resync-projection");
  const resyncProjectionRaw =
    resyncProjectionIdx !== -1 && args[resyncProjectionIdx + 1] !== undefined
      ? args[resyncProjectionIdx + 1]
      : undefined;
  if (resyncProjectionIdx !== -1 && resyncProjectionRaw === undefined) {
    throw new Error("--resync-projection requires a comma-separated id list");
  }
  const resyncProjectionIdsArg = resyncProjectionRaw
    ? resyncProjectionRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
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
  if (fallbackOrg !== undefined && !correctFabricatorShared) {
    throw new Error(
      "--fallback-org is only valid together with --correct-fabricator-shared",
    );
  }
  if (restoreApprovalIds !== undefined && !correctFabricatorShared) {
    throw new Error(
      "--restore-approval is only valid together with --correct-fabricator-shared",
    );
  }
  if (resyncProjectionIdsArg !== undefined && !correctFabricatorShared) {
    throw new Error(
      "--resync-projection is only valid together with --correct-fabricator-shared",
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

  if (resyncProjectionIdsArg !== undefined) {
    log(
      "info",
      `--resync-projection: ${dryRun ? "DRY-RUN" : "APPLY"} for id(s)=${resyncProjectionIdsArg.join(",")}`,
    );
    const results = await resyncProjectionIds(
      resyncProjectionIdsArg,
      registry,
      docClient,
      agentTable,
      toolTable,
      apply,
    );
    let anyFailed = false;
    for (const result of results) {
      if (result.error) {
        log(
          "error",
          `--resync-projection id=${result.id} failed: ${result.error}`,
        );
        anyFailed = true;
      } else if (result.wouldRebuild) {
        log(
          "info",
          `--resync-projection id=${result.id}: plan printed above (dry-run)`,
        );
      } else if (result.alreadyMatches) {
        log(
          "info",
          `--resync-projection id=${result.id}: already matches, no-op`,
        );
      } else if (result.rebuilt) {
        log("info", `--resync-projection id=${result.id}: rebuilt`);
      }
    }
    if (anyFailed) {
      process.exit(1);
    }
    return;
  }

  if (restoreApprovalIds !== undefined) {
    log(
      "info",
      `--restore-approval: ${dryRun ? "DRY-RUN" : "APPLY"} for id(s)=${restoreApprovalIds.join(",")}`,
    );
    let anyFailed = false;
    for (const id of restoreApprovalIds) {
      // Try agent first, then tool — a wrong-type getResource failure on
      // the agent attempt is retried as a tool before giving up, since
      // the CLI does not require the caller to know the record's kind.
      let result = await restoreApprovalForRecord(id, "agent", registry, apply);
      if (result.error && result.recordNotFoundOrWrongType) {
        result = await restoreApprovalForRecord(id, "tool", registry, apply);
      }
      if (result.error) {
        log("error", `--restore-approval id=${id} failed: ${result.error}`);
        anyFailed = true;
      } else if (result.wouldRestore) {
        log(
          "info",
          `--restore-approval id=${id}: plan printed above (dry-run)`,
        );
      } else if (result.alreadyApproved) {
        log("info", `--restore-approval id=${id}: already APPROVED, no-op`);
      } else if (result.restored) {
        log("info", `--restore-approval id=${id}: restored to APPROVED`);
      }
    }
    if (anyFailed) {
      process.exit(1);
    }
    return;
  }

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
      fallbackOrg,
      callDelayMs,
      defaultCallPacer,
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
 * table (building the toolName -> org index via
 * {@link buildToolNameOrgIndex}) once, and builds a synchronous
 * {@link OrgResolver} from the resulting maps via
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

  const resolveAgentOrgViaProjects = (rec: RecordShape): string | undefined => {
    if (rec.sourceProjectId === undefined) return undefined;
    return projectOrgById.get(rec.sourceProjectId);
  };

  const agentsForToolIndex: AgentConfigLike[] = [];
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
        agentsForToolIndex.push({
          name: typeof item.name === "string" ? item.name : undefined,
          orgId: typeof item.orgId === "string" ? item.orgId : undefined,
          orgUnknown: item.orgUnknown === true,
          createdBy:
            typeof item.createdBy === "string" ? item.createdBy : undefined,
          sourceProjectId:
            typeof item.sourceProjectId === "string"
              ? item.sourceProjectId
              : undefined,
          config:
            typeof item.config === "string" ||
            (item.config !== null && typeof item.config === "object")
              ? (item.config as string | Record<string, unknown>)
              : undefined,
          manifest:
            item.manifest !== null && typeof item.manifest === "object"
              ? (item.manifest as Record<string, unknown>)
              : undefined,
        });
      }
      exclusiveStartKey = scanResult.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  const toolNameOrgIndex = buildToolNameOrgIndex(
    agentsForToolIndex,
    resolveAgentOrgViaProjects,
  );

  return buildOrgResolverFromMaps(projectOrgById, toolNameOrgIndex);
}

/**
 * Same as {@link buildOrgResolverFromTables}, but also returns the set of
 * distinct `organization` values observed in the projects table — used to
 * validate an owner-supplied `--fallback-org` against organisations that
 * actually exist before any corrective write is planned or applied.
 */
export async function buildOrgResolverFromTablesWithKnownOrgs(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  agentTable: string,
): Promise<{ orgResolver: OrgResolver; knownOrgs: ReadonlySet<string> }> {
  const knownOrgs = new Set<string>();
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
        if (typeof item.organization === "string") {
          knownOrgs.add(item.organization);
        }
      }
      exclusiveStartKey = scanResult.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  const orgResolver = await buildOrgResolverFromTables(
    docClient,
    projectsTable,
    agentTable,
  );

  return { orgResolver, knownOrgs };
}

/**
 * Corrective-mode entry point. Pre-fetches the projects table (projectId ->
 * organization) and the agents table (building the toolName -> org index)
 * once, builds a synchronous OrgResolver from those maps, then scans the
 * agent and tool registries for ALL_ORGS+fabricator+non-seed-name records
 * and re-stamps BOTH the registry descriptor and the DynamoDB projection
 * row for each resolvable one. Dry-run by default; `--record-id` scopes to
 * a single canary record; `--limit` bounds how many records get WRITTEN in
 * apply mode (the plan/print phase is never bounded).
 *
 * `fallbackOrg`, when supplied, must name an organisation that actually
 * exists among the projects table's distinct `organization` values — if
 * it does not, this function logs an error and exits non-zero (`process.exit(1)`)
 * BEFORE any write. When valid, it is applied only to records that are
 * createdBy fabricator, non-seed-name, and otherwise unresolvable (reason
 * `fallback-org`); it never overrides an ambiguous, seed, non-fabricator,
 * or normally-resolvable record. The dry run always prints the complete
 * list of records that would receive the fallback.
 */
export async function runCorrectiveMode(
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  agentTable: string,
  toolTable: string,
  projectsTable: string,
  apply: boolean,
  limit: number | undefined,
  recordId: string | undefined,
  delayMs: number = CORRECTIVE_RECORD_RETRY_BASE_DELAY_MS,
  fallbackOrg?: string,
  callDelayMs: number = DEFAULT_CALL_DELAY_MS,
  callPacer: CallPacer = defaultCallPacer,
  projectionWaitMs: number = DEFAULT_PROJECTION_WAIT_MS,
  projectionPollIntervalMs: number = DEFAULT_PROJECTION_POLL_INTERVAL_MS,
  projectionClock: Clock = defaultClock,
): Promise<void> {
  log("info", `Corrective mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (recordId) log("info", `Scoped to single record id=${recordId} (canary)`);
  if (fallbackOrg) log("info", `Fallback org configured: ${fallbackOrg}`);

  let orgResolver: OrgResolver;
  let knownOrgs: ReadonlySet<string>;
  try {
    const built = await buildOrgResolverFromTablesWithKnownOrgs(
      docClient,
      projectsTable,
      agentTable,
    );
    orgResolver = built.orgResolver;
    knownOrgs = built.knownOrgs;
  } catch (err) {
    log("error", String(err));
    process.exit(1);
    return;
  }

  if (fallbackOrg !== undefined && !knownOrgs.has(fallbackOrg)) {
    log(
      "error",
      `--fallback-org "${fallbackOrg}" does not match any organisation found in the projects table — refusing to proceed. Known organisations: ${[...knownOrgs].join(", ") || "<none>"}`,
    );
    process.exit(1);
    return;
  }

  const summary = emptySummary();
  const fullPlan: CorrectivePlanEntry[] = [];
  // Flagged exactly where `summary.needsReapproval` is incremented (three
  // sites: the registry-sourced loop inside runCorrectiveForRegistryType,
  // called twice below, and the DDB-only loop further down). The
  // end-of-run re-approval pass iterates THIS list, never `fullPlan` —
  // `fullPlan` is every planned target, most of which are never attempted
  // under --limit and must not be touched by the re-approval pass.
  const needsReapprovalEntries: NeedsReapprovalEntry[] = [];
  // Flagged exactly where `summary.projectionLag` is incremented, by the
  // registry-sourced loop inside runCorrectiveForRegistryType (called
  // twice below). The end-of-run resync pass (Required change 1 + 2)
  // iterates THIS list, never `fullPlan`.
  const projectionLagEntries: ProjectionLagEntry[] = [];

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
    undefined,
    fallbackOrg,
    callDelayMs,
    callPacer,
    needsReapprovalEntries,
    projectionLagEntries,
    projectionWaitMs,
    projectionPollIntervalMs,
    projectionClock,
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
    undefined,
    fallbackOrg,
    callDelayMs,
    callPacer,
    needsReapprovalEntries,
    projectionLagEntries,
    projectionWaitMs,
    projectionPollIntervalMs,
    projectionClock,
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
    fallbackOrg,
  );
  const toolDdbOnlyPlan = await findDdbOnlyCorrectiveTargets(
    "tool",
    toolTable,
    docClient,
    orgResolver,
    registryPlannedIds,
    fallbackOrg,
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
    if (limit !== undefined && summary.attempted >= limit) {
      continue;
    }
    summary.attempted++;

    try {
      const type: ResourceType = entry.kind === "agent" ? "agent" : "tool";
      const tableName = entry.kind === "agent" ? agentTable : toolTable;
      const result = await applyDdbOnlyCorrectiveEntry(
        entry,
        type,
        registry,
        tableName,
        docClient,
        callDelayMs,
        callPacer,
      );
      if (result.error) {
        log(
          "error",
          `[correct-fabricator:ddb-only:${entry.kind}] recordId=${entry.id} write failed: ${result.error}`,
        );
        summary.errors++;
        continue;
      }
      if (result.needsReapproval) {
        summary.needsReapproval++;
        needsReapprovalEntries.push({
          id: entry.id,
          type: entry.kind === "agent" ? "agent" : "tool",
        });
        log(
          "warn",
          `[correct-fabricator:ddb-only:${entry.kind}] recordId=${entry.id} org marker updated but approval restoration failed — bucketed into needsReapproval, continuing with next record`,
        );
      }
    } catch (err) {
      log(
        "error",
        `[correct-fabricator:ddb-only:${entry.kind}] recordId=${entry.id} unexpected write error: ${String(err)}`,
      );
      summary.errors++;
      continue;
    }
    if (entry.reason === "fallback-org") summary.markedFallback++;
    else if (entry.resolvedOrgId !== undefined) summary.markedTenant++;
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

  const fallbackEntries = fullPlan.filter((e) => e.reason === "fallback-org");
  if (fallbackOrg !== undefined) {
    log(
      "info",
      `--- Fallback-org candidates (reason=fallback-org, target org=${fallbackOrg}) ---`,
    );
    for (const entry of fallbackEntries) {
      log(
        "info",
        `FALLBACK id=${entry.id} kind=${entry.kind} name=${entry.name ?? "<none>"} reason=${entry.reason}`,
      );
    }
    log("info", `fallbackCandidateCount: ${fallbackEntries.length}`);
  }

  log("info", "--- Corrective mode summary ---");
  log("info", `mode:              ${apply ? "apply" : "dry-run"}`);
  log("info", `scanned:           ${summary.scanned}`);
  log("info", `plannedTotal:      ${fullPlan.length}`);
  log("info", `markedTenant:      ${summary.markedTenant}`);
  log("info", `markedUnknown:     ${summary.markedUnknown}`);
  log("info", `markedFallback:    ${summary.markedFallback}`);
  log("info", `ambiguousReported: ${summary.ambiguousReported}`);
  log("info", `needsReapproval:   ${summary.needsReapproval}`);
  log("info", `projectionLag:     ${summary.projectionLag}`);
  log("info", `errors:            ${summary.errors}`);

  // End-of-run re-approval pass: records whose org marker was written but
  // whose registry status was left DRAFT by a throttled approval-
  // restoration step get ONE more attempt here, in the same run, before
  // the operator has to invoke --restore-approval separately. Only in
  // apply mode — a dry run has nothing to restore. Iterates
  // `needsReapprovalEntries` — the ids flagged exactly at the
  // `summary.needsReapproval++` sites above — never `fullPlan`, which
  // holds every planned target regardless of whether it was ever
  // attempted under --limit.
  if (apply && summary.needsReapproval > 0) {
    log(
      "info",
      `--- End-of-run re-approval pass (${summary.needsReapproval} record(s) flagged needsReapproval) ---`,
    );
    let stillNeedsReapproval = 0;
    for (const { id, type: flaggedType } of needsReapprovalEntries) {
      const restoreResult = await restoreApprovalForRecord(
        id,
        flaggedType,
        registry,
        true,
      );
      if (restoreResult.restored) {
        log("info", `[restore-approval] id=${id} restored to APPROVED`);
      } else if (restoreResult.alreadyApproved) {
        // Already fine — nothing to do.
      } else {
        stillNeedsReapproval++;
        log(
          "error",
          `[restore-approval] id=${id} still not APPROVED after end-of-run pass: ${restoreResult.error ?? "unknown"}`,
        );
      }
    }
    summary.needsReapproval = stillNeedsReapproval;
    log(
      "info",
      `--- End-of-run re-approval pass complete: ${stillNeedsReapproval} still needsReapproval ---`,
    );
  }

  // End-of-run resync pass (Required change 1 + 2): ids flagged
  // `projectionLag` get ONE more attempt here to rebuild their DDB
  // projection row through registry-sync's own mapper/writer
  // ({@link resyncProjectionForId}), in the same run, before the operator
  // has to invoke `--resync-projection` separately. Only in apply mode.
  // Iterates `projectionLagEntries` — the ids flagged exactly at the
  // `summary.projectionLag++` site in runCorrectiveForRegistryType — never
  // `fullPlan`. Only an id STILL unconverged after this pass counts toward
  // a non-zero exit (per Required change 1/4).
  if (apply && summary.projectionLag > 0) {
    log(
      "info",
      `--- End-of-run resync pass (${summary.projectionLag} record(s) flagged projectionLag) ---`,
    );
    let stillProjectionLag = 0;
    for (const { id, type: flaggedType } of projectionLagEntries) {
      const tableName = flaggedType === "agent" ? agentTable : toolTable;
      const resyncResult = await resyncProjectionForId(
        id,
        flaggedType,
        registry,
        docClient,
        tableName,
        true,
      );
      if (resyncResult.rebuilt || resyncResult.alreadyMatches) {
        log("info", `[resync-projection] id=${id} converged`);
      } else {
        stillProjectionLag++;
        log(
          "error",
          `[resync-projection] id=${id} still not converged after end-of-run pass: ${resyncResult.error ?? "unknown"}`,
        );
      }
    }
    summary.projectionLag = stillProjectionLag;
    log(
      "info",
      `--- End-of-run resync pass complete: ${stillProjectionLag} still projectionLag ---`,
    );
  }

  // Exit code counts only real errors: `errors` (pre-write/genuine write
  // failures) and any id still outstanding in `needsReapproval` /
  // `projectionLag` AFTER their respective end-of-run passes have each
  // had one more attempt. `--limit` already counts attempts above,
  // independent of this exit-code gate.
  if (
    summary.errors > 0 ||
    summary.needsReapproval > 0 ||
    summary.projectionLag > 0
  ) {
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
