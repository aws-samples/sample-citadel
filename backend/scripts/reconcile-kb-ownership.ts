/**
 * Backfill Citadel ownership tags + resolved identifiers for existing
 * KNOWLEDGE_BASE datastores (Citadel PR-1, C1+C2 migration).
 *
 * Context: before this PR, the KB service role and AOSS collection were
 * named from the tenant DISPLAY NAME with no ownership tags, and
 * EntityAlreadyExists/ConflictException on either resource silently
 * adopted whatever existed. The fix derives names from immutable ids and
 * requires citadel:orgId + citadel:dataStoreId tags before any reuse.
 * Existing (legacy) resources predate the tagging requirement, so without
 * this backfill the new preflight/ownership checks would refuse every
 * pre-existing KB datastore on first contact after deploy.
 *
 * Mirrors resync-datastore-roles.ts exactly: dry-run by default,
 * idempotent, CONFLICT -> skip (never overwrite), --apply to write.
 *
 * Behavior per KNOWLEDGE_BASE datastore row:
 *   1. Resolve identifiers: prefer config.serviceRoleName/collectionArn if
 *      already recorded; otherwise derive the LEGACY names from the
 *      stored display `name` (the pre-fix naming scheme) to locate the
 *      role/collection that provisioning actually created.
 *   2. Tag backfill (role + collection), each independently:
 *      - absent  -> apply citadel:orgId/citadel:dataStoreId/ManagedBy
 *                   (merged with existing tags)
 *      - correct -> already_present (no-op)
 *      - DIFFERENT org/dataStoreId -> CONFLICT: report, skip, never
 *        overwrite (decision 44a2bfc1)
 *   3. Record resolved identifiers (serviceRoleArn/serviceRoleName/
 *      collectionName/collectionArn) into config so preflight and future
 *      re-provisions use them (idempotent UpdateCommand).
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/reconcile-kb-ownership.ts \
 *     --table <datastores-table> [--dry-run|--apply]
 *
 * Runs under the operator's ambient admin credentials (like
 * migrate-aoss-policies.ts) — no new CDK grant needed for the script
 * itself.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  IAMClient,
  GetRoleCommand,
  ListRoleTagsCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  OpenSearchServerlessClient,
  BatchGetCollectionCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from "@aws-sdk/client-opensearchserverless";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { resolveRegionOrExit } from "./lib/resolve-region";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE = "Usage: --table <datastores-table> [--apply] [--dry-run]";
const KNOWN_FLAGS = new Set(["--table", "--apply", "--dry-run"]);

export function parseArgs(argv: string[]): { table: string; apply: boolean } {
  let table = "";
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      process.exit(1);
    }
    if (arg === "--table") {
      table = argv[++i] ?? "";
    } else if (arg === "--apply") {
      apply = true;
    }
  }

  if (!table) {
    console.error(`--table is required.\n${USAGE}`);
    process.exit(1);
  }
  return { table, apply };
}

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

const TAG_DS_ID = "citadel:dataStoreId";
const TAG_ORG_ID = "citadel:orgId";
const TAG_MANAGED_BY = "ManagedBy";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  total: number;
  tagged: number;
  alreadyPresent: number;
  conflict: number;
  recorded: number;
  skipped: number;
  errors: number;
}

export interface ReconcileDeps {
  ddb: DynamoDBDocumentClient;
  iam: IAMClient;
  oss: OpenSearchServerlessClient;
  accountId: string;
  region: string;
}

export interface TagResult {
  action: "tagged" | "already_present" | "conflict" | "skipped";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Role tag backfill (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Read the KB service role's current tags and decide what to do.
 * - Role not found -> skipped (nothing to tag; likely never provisioned).
 * - Required Citadel tags already correct -> already_present.
 * - Required Citadel tags absent -> tag (merge with existing).
 * - Required Citadel tags exist with DIFFERENT values -> conflict.
 */
