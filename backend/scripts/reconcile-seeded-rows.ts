/**
 * One-off reconcile: collapses twin DDB rows for seeded agents into
 * a canonical recordId-keyed row + thin name-keyed pointer, copies S3
 * modules to scoped keys, and rewrites blueprint definitions to
 * reference agents by recordId instead of friendly name.
 *
 * The orgId 'Default' → 'system' rewrite applies ONLY to seeded
 * blueprints (identified via SEEDED_BLUEPRINT_IDS from seed-blueprints).
 * User-created blueprints are never touched by the org rewrite.
 *
 * Seeded agents are identified by `createdBy = 'seedConfig'` on the
 * recordId-keyed row. Alternatively, pass `--names` to provide an
 * explicit list.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/reconcile-seeded-rows.ts \
 *     --table <AGENT_CONFIG_TABLE> --workflows-table <WORKFLOWS_TABLE> \
 *     --bucket <AGENT_BUCKET_NAME> [--dry-run] [--apply] \
 *     [--org-sentinel 'All Organizations'] [--names demo-echo-agent,fabricator] \
 *     [--revert-nonseeded-org <org>]
 *
 * --dry-run (default): scans and reports planned changes; no writes.
 * --apply: performs the corrective writes. Idempotent — safe to re-run.
 * --revert-nonseeded-org <org>: for blueprints NOT in the seeded set whose
 *   orgId is currently 'system', set orgId to <org>. Dry-run default.
 *   Idempotent. Prints each affected row.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  REGISTRY_STATUS_FIELD,
  REGISTRY_RECORD_ID_FIELD,
} from "../src/lambda/approval-cache-fields";
import { SEEDED_BLUEPRINT_IDS } from "../src/lambda/seed-blueprints";

// ---------------------------------------------------------------------------
// Types (exported for tests)
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  scanned: number;
  twinsFound: number;
  twinsCollapsed: number;
  s3Copies: number;
  blueprintsRewritten: number;
  blueprintsReverted: number;
  conflicts: number;
  errors: number;
}

export interface TwinPair {
  agentName: string;
  recordId: string;
  nameRow: Record<string, NativeAttributeValue>;
  recordIdRow: Record<string, NativeAttributeValue>;
}

export interface PlannedChange {
  type: "collapse-twin" | "s3-copy" | "blueprint-rewrite";
  key: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECORD_ID_SHAPE = /^[A-Za-z0-9]{12}$/;
const DEFAULT_ORG_SENTINEL = "All Organizations";
const BLUEPRINT_ORG_ID = "system";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[reconcile-seeded-rows] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Arg parsing (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  table: string;
  workflowsTable: string;
  bucket: string;
  dryRun: boolean;
  orgSentinel: string;
  names: string[] | null;
  revertNonseededOrg: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let table: string | undefined;
  let workflowsTable: string | undefined;
  let bucket: string | undefined;
  let dryRun = true;
  let orgSentinel = DEFAULT_ORG_SENTINEL;
  let names: string[] | null = null;
  let revertNonseededOrg: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--table") {
      table = argv[++i];
    } else if (arg === "--workflows-table") {
      workflowsTable = argv[++i];
    } else if (arg === "--bucket") {
      bucket = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      dryRun = false;
    } else if (arg === "--org-sentinel") {
      orgSentinel = argv[++i];
    } else if (arg === "--names") {
      names = argv[++i].split(",").map((n) => n.trim());
    } else if (arg === "--revert-nonseeded-org") {
      revertNonseededOrg = argv[++i];
    }
  }

  if (!table) throw new Error("--table <agents table> is required");
  if (!workflowsTable)
    throw new Error("--workflows-table <workflows table> is required");
  if (!bucket) throw new Error("--bucket <agent bucket> is required");
  return {
    table,
    workflowsTable,
    bucket,
    dryRun,
    orgSentinel,
    names,
    revertNonseededOrg,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns true when the row is a recordId-keyed row written by the seeder.
 */
export function isSeederOwnedRecordIdRow(
  item: Record<string, NativeAttributeValue>,
): boolean {
  return (
    item.createdBy === "seedConfig" &&
    RECORD_ID_SHAPE.test(String(item.agentId ?? ""))
  );
}

/**
 * Returns true when the row is a name-keyed row (agentId is NOT a 12-char
 * recordId) that has a registryRecordId pointing elsewhere.
 */
