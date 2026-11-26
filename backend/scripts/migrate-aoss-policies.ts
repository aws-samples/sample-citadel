/**
 * One-off migration: removes the account root principal from AOSS data
 * access policies for Knowledge Base datastores, replacing it with the
 * vended `citadel-ds-{id}` role ARN.
 *
 * Context: provisionVectorStore used to include
 * `arn:aws:iam::{accountId}:root` in the AOSS data access policy, granting
 * every identity in the account full index CRUD on the KB's AOSS collection.
 * The fix (C7) scopes the policy to just the KB service role and the vended
 * datastore role — this script applies that fix to existing policies.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-aoss-policies.ts \
 *     --table <datastores-table> [--dry-run] [--apply]
 *
 * --dry-run (default): reads policies and prints proposed changes.
 * --apply:             calls UpdateAccessPolicy with the cleaned principals.
 * --table:             REQUIRED — DynamoDB datastores table name.
 *
 * Runs under the operator's ambient credentials (admin role) because
 * aoss:UpdateAccessPolicy is a control-plane operation not granted to
 * the scoped citadel-ds-* roles.
 *
 * Idempotent: if root is already absent, no-op for that policy.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  OpenSearchServerlessClient,
  GetAccessPolicyCommand,
  UpdateAccessPolicyCommand,
} from "@aws-sdk/client-opensearchserverless";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE = "Usage: --table <datastores-table> [--apply] [--dry-run]";

const KNOWN_FLAGS = new Set(["--table", "--apply", "--dry-run"]);

export function parseArgs(argv: string[]): {
  table: string;
  dryRun: boolean;
} {
  let table = "";
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      process.exit(1);
    }
    switch (arg) {
      case "--table":
        table = argv[++i];
        break;
      case "--apply":
        dryRun = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  if (!table) {
    console.error(`--table is required\n${USAGE}`);
    process.exit(1);
  }

  return { table, dryRun };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicyRule {
  Resource: string[];
  Permission: string[];
  ResourceType: string;
}

interface PolicyEntry {
  Rules: PolicyRule[];
  Principal: string[];
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

export interface MigrateClients {
  dynamodb: DynamoDBDocumentClient;
  oss: OpenSearchServerlessClient;
  sts: STSClient;
}

export interface MigrateResult {
  scanned: number;
  skipped: number;
  updated: number;
  alreadyClean: number;
  failed: number;
  errors: Array<{ policyName: string; error: string }>;
}

/**
 * Build the expected AOSS data access policy name for a given KB collection name.
 * Mirrors the convention in KnowledgeBaseAdapter.provisionVectorStore:
 *   policyName = `aifkb-${collectionName}`
 *   collectionName = `aifkb-${name.replace(/[^a-z0-9-]/gi, '-').substring(0, 25).toLowerCase()}`
 * So policyName = `aifkb-aifkb-<sanitized-name>`.
 */
function policyNameForCollection(collectionName: string): string {
  return `aifkb-${collectionName}`;
}

