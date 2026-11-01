/**
 * Resync S3 datastore scoped-role policies AND backfill Citadel ownership tags.
 *
 * After the S3 adapter's `requiredPolicies` was tightened to scope
 * DeleteBucket/DeleteObject to the specific bucket ARN (instead of '*'),
 * existing `citadel-ds-{id}` roles still carry the old wildcard grants.
 * This script re-issues the inline policy for each S3 datastore via
 * PolicyManager.ensureRole, which is an upsert (PutRolePolicy).
 *
 * Additionally, the new tag-based adoption guard requires
 * `citadel:dataStoreId` + `citadel:orgId` tags on every S3 bucket.
 * Existing buckets that were created before the guard was introduced
 * have no tags — reconnecting after deploy would be refused. This
 * script reads each bucket's tags, and if the required Citadel tags
 * are absent, applies them (merging with any pre-existing tags).
 * If tags exist with a DIFFERENT dataStoreId/orgId, a CONFLICT is
 * reported and the bucket is skipped (never overwritten).
 *
 * Dry-run by default. Pass --apply to write.
 * Idempotent: calling twice produces the same result.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/resync-datastore-roles.ts \
 *     --table <datastores-table> [--dry-run] [--apply]
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { IAMClient, GetRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  S3Client,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  Tag,
} from "@aws-sdk/client-s3";
import { PolicyManager } from "../src/utils/policy-manager";
import { getAdapter } from "../src/lambda/adapters/registry";

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

export interface ResyncSummary {
  total: number;
  policyChanged: number;
  tagged: number;
  tagConflict: number;
  tagAlreadyPresent: number;
  skipped: number;
}

export interface ResyncDeps {
  ddb: DynamoDBDocumentClient;
  iam: IAMClient;
  s3: S3Client;
  pm: PolicyManager;
  accountId: string;
  region: string;
}

// ---------------------------------------------------------------------------
// Tag backfill logic (exported for testing)
// ---------------------------------------------------------------------------

export interface TagResult {
  action: "tagged" | "already_present" | "conflict" | "skipped";
  reason?: string;
}

/**
 * Read the bucket's current tags and decide what to do.
 * - If required Citadel tags are already correct → already_present.
 * - If required Citadel tags are absent → tag (merge with existing).
 * - If required Citadel tags exist with DIFFERENT values → conflict.
 */
export async function reconcileBucketTags(
  s3: S3Client,
  bucketName: string,
  dataStoreId: string,
  orgId: string,
  apply: boolean,
): Promise<TagResult> {
  let existingTags: Tag[] = [];
  try {
    const resp = await s3.send(
      new GetBucketTaggingCommand({ Bucket: bucketName }),
    );
    existingTags = resp.TagSet ?? [];
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === "NoSuchTagSet") {
      // No tags at all — will tag
      existingTags = [];
    } else {
      throw err;
    }
  }

  const existingDsTag = existingTags.find((t) => t.Key === TAG_DS_ID);
  const existingOrgTag = existingTags.find((t) => t.Key === TAG_ORG_ID);

  // Check for conflict: tags exist but with different values
  if (existingDsTag && existingDsTag.Value !== dataStoreId) {
    return {
      action: "conflict",
      reason: `citadel:dataStoreId is '${existingDsTag.Value}', expected '${dataStoreId}'`,
    };
  }
  if (existingOrgTag && existingOrgTag.Value !== orgId) {
    return {
      action: "conflict",
      reason: `citadel:orgId is '${existingOrgTag.Value}', expected '${orgId}'`,
    };
  }

  // Check if already correctly tagged
  const hasDsTag = existingDsTag?.Value === dataStoreId;
  const hasOrgTag = existingOrgTag?.Value === orgId;
  if (hasDsTag && hasOrgTag) {
    return { action: "already_present" };
  }

  // Build merged tag set: keep all existing tags, add/replace Citadel tags
  const mergedTags: Tag[] = existingTags.filter(
    (t) =>
      t.Key !== TAG_DS_ID && t.Key !== TAG_ORG_ID && t.Key !== TAG_MANAGED_BY,
  );
  mergedTags.push(
    { Key: TAG_MANAGED_BY, Value: "citadel" },
    { Key: TAG_DS_ID, Value: dataStoreId },
    { Key: TAG_ORG_ID, Value: orgId },
  );

  if (!apply) {
    return { action: "tagged" };
  }

  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: mergedTags },
    }),
  );

  return { action: "tagged" };
}

// ---------------------------------------------------------------------------
// Main resync logic (exported for testing)
// ---------------------------------------------------------------------------