export async function reconcileRoleTags(
  iam: IAMClient,
  roleName: string,
  dataStoreId: string,
  orgId: string,
  apply: boolean,
): Promise<TagResult> {
  let existingTags: Array<{ Key?: string; Value?: string }> = [];
  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
    const tagResult = await iam.send(
      new ListRoleTagsCommand({ RoleName: roleName }),
    );
    existingTags = tagResult.Tags ?? [];
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === "NoSuchEntityException") {
      return { action: "skipped", reason: `role ${roleName} not found` };
    }
    throw err;
  }

  const existingDsTag = existingTags.find((t) => t.Key === TAG_DS_ID);
  const existingOrgTag = existingTags.find((t) => t.Key === TAG_ORG_ID);

  if (existingDsTag && existingDsTag.Value !== dataStoreId) {
    return {
      action: "conflict",
      reason: `${TAG_DS_ID} is '${existingDsTag.Value}', expected '${dataStoreId}'`,
    };
  }
  if (existingOrgTag && existingOrgTag.Value !== orgId) {
    return {
      action: "conflict",
      reason: `${TAG_ORG_ID} is '${existingOrgTag.Value}', expected '${orgId}'`,
    };
  }

  const hasDsTag = existingDsTag?.Value === dataStoreId;
  const hasOrgTag = existingOrgTag?.Value === orgId;
  if (hasDsTag && hasOrgTag) {
    return { action: "already_present" };
  }

  if (!apply) {
    return { action: "tagged" };
  }

  await iam.send(
    new TagRoleCommand({
      RoleName: roleName,
      Tags: [
        { Key: TAG_MANAGED_BY, Value: "citadel" },
        { Key: TAG_DS_ID, Value: dataStoreId },
        { Key: TAG_ORG_ID, Value: orgId },
      ],
    }),
  );

  return { action: "tagged" };
}

// ---------------------------------------------------------------------------
// Collection tag backfill (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Read the AOSS collection's current tags (by ARN) and decide what to do.
 * Same decision rules as reconcileRoleTags.
 */
export async function reconcileCollectionTags(
  oss: OpenSearchServerlessClient,
  collectionArn: string,
  dataStoreId: string,
  orgId: string,
  apply: boolean,
): Promise<TagResult> {
  const tagResult = await oss.send(
    new ListTagsForResourceCommand({ resourceArn: collectionArn }),
  );
  const existingTags = tagResult.tags ?? [];

  const existingDsTag = existingTags.find((t) => t.key === TAG_DS_ID);
  const existingOrgTag = existingTags.find((t) => t.key === TAG_ORG_ID);

  if (existingDsTag && existingDsTag.value !== dataStoreId) {
    return {
      action: "conflict",
      reason: `${TAG_DS_ID} is '${existingDsTag.value}', expected '${dataStoreId}'`,
    };
  }
  if (existingOrgTag && existingOrgTag.value !== orgId) {
    return {
      action: "conflict",
      reason: `${TAG_ORG_ID} is '${existingOrgTag.value}', expected '${orgId}'`,
    };
  }

  const hasDsTag = existingDsTag?.value === dataStoreId;
  const hasOrgTag = existingOrgTag?.value === orgId;
  if (hasDsTag && hasOrgTag) {
    return { action: "already_present" };
  }

  if (!apply) {
    return { action: "tagged" };
  }

  await oss.send(
    new TagResourceCommand({
      resourceArn: collectionArn,
      tags: [
        { key: TAG_MANAGED_BY, value: "citadel" },
        { key: TAG_DS_ID, value: dataStoreId },
        { key: TAG_ORG_ID, value: orgId },
      ],
    }),
  );

  return { action: "tagged" };
}

// ---------------------------------------------------------------------------
// Legacy naming helpers (pre-C1 scheme, for locating existing resources)
// ---------------------------------------------------------------------------

/** Pre-C1 service role name: derived from the sanitized display name. */
function legacyServiceRoleName(displayName: string): string {
  return `citadel-ds-kb-svc-${displayName
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .substring(0, 30)}`;
}