export function isNameKeyedRow(
  item: Record<string, NativeAttributeValue>,
): boolean {
  const agentId = String(item.agentId ?? "");
  const recordId = item[REGISTRY_RECORD_ID_FIELD];
  if (!recordId || typeof recordId !== "string") return false;
  if (agentId === recordId) return false;
  return !RECORD_ID_SHAPE.test(agentId);
}

/**
 * Detects conflicts: two full rows with disagreeing config content that
 * cannot be safely auto-merged.
 */
export function detectConflict(
  nameRow: Record<string, NativeAttributeValue>,
  recordIdRow: Record<string, NativeAttributeValue>,
): string | null {
  const nameConfig = nameRow.config;
  const recordIdConfig = recordIdRow.config;

  // If the recordId row already has a full config MAP with filename, and
  // the name row also has a different config — potential conflict.
  if (
    nameConfig &&
    typeof nameConfig === "object" &&
    recordIdConfig &&
    typeof recordIdConfig === "object" &&
    (nameConfig as Record<string, unknown>).filename &&
    (recordIdConfig as Record<string, unknown>).filename &&
    (nameConfig as Record<string, unknown>).filename !==
      (recordIdConfig as Record<string, unknown>).filename
  ) {
    return (
      `Conflicting config.filename: name-keyed has ` +
      `"${(nameConfig as Record<string, unknown>).filename}", ` +
      `recordId-keyed has "${(recordIdConfig as Record<string, unknown>).filename}"`
    );
  }
  return null;
}

/**
 * Builds the canonical recordId-keyed row by merging the richer data from
 * the name-keyed row's config into the recordId-keyed row's projection
 * fields.
 */
export function buildCanonicalRow(
  pair: TwinPair,
  orgSentinel: string,
): Record<string, NativeAttributeValue> {
  const { nameRow, recordIdRow, recordId, agentName } = pair;
  const now = new Date().toISOString();

  // Prefer the name-keyed row's config (it has the full MAP with filename,
  // schema, action). Fall back to recordId row's config if name row's is
  // empty/absent.
  const nameConfig = nameRow.config;
  const config =
    nameConfig &&
    typeof nameConfig === "object" &&
    Object.keys(nameConfig).length > 0
      ? nameConfig
      : (recordIdRow.config ?? {});

  const canonical: Record<string, NativeAttributeValue> = {
    agentId: recordId,
    name: agentName,
    config,
    state:
      (recordIdRow.state as string) ?? (nameRow.state as string) ?? "active",
    categories: recordIdRow.categories ?? nameRow.categories ?? [],
    citadelKind: "agent",
    projectionVersion: 1,
    projectedAt: (recordIdRow.projectedAt as string) ?? now,
    orgId: orgSentinel,
    createdBy: "seedConfig",
    icon: (recordIdRow.icon as string) ?? "",
    description:
      (recordIdRow.description as string) ??
      (typeof config === "object"
        ? (config as Record<string, unknown>).description
        : "") ??
      "",
    [REGISTRY_STATUS_FIELD]:
      (recordIdRow[REGISTRY_STATUS_FIELD] as string) ??
      (nameRow[REGISTRY_STATUS_FIELD] as string) ??
      "APPROVED",
    [REGISTRY_RECORD_ID_FIELD]: recordId,
  };

  if (recordIdRow.manifest) {
    canonical.manifest = recordIdRow.manifest;
  }
  if (recordIdRow.createdAt) {
    canonical.createdAt = recordIdRow.createdAt;
  } else if (nameRow.createdAt) {
    canonical.createdAt = nameRow.createdAt;
  }

  return canonical;
}

/**
 * Builds the thin name-keyed pointer row.
 */
export function buildPointerRow(
  pair: TwinPair,
  orgSentinel: string,
): Record<string, NativeAttributeValue> {
  const { nameRow, recordIdRow, recordId, agentName } = pair;
  return {
    agentId: agentName,
    _canonicalRecordId: recordId,
    state: (nameRow.state as string) ?? "active",
    orgId: orgSentinel,
    [REGISTRY_STATUS_FIELD]:
      (recordIdRow[REGISTRY_STATUS_FIELD] as string) ??
      (nameRow[REGISTRY_STATUS_FIELD] as string) ??
      "APPROVED",
    [REGISTRY_RECORD_ID_FIELD]: recordId,
  };
}

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  table: string;
  workflowsTable: string;
  bucket: string;
  dryRun: boolean;
  orgSentinel: string;
  names: string[] | null;
  revertNonseededOrg: string | null;
  docClient: DynamoDBDocumentClient;
  s3Client: S3Client;
}