export async function runResync(
  table: string,
  apply: boolean,
  deps: ResyncDeps,
): Promise<ResyncSummary> {
  const { ddb, iam, s3, pm, accountId, region } = deps;
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`[${mode}] Scanning ${table} for S3 datastores…\n`);

  let lastKey: Record<string, unknown> | undefined;
  const summary: ResyncSummary = {
    total: 0,
    policyChanged: 0,
    tagged: 0,
    tagConflict: 0,
    tagAlreadyPresent: 0,
    skipped: 0,
  };

  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "#t = :s3 AND #st = :connected",
        ExpressionAttributeNames: { "#t": "type", "#st": "status" },
        ExpressionAttributeValues: { ":s3": "S3", ":connected": "CONNECTED" },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const row of scan.Items ?? []) {
      summary.total++;
      const dsId = row.dataStoreId as string;
      const orgId = (row.orgId ?? row.organization ?? "") as string;
      const config =
        typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      const bucketName = config?.bucketName as string | undefined;

      if (!bucketName) {
        console.log(`  SKIP ${dsId}: no bucketName in config`);
        summary.skipped++;
        continue;
      }

      // --- Policy resync ---
      const adapter = getAdapter("S3");
      const newPolicies = [
        ...adapter.requiredPolicies(config, accountId, region).provision,
        ...adapter.requiredPolicies(config, accountId, region).connect,
      ];

      const roleName = PolicyManager.getRoleName(dsId);
      let currentDoc:
        | { Statement?: Array<{ Action: string[]; Resource: string[] }> }
        | undefined;
      try {
        const resp = await iam.send(
          new GetRolePolicyCommand({
            RoleName: roleName,
            PolicyName: "DataStoreAccess",
          }),
        );
        currentDoc = JSON.parse(
          decodeURIComponent(resp.PolicyDocument ?? "{}"),
        );
      } catch (err: unknown) {
        const e = err as { name?: string };
        if (e.name === "NoSuchEntityException") {
          console.log(`  SKIP ${dsId}: role ${roleName} not found`);
          summary.skipped++;
          continue;
        }
        throw err;
      }

      const currentResources = (currentDoc?.Statement ?? []).flatMap(
        (s) => s.Resource ?? [],
      );
      const proposedResources = newPolicies.flatMap((p) => p.resources);
      const hasWildcard = currentResources.includes("*");

      console.log(`  ${dsId} (bucket: ${bucketName}, role: ${roleName}):`);
      console.log(`    Current resources:  ${currentResources.join(", ")}`);
      console.log(`    Proposed resources: ${proposedResources.join(", ")}`);
      console.log(
        `    Wildcard present:  ${hasWildcard ? "YES — will be removed" : "no"}`,
      );

      if (apply) {
        await pm.ensureRole(dsId, newPolicies, accountId, "datastore");
        console.log(`    ✓ Policy updated`);
      } else {
        console.log(`    → Would call ensureRole (dry-run)`);
      }
      summary.policyChanged++;

      // --- Tag backfill ---
      if (!orgId) {
        console.log(`    SKIP tagging: no orgId on row`);
        continue;
      }

      const tagResult = await reconcileBucketTags(
        s3,
        bucketName,
        dsId,
        orgId,
        apply,
      );

      switch (tagResult.action) {
        case "tagged":
          if (apply) {
            console.log(
              `    ✓ Tagged ${bucketName} dataStoreId=${dsId} orgId=${orgId}`,
            );
          } else {
            console.log(
              `    → would tag ${bucketName} dataStoreId=${dsId} orgId=${orgId}`,
            );
          }
          summary.tagged++;
          break;
        case "already_present":
          console.log(`    Tags already correct on ${bucketName}`);
          summary.tagAlreadyPresent++;
          break;
        case "conflict":
          console.log(
            `    CONFLICT ${bucketName}: ${tagResult.reason} — skipping`,
          );
          summary.tagConflict++;
          break;
        default:
          break;
      }
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    `\n[${mode}] Done. Scanned ${summary.total}, ` +
      `policies ${apply ? "updated" : "would update"} ${summary.policyChanged}, ` +
      `tagged ${summary.tagged}, conflicts ${summary.tagConflict}, ` +
      `already tagged ${summary.tagAlreadyPresent}, skipped ${summary.skipped}.`,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { table, apply } = parseArgs(process.argv.slice(2));

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const iam = new IAMClient({});
  const s3 = new S3Client({});
  const pm = new PolicyManager();
  const { accountId, region } = await pm.getAccountContext();

  await runResync(table, apply, { ddb, iam, s3, pm, accountId, region });
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