/** Pre-C1 AOSS collection name: derived from the sanitized display name. */
function legacyCollectionName(displayName: string): string {
  return `aifkb-${displayName
    .replace(/[^a-z0-9-]/gi, "-")
    .substring(0, 25)
    .toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Main reconcile logic (exported for testing)
// ---------------------------------------------------------------------------

export async function runReconcile(
  table: string,
  apply: boolean,
  deps: ReconcileDeps,
): Promise<ReconcileSummary> {
  const { ddb, iam, oss, accountId } = deps;
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`[${mode}] Scanning ${table} for KNOWLEDGE_BASE datastores…\n`);

  let lastKey: Record<string, unknown> | undefined;
  const summary: ReconcileSummary = {
    total: 0,
    tagged: 0,
    alreadyPresent: 0,
    conflict: 0,
    recorded: 0,
    skipped: 0,
    errors: 0,
  };

  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "#t = :kb",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":kb": "KNOWLEDGE_BASE" },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const row of scan.Items ?? []) {
      summary.total++;
      const dsId = row.dataStoreId as string;
      const orgId = (row.orgId ?? "") as string;
      const displayName = (row.name ?? "") as string;
      const config =
        typeof row.config === "string" ? JSON.parse(row.config) : row.config;

      if (!orgId) {
        console.log(`  SKIP ${dsId}: no orgId on row`);
        summary.skipped++;
        continue;
      }

      try {
        const roleName =
          (config?.serviceRoleName as string | undefined) ??
          legacyServiceRoleName(displayName);
        const collectionName =
          (config?.collectionName as string | undefined) ??
          legacyCollectionName(displayName);

        console.log(
          `  ${dsId} (role: ${roleName}, collection: ${collectionName}):`,
        );

        const roleResult = await reconcileRoleTags(
          iam,
          roleName,
          dsId,
          orgId,
          apply,
        );
        logTagResult("role", roleResult, apply, summary);

        // Resolve the collection ARN by name before tagging (AOSS tag ops
        // are ARN-addressed, not name-addressed).
        let collectionArn: string | undefined = config?.collectionArn as
          string | undefined;
        if (!collectionArn) {
          try {
            const batch = await oss.send(
              new BatchGetCollectionCommand({ names: [collectionName] }),
            );
            collectionArn = batch.collectionDetails?.[0]?.arn;
          } catch (e) {
            console.log(
              `    collection lookup failed: ${(e as Error).message}`,
            );
          }
        }

        if (!collectionArn) {
          console.log(
            `    SKIP collection tagging: ${collectionName} not found`,
          );
        } else {
          const collResult = await reconcileCollectionTags(
            oss,
            collectionArn,
            dsId,
            orgId,
            apply,
          );
          logTagResult("collection", collResult, apply, summary);
        }

        // Record resolved identifiers into config (idempotent).
        if (apply) {
          const updatedConfig = {
            ...config,
            serviceRoleName: roleName,
            serviceRoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            collectionName,
            ...(collectionArn ? { collectionArn } : {}),
          };
          await ddb.send(
            new UpdateCommand({
              TableName: table,
              Key: { dataStoreId: dsId },
              UpdateExpression: "SET config = :config",
              ExpressionAttributeValues: {
                ":config": JSON.stringify(updatedConfig),
              },
            }),
          );
          summary.recorded++;
          console.log(`    ✓ Recorded identifiers`);
        } else {
          console.log(`    → would record identifiers (dry-run)`);
        }
      } catch (err) {
        console.error(`    ERROR reconciling ${dsId}:`, err);
        summary.errors++;
      }
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    `\n[${mode}] Done. Scanned ${summary.total}, tagged ${summary.tagged}, ` +
      `already correct ${summary.alreadyPresent}, conflicts ${summary.conflict}, ` +
      `recorded ${summary.recorded}, skipped ${summary.skipped}, errors ${summary.errors}.`,
  );
  if (summary.conflict > 0) {
    console.log(
      `\n⚠ ${summary.conflict} CONFLICT row(s) require manual review before strict-mode cutover.`,
    );
  }

  return summary;
}

function logTagResult(
  label: string,
  result: TagResult,
  apply: boolean,
  summary: ReconcileSummary,
): void {
  switch (result.action) {
    case "tagged":
      console.log(
        apply ? `    ✓ Tagged ${label}` : `    → would tag ${label} (dry-run)`,
      );
      summary.tagged++;
      break;
    case "already_present":
      console.log(`    ${label} tags already correct`);
      summary.alreadyPresent++;
      break;
    case "conflict":
      console.log(`    CONFLICT ${label}: ${result.reason} — skipping`);
      summary.conflict++;
      break;
    case "skipped":
      console.log(`    SKIP ${label}: ${result.reason}`);
      summary.skipped++;
      break;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { region, rest } = resolveRegionOrExit(process.argv.slice(2));
  const { table, apply } = parseArgs(rest);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const iam = new IAMClient({ region });
  const oss = new OpenSearchServerlessClient({ region });
  const sts = new STSClient({ region });

  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;

  await runReconcile(table, apply, {
    ddb,
    iam,
    oss,
    accountId,
    region,
  });
}

/**
 * Entry-point guard that works under BOTH module systems:
 *   - ts-node / ts-jest (CommonJS): checked via `require.main === module`.
 *   - Node's native TypeScript execution (ESM): `require` is undefined.
 */
const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
