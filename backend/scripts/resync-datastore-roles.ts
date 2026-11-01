/**
 * Resync S3 datastore scoped-role policies.
 *
 * After the S3 adapter's `requiredPolicies` was tightened to scope
 * DeleteBucket/DeleteObject to the specific bucket ARN (instead of '*'),
 * existing `citadel-ds-{id}` roles still carry the old wildcard grants.
 * This script re-issues the inline policy for each S3 datastore via
 * PolicyManager.ensureRole, which is an upsert (PutRolePolicy).
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
import { PolicyManager } from "../src/utils/policy-manager";
import { getAdapter } from "../src/lambda/adapters/registry";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE = "Usage: --table <datastores-table> [--apply] [--dry-run]";
const KNOWN_FLAGS = new Set(["--table", "--apply", "--dry-run"]);

function parseArgs(argv: string[]): { table: string; apply: boolean } {
  let table = "";
  let apply = false;

  for (let i = 2; i < argv.length; i++) {
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { table, apply } = parseArgs(process.argv);
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`[${mode}] Scanning ${table} for S3 datastores…\n`);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const iam = new IAMClient({});
  const pm = new PolicyManager();
  const { accountId, region } = await pm.getAccountContext();

  // Scan for S3 rows that are CONNECTED
  let lastKey: Record<string, unknown> | undefined;
  let total = 0;
  let changed = 0;
  let skipped = 0;

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
      total++;
      const dsId = row.dataStoreId as string;
      const config =
        typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      const bucketName = config?.bucketName as string | undefined;

      if (!bucketName) {
        console.log(`  SKIP ${dsId}: no bucketName in config`);
        skipped++;
        continue;
      }

      const adapter = getAdapter("S3");
      const newPolicies = [
        ...adapter.requiredPolicies(config, accountId, region).provision,
        ...adapter.requiredPolicies(config, accountId, region).connect,
      ];

      // Read the current inline policy for comparison
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
          skipped++;
          continue;
        }
        throw err;
      }

      // Build diff summary
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
      changed++;
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    `\n[${mode}] Done. Scanned ${total}, ${apply ? "updated" : "would update"} ${changed}, skipped ${skipped}.`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