export async function runMigration(
  opts: { table: string; dryRun: boolean },
  clients: MigrateClients,
): Promise<MigrateResult> {
  const result: MigrateResult = {
    scanned: 0,
    skipped: 0,
    updated: 0,
    alreadyClean: 0,
    failed: 0,
    errors: [],
  };

  // 1. Get account ID
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const rootPrincipal = `arn:aws:iam::${accountId}:root`;

  // 2. Scan datastores table for KNOWLEDGE_BASE rows
  let lastKey: Record<string, unknown> | undefined;
  const kbRows: Array<{ dataStoreId: string; config: Record<string, unknown>; name: string }> = [];

  do {
    const scanResult = await clients.dynamodb.send(
      new ScanCommand({
        TableName: opts.table,
        FilterExpression: "#t = :kb",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":kb": "KNOWLEDGE_BASE" },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of scanResult.Items ?? []) {
      const config =
        typeof item.config === "string" ? JSON.parse(item.config) : item.config ?? {};
      kbRows.push({
        dataStoreId: item.dataStoreId as string,
        config,
        name: (item.name as string) ?? "",
      });
    }
    lastKey = scanResult.LastEvaluatedKey;
  } while (lastKey);

  result.scanned = kbRows.length;
  console.log(`Found ${kbRows.length} KNOWLEDGE_BASE datastore(s).`);

  // 3. For each KB row, check its AOSS data access policy
  for (const row of kbRows) {
    // Derive the collection name the adapter would have created
    const rawName = (row.config.name as string) || row.name;
    if (!rawName) {
      console.log(`  [SKIP] ${row.dataStoreId}: no name in config or row`);
      result.skipped++;
      continue;
    }
    const collectionName = `aifkb-${rawName
      .replace(/[^a-z0-9-]/gi, "-")
      .substring(0, 25)
      .toLowerCase()}`;
    const policyName = policyNameForCollection(collectionName);
    const vendedRoleArn = `arn:aws:iam::${accountId}:role/citadel-ds-${row.dataStoreId}`;

    try {
      const policyResponse = await clients.oss.send(
        new GetAccessPolicyCommand({ name: policyName, type: "data" }),
      );

      const policyVersion = policyResponse.accessPolicyDetail?.policyVersion ?? "";
      const policyStr =
        typeof policyResponse.accessPolicyDetail?.policy === "string"
          ? policyResponse.accessPolicyDetail.policy
          : JSON.stringify(policyResponse.accessPolicyDetail?.policy ?? "[]");
      const policyDoc: PolicyEntry[] = JSON.parse(policyStr);

      // Check each entry for root principal
      let hasRoot = false;
      const newPolicyDoc: PolicyEntry[] = policyDoc.map((entry) => {
        const filtered = entry.Principal.filter((p) => p !== rootPrincipal);
        if (filtered.length !== entry.Principal.length) {
          hasRoot = true;
        }
        // Add vended role if not already present
        if (!filtered.includes(vendedRoleArn)) {
          filtered.push(vendedRoleArn);
        }
        return { ...entry, Principal: filtered };
      });

      if (!hasRoot) {
        // Check if vended role already present
        const alreadyHasVended = policyDoc.every((entry) =>
          entry.Principal.includes(vendedRoleArn),
        );
        if (alreadyHasVended) {
          console.log(`  [CLEAN] ${policyName}: no root, vended role present — skipping`);
          result.alreadyClean++;
          continue;
        }
      }

      const oldPrincipals = policyDoc[0]?.Principal ?? [];
      const newPrincipals = newPolicyDoc[0]?.Principal ?? [];

      if (opts.dryRun) {
        console.log(`  [DRY RUN] ${policyName}:`);
        console.log(`    Current principals: ${JSON.stringify(oldPrincipals)}`);
        console.log(`    Proposed principals: ${JSON.stringify(newPrincipals)}`);
        console.log(`    Action: Would call UpdateAccessPolicy`);
        result.updated++;
      } else {
        await clients.oss.send(
          new UpdateAccessPolicyCommand({
            name: policyName,
            type: "data",
            policyVersion,
            policy: JSON.stringify(newPolicyDoc),
          }),
        );
        console.log(`  [APPLIED] ${policyName}: updated principals ${JSON.stringify(oldPrincipals)} → ${JSON.stringify(newPrincipals)}`);
        result.updated++;
      }
    } catch (error) {
      const err = error as Error;
      if (err.name === "ResourceNotFoundException") {
        console.log(`  [SKIP] ${policyName}: policy not found`);
        result.skipped++;
      } else {
        console.error(`  [ERROR] ${policyName}: ${err.message}`);
        result.failed++;
        result.errors.push({ policyName, error: err.message });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry guard
// ---------------------------------------------------------------------------

/* istanbul ignore next — CLI entry point; tested via entrypoint smoke tests */
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `migrate-aoss-policies: ${args.dryRun ? "DRY RUN" : "APPLY"} mode, table=${args.table}`,
  );

  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const oss = new OpenSearchServerlessClient({});
  const sts = new STSClient({});

  runMigration(args, { dynamodb, oss, sts })
    .then((result) => {
      console.log("\nSummary:");
      console.log(`  Scanned:       ${result.scanned}`);
      console.log(`  Already clean: ${result.alreadyClean}`);
      console.log(`  Updated:       ${result.updated}`);
      console.log(`  Skipped:       ${result.skipped}`);
      console.log(`  Failed:        ${result.failed}`);
      if (result.failed > 0) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