export async function runReconcile(
  opts: ReconcileOptions,
): Promise<{ summary: ReconcileSummary; planned: PlannedChange[] }> {
  const {
    table,
    workflowsTable,
    bucket,
    dryRun,
    orgSentinel,
    names,
    docClient,
    s3Client,
  } = opts;

  const summary: ReconcileSummary = {
    scanned: 0,
    twinsFound: 0,
    twinsCollapsed: 0,
    s3Copies: 0,
    blueprintsRewritten: 0,
    blueprintsReverted: 0,
    conflicts: 0,
    errors: 0,
  };

  const planned: PlannedChange[] = [];

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"} table=${table}`);

  // Step 1: Scan agent config table and group by registryRecordId
  const allRows: Record<string, NativeAttributeValue>[] = [];
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    let page;
    try {
      page = await docClient.send(
        new ScanCommand({
          TableName: table,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      log("error", `Scan failed: ${String(err)}`);
      summary.errors++;
      return { summary, planned };
    }
    for (const item of page.Items ?? []) {
      summary.scanned++;
      allRows.push(item);
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  log("info", `Scanned ${summary.scanned} rows from ${table}`);

  // Group into twin pairs by registryRecordId
  const nameRowsByRecordId = new Map<
    string,
    Record<string, NativeAttributeValue>
  >();
  const recordIdRows = new Map<string, Record<string, NativeAttributeValue>>();

  for (const item of allRows) {
    const agentId = String(item.agentId ?? "");
    const regRecordId = item[REGISTRY_RECORD_ID_FIELD] as string | undefined;

    if (isSeederOwnedRecordIdRow(item)) {
      recordIdRows.set(agentId, item);
    } else if (isNameKeyedRow(item) && regRecordId) {
      nameRowsByRecordId.set(regRecordId, item);
    }
  }

  // Build twin pairs
  const twins: TwinPair[] = [];
  for (const [recordId, recordIdRow] of recordIdRows) {
    const nameRow = nameRowsByRecordId.get(recordId);
    if (!nameRow) continue;

    const agentName = String(nameRow.agentId ?? "");

    // Filter by --names if provided
    if (names && !names.includes(agentName)) continue;

    twins.push({ agentName, recordId, nameRow, recordIdRow });
  }

  summary.twinsFound = twins.length;
  log("info", `Found ${twins.length} twin pairs to reconcile`);

  // Also check for name-only rows whose canonical recordId row is NOT
  // seeder-owned (e.g. was written by registry-sync) — still a valid
  // twin if the name row has createdBy=seedConfig or matches the names list.
  for (const [regRecordId, nameRow] of nameRowsByRecordId) {
    if (recordIdRows.has(regRecordId)) continue; // already paired above

    const agentName = String(nameRow.agentId ?? "");
    if (names && !names.includes(agentName)) continue;

    // Check if there's a recordId-keyed row that's NOT seeder-owned
    const nonSeederRecordIdRow = allRows.find(
      (r) =>
        String(r.agentId ?? "") === regRecordId &&
        RECORD_ID_SHAPE.test(regRecordId),
    );
    if (nonSeederRecordIdRow) {
      twins.push({
        agentName,
        recordId: regRecordId,
        nameRow,
        recordIdRow: nonSeederRecordIdRow,
      });
      summary.twinsFound++;
    }
  }

  // Name→recordId mapping for blueprint rewrite
  const nameToRecordId = new Map<string, string>();

  // Step 2: Collapse each twin pair
  for (const pair of twins) {
    const conflict = detectConflict(pair.nameRow, pair.recordIdRow);
    if (conflict) {
      log(
        "warn",
        `CONFLICT for ${pair.agentName} (${pair.recordId}): ${conflict} — SKIPPING`,
      );
      summary.conflicts++;
      continue;
    }

    nameToRecordId.set(pair.agentName, pair.recordId);

    const canonical = buildCanonicalRow(pair, orgSentinel);
    const pointer = buildPointerRow(pair, orgSentinel);

    planned.push({
      type: "collapse-twin",
      key: `canonical:${pair.recordId}`,
      before: { ...(pair.recordIdRow as Record<string, unknown>) },
      after: canonical as Record<string, unknown>,
    });
    planned.push({
      type: "collapse-twin",
      key: `pointer:${pair.agentName}`,
      before: { ...(pair.nameRow as Record<string, unknown>) },
      after: pointer as Record<string, unknown>,
    });

    if (!dryRun) {
      try {
        await docClient.send(
          new PutCommand({ TableName: table, Item: canonical }),
        );
        await docClient.send(
          new PutCommand({ TableName: table, Item: pointer }),
        );
        summary.twinsCollapsed++;
        log(
          "info",
          `COLLAPSED: ${pair.agentName} → canonical ${pair.recordId} + pointer`,
        );
      } catch (err) {
        log("error", `PutItem failed for ${pair.agentName}: ${String(err)}`);
        summary.errors++;
      }
    } else {
      summary.twinsCollapsed++;
      log(
        "info",
        `WOULD COLLAPSE: ${pair.agentName} → canonical ${pair.recordId} + pointer`,
      );
    }

    // Step 3: S3 copy to scoped key
    const config = canonical.config as Record<string, unknown> | undefined;
    const filename = config?.filename as string | undefined;
    if (filename) {
      const basename = filename.replace(/^.*[\\/]/, "");
      const scopedKey = `agents/${pair.recordId}/${basename}`;
      const legacyKey = `agents/${basename}`;

      planned.push({
        type: "s3-copy",
        key: scopedKey,
        before: { source: legacyKey },
        after: { destination: scopedKey },
      });

      if (!dryRun) {
        try {
          // Check if scoped key already exists
          await s3Client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: scopedKey }),
          );
          log("info", `S3 scoped key ${scopedKey} already exists — skipping`);
        } catch (headErr: unknown) {
          const code = (headErr as { name?: string }).name;
          if (code === "NotFound" || code === "NoSuchKey") {
            try {
              await s3Client.send(
                new CopyObjectCommand({
                  Bucket: bucket,
                  CopySource: `${bucket}/${legacyKey}`,
                  Key: scopedKey,
                }),
              );
              summary.s3Copies++;
              log("info", `S3 COPIED: ${legacyKey} → ${scopedKey}`);
            } catch (copyErr) {
              log(
                "error",
                `S3 copy ${legacyKey} → ${scopedKey} failed: ${String(copyErr)}`,
              );
              summary.errors++;
            }
          } else {
            log(
              "warn",
              `S3 head_object ${scopedKey} failed: ${String(headErr)} — skipping`,
            );
          }
        }
      } else {
        summary.s3Copies++;
        log("info", `WOULD COPY S3: ${legacyKey} → ${scopedKey}`);
      }
    }
  }

  // Step 4: Rewrite seeded blueprints
  if (nameToRecordId.size > 0) {
    await rewriteBlueprints(
      workflowsTable,
      nameToRecordId,
      dryRun,
      docClient,
      summary,
      planned,
    );
  }

  // Step 5: Revert non-seeded blueprints whose orgId was incorrectly set to 'system'
  if (opts.revertNonseededOrg) {
    await revertNonseededBlueprints(
      workflowsTable,
      opts.revertNonseededOrg,
      dryRun,
      docClient,
      summary,
      planned,
    );
  }

  return { summary, planned };
}

// ---------------------------------------------------------------------------
// Blueprint rewriting
// ---------------------------------------------------------------------------

async function rewriteBlueprints(
  workflowsTable: string,
  nameToRecordId: Map<string, string>,
  dryRun: boolean,
  docClient: DynamoDBDocumentClient,
  summary: ReconcileSummary,
  planned: PlannedChange[],
): Promise<void> {
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    let page;
    try {
      page = await docClient.send(
        new ScanCommand({
          TableName: workflowsTable,
          ExclusiveStartKey: exclusiveStartKey,
          FilterExpression:
            "isBlueprint = :bp AND (orgId = :sys OR orgId = :def)",
          ExpressionAttributeValues: {
            ":bp": "true",
            ":sys": BLUEPRINT_ORG_ID,
            ":def": "Default",
          },
        }),
      );
    } catch (err) {
      log("error", `Blueprint scan failed: ${String(err)}`);
      summary.errors++;
      return;
    }

    for (const item of page.Items ?? []) {
      const workflowId = item.workflowId as string;
      const defStr = item.definition as string | undefined;
      if (!defStr) continue;

      let def: {
        nodes?: Array<{ agentId?: string; [k: string]: unknown }>;
        [k: string]: unknown;
      };
      try {
        def = JSON.parse(defStr);
      } catch {
        continue;
      }

      let changed = false;
      const beforeNodes: string[] = [];
      const afterNodes: string[] = [];

      for (const node of def.nodes ?? []) {
        const agentId = node.agentId;
        if (typeof agentId === "string" && nameToRecordId.has(agentId)) {
          beforeNodes.push(agentId);
          node.agentId = nameToRecordId.get(agentId)!;
          node.legacyAgentName = agentId;
          afterNodes.push(node.agentId);
          changed = true;
        }
      }

      // Fix orgId from 'Default' to 'system' ONLY for seeded blueprints
      const isSeeded = SEEDED_BLUEPRINT_IDS.has(workflowId);
      const needsOrgFix = isSeeded && item.orgId === "Default";
      if (needsOrgFix) changed = true;

      if (!changed) continue;

      planned.push({
        type: "blueprint-rewrite",
        key: `workflow:${workflowId}`,
        before: {
          name: item.name,
          orgId: item.orgId,
          agentIds: beforeNodes,
        },
        after: {
          orgId: needsOrgFix ? BLUEPRINT_ORG_ID : item.orgId,
          agentIds: afterNodes,
        },
      });

      if (!dryRun) {
        const updatedItem = {
          ...item,
          definition: JSON.stringify(def),
          orgId: needsOrgFix ? BLUEPRINT_ORG_ID : item.orgId,
          updatedAt: new Date().toISOString(),
        };
        try {
          await docClient.send(
            new PutCommand({ TableName: workflowsTable, Item: updatedItem }),
          );
          summary.blueprintsRewritten++;
          log(
            "info",
            `REWRITTEN blueprint: ${item.name as string} (${workflowId})`,
          );
        } catch (err) {
          log(
            "error",
            `Blueprint PutItem failed for ${workflowId}: ${String(err)}`,
          );
          summary.errors++;
        }
      } else {
        summary.blueprintsRewritten++;
        log(
          "info",
          `WOULD REWRITE blueprint: ${item.name as string} (${workflowId})`,
        );
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);
}

// ---------------------------------------------------------------------------
// Revert non-seeded blueprints
// ---------------------------------------------------------------------------

async function revertNonseededBlueprints(
  workflowsTable: string,
  targetOrg: string,
  dryRun: boolean,
  docClient: DynamoDBDocumentClient,
  summary: ReconcileSummary,
  planned: PlannedChange[],
): Promise<void> {
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  log("info", `Revert non-seeded blueprints: orgId 'system' → '${targetOrg}'`);

  do {
    let page;
    try {
      page = await docClient.send(
        new ScanCommand({
          TableName: workflowsTable,
          ExclusiveStartKey: exclusiveStartKey,
          FilterExpression: "isBlueprint = :bp AND orgId = :sys",
          ExpressionAttributeValues: {
            ":bp": "true",
            ":sys": BLUEPRINT_ORG_ID,
          },
        }),
      );
    } catch (err) {
      log("error", `Revert blueprint scan failed: ${String(err)}`);
      summary.errors++;
      return;
    }

    for (const item of page.Items ?? []) {
      const workflowId = item.workflowId as string;

      // Skip seeded blueprints — they should keep orgId 'system'
      if (SEEDED_BLUEPRINT_IDS.has(workflowId)) continue;

      planned.push({
        type: "blueprint-rewrite",
        key: `revert:${workflowId}`,
        before: {
          name: item.name,
          orgId: item.orgId,
        },
        after: {
          orgId: targetOrg,
        },
      });

      if (!dryRun) {
        const updatedItem = {
          ...item,
          orgId: targetOrg,
          updatedAt: new Date().toISOString(),
        };
        try {
          await docClient.send(
            new PutCommand({ TableName: workflowsTable, Item: updatedItem }),
          );
          summary.blueprintsReverted++;
          log(
            "info",
            `REVERTED blueprint orgId: ${item.name as string} (${workflowId}) → '${targetOrg}'`,
          );
        } catch (err) {
          log(
            "error",
            `Revert PutItem failed for ${workflowId}: ${String(err)}`,
          );
          summary.errors++;
        }
      } else {
        summary.blueprintsReverted++;
        log(
          "info",
          `WOULD REVERT blueprint orgId: ${item.name as string} (${workflowId}) → '${targetOrg}'`,
        );
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const region = process.env.AWS_REGION || "us-west-2";
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3Client = new S3Client({ region });

  const { summary, planned } = await runReconcile({
    ...args,
    docClient,
    s3Client,
  });

  log("info", "--- Reconcile summary ---");
  console.log(JSON.stringify(summary));

  if (args.dryRun && planned.length > 0) {
    log("info", "--- Planned changes (dry-run) ---");
    for (const change of planned) {
      console.log(JSON.stringify(change));
    }
  }

  if (summary.errors > 0) {
    process.exit(1);
  }
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    log("error", `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
