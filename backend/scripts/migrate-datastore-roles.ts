/**
 * Migrate existing citadel-ds-<id> scoped-role policies to connect-only
 * (concrete ARNs) and backfill Citadel ownership tags on provisioned
 * resources (DynamoDB tables, RDS instances, AOSS collections).
 *
 * After PR-2a, the resolver mints citadel-ds-<id> roles from the
 * adapter's `.connect` policy only. Existing roles still carry the old
 * `.provision` wildcards (Delete*, Create*, APIAccessAll on "*").
 * This script re-issues the inline policy via PolicyManager.ensureRole
 * (PutRolePolicy — a full-document upsert) and backfills resource tags
 * so the CDK `aws:ResourceTag` delete conditions are satisfied.
 *
 * Supported adapter types: S3, DYNAMODB, RDS_POSTGRESQL, RDS_MYSQL,
 * KNOWLEDGE_BASE.
 *
 * Dry-run by default. Pass --apply to write.
 * --data-store-id <id> to process a single row (canary mode).
 * Idempotent: a second run finds nothing to change.
 * Exit 0 clean, exit 1 on errors or conflicts.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-datastore-roles.ts \
 *     --table <datastores-table> [--region <region>] [--apply] [--data-store-id <id>]
 *
 * Env: AWS credentials (ambient), AWS_REGION or --region.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  IAMClient,
  GetRolePolicyCommand,
  GetRoleCommand,
  ListRoleTagsCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  DynamoDBClient as DynamoDBResourceClient,
  ListTagsOfResourceCommand as DdbListTagsCommand,
  TagResourceCommand as DdbTagResourceCommand,
} from "@aws-sdk/client-dynamodb";
import {
  RDSClient,
  ListTagsForResourceCommand as RdsListTagsCommand,
  AddTagsToResourceCommand,
} from "@aws-sdk/client-rds";
import {
  OpenSearchServerlessClient,
  ListTagsForResourceCommand as OssListTagsCommand,
  TagResourceCommand as OssTagResourceCommand,
} from "@aws-sdk/client-opensearchserverless";
import { PolicyManager } from "../src/utils/policy-manager";
import { getAdapter } from "../src/lambda/adapters/registry";
import { resolveRegionOrExit } from "./lib/resolve-region";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: --table <datastores-table> [--region <region>] [--apply] [--data-store-id <id>]";
const KNOWN_FLAGS = new Set([
  "--table",
  "--apply",
  "--dry-run",
  "--data-store-id",
]);

export function parseArgs(argv: string[]): {
  table: string;
  apply: boolean;
  dataStoreId: string | undefined;
} {
  let table = "";
  let apply = false;
  let dataStoreId: string | undefined;

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
    } else if (arg === "--data-store-id") {
      dataStoreId = argv[++i] ?? "";
    }
  }

  if (!table) {
    console.error(`--table is required.\n${USAGE}`);
    process.exit(1);
  }
  return { table, apply, dataStoreId };
}

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

const TAG_DS_ID = "citadel:dataStoreId";
const TAG_ORG_ID = "citadel:orgId";
const TAG_MANAGED_BY = "ManagedBy";

// ---------------------------------------------------------------------------
// Supported types for this migration
// ---------------------------------------------------------------------------

const MIGRATED_TYPES = new Set([
  "S3",
  "DYNAMODB",
  "RDS_POSTGRESQL",
  "RDS_MYSQL",
  "KNOWLEDGE_BASE",
]);

/**
 * Actions and Resource: "*" patterns that indicate a pre-C3 provisioning
 * policy that must be replaced.
 */
const DESTRUCTIVE_PATTERN = /(:Delete|:Create|APIAccessAll)/i;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface MigrationSummary {
  total: number;
  policyChanged: number;
  policyAlreadyClean: number;
  resourceTagged: number;
  roleTagged: number;
  tagConflict: number;
  tagAlreadyPresent: number;
  skipped: number;
  filtered: number;
  errors: number;
}

export interface MigrationDeps {
  ddb: DynamoDBDocumentClient;
  iam: IAMClient;
  dynamodbResource: DynamoDBResourceClient;
  rds: RDSClient;
  oss: OpenSearchServerlessClient;
  pm: PolicyManager;
  accountId: string;
  region: string;
}

export interface TagResult {
  action: "tagged" | "already_present" | "conflict" | "skipped";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Policy analysis helpers
// ---------------------------------------------------------------------------

function policyNeedsMigration(
  policyDoc: {
    Statement?: Array<{ Action: string[]; Resource: string[] }>;
  } | null,
): boolean {
  if (!policyDoc?.Statement) return false;
  for (const stmt of policyDoc.Statement) {
    // Check for wildcard resources
    if (stmt.Resource?.includes("*")) return true;
    // Check for destructive actions
    for (const action of stmt.Action ?? []) {
      if (DESTRUCTIVE_PATTERN.test(action)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resource tag reconciliation (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Reconcile ownership tags on a provisioned resource.
 *
 * Supported resourceType values:
 *   - "DYNAMODB" — uses DynamoDB TagResource (ARN-addressed)
 *   - "RDS"      — uses RDS AddTagsToResource
 *   - "AOSS"     — uses AOSS TagResource
 *
 * Decision rules (same as reconcileBucketTags in resync-datastore-roles.ts):
 *   - Tags absent → tag (merge with existing)
 *   - Tags correct → already_present
 *   - Tags different → conflict (never overwrite)
 */
export async function reconcileResourceTags(
  resourceType: "DYNAMODB" | "RDS" | "AOSS",
  resourceArn: string,
  dataStoreId: string,
  orgId: string,
  apply: boolean,
  deps: Pick<MigrationDeps, "dynamodbResource" | "rds" | "oss">,
): Promise<TagResult> {
  // Read current tags (each service has a different API shape)
  let existingTags: Array<{ key: string; value: string }> = [];

  if (resourceType === "DYNAMODB") {
    const resp = await deps.dynamodbResource.send(
      new DdbListTagsCommand({ ResourceArn: resourceArn }),
    );
    existingTags = (resp.Tags ?? []).map((t) => ({
      key: t.Key ?? "",
      value: t.Value ?? "",
    }));
  } else if (resourceType === "RDS") {
    const resp = await deps.rds.send(
      new RdsListTagsCommand({ ResourceName: resourceArn }),
    );
    existingTags = (resp.TagList ?? []).map((t) => ({
      key: t.Key ?? "",
      value: t.Value ?? "",
    }));
  } else if (resourceType === "AOSS") {
    const resp = await deps.oss.send(new OssListTagsCommand({ resourceArn }));
    existingTags = (resp.tags ?? []).map((t) => ({
      key: t.key ?? "",
      value: t.value ?? "",
    }));
  }

  // Check for conflicts
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

  // Check if already correctly tagged
  const hasDsTag = existingDsTag?.value === dataStoreId;
  const hasOrgTag = existingOrgTag?.value === orgId;
  if (hasDsTag && hasOrgTag) {
    return { action: "already_present" };
  }

  if (!apply) {
    return { action: "tagged" };
  }

  // Apply tags
  const citadelTags = [
    { key: TAG_MANAGED_BY, value: "citadel" },
    { key: TAG_DS_ID, value: dataStoreId },
    { key: TAG_ORG_ID, value: orgId },
  ];

  if (resourceType === "DYNAMODB") {
    await deps.dynamodbResource.send(
      new DdbTagResourceCommand({
        ResourceArn: resourceArn,
        Tags: citadelTags.map((t) => ({ Key: t.key, Value: t.value })),
      }),
    );
  } else if (resourceType === "RDS") {
    await deps.rds.send(
      new AddTagsToResourceCommand({
        ResourceName: resourceArn,
        Tags: citadelTags.map((t) => ({ Key: t.key, Value: t.value })),
      }),
    );
  } else if (resourceType === "AOSS") {
    await deps.oss.send(
      new OssTagResourceCommand({
        resourceArn,
        tags: citadelTags,
      }),
    );
  }

  return { action: "tagged" };
}

// ---------------------------------------------------------------------------
// Role tag reconciliation (reuse pattern from reconcile-kb-ownership.ts)
// ---------------------------------------------------------------------------

async function reconcileRoleTags(
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
// Resolve resource identifiers and ARN from config + type
// ---------------------------------------------------------------------------

interface ResourceInfo {
  /** ARN of the resource for tagging */
  resourceArn: string;
  /** Tag API type selector */
  tagType: "DYNAMODB" | "RDS" | "AOSS";
}

function resolveResources(
  type: string,
  config: Record<string, unknown>,
  accountId: string,
  region: string,
): ResourceInfo[] {
  const resources: ResourceInfo[] = [];

  if (type === "DYNAMODB") {
    const tableName = config.tableName as string | undefined;
    if (tableName) {
      resources.push({
        resourceArn: `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`,
        tagType: "DYNAMODB",
      });
    }
  } else if (type === "RDS_POSTGRESQL" || type === "RDS_MYSQL") {
    const dbId = config.dbInstanceIdentifier as string | undefined;
    if (dbId) {
      resources.push({
        resourceArn: `arn:aws:rds:${region}:${accountId}:db:${dbId}`,
        tagType: "RDS",
      });
    }
  } else if (type === "KNOWLEDGE_BASE") {
    const collectionId = config.collectionId as string | undefined;
    if (collectionId) {
      resources.push({
        resourceArn: `arn:aws:aoss:${region}:${accountId}:collection/${collectionId}`,
        tagType: "AOSS",
      });
    }
  }
  // S3 tagging is handled by the existing resync-datastore-roles.ts

  return resources;
}

// ---------------------------------------------------------------------------
// Main migration logic (exported for testing)
// ---------------------------------------------------------------------------

export async function runMigration(
  table: string,
  apply: boolean,
  dataStoreIdFilter: string | undefined,
  deps: MigrationDeps,
): Promise<MigrationSummary> {
  const { ddb, iam, pm, accountId, region } = deps;
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(
    `[${mode}] Scanning ${table} for AWS datastore roles to migrate…\n`,
  );

  let lastKey: Record<string, unknown> | undefined;
  const summary: MigrationSummary = {
    total: 0,
    policyChanged: 0,
    policyAlreadyClean: 0,
    resourceTagged: 0,
    roleTagged: 0,
    tagConflict: 0,
    tagAlreadyPresent: 0,
    skipped: 0,
    filtered: 0,
    errors: 0,
  };

  // Build filter expression: supported types, excluding deleted/DELETING
  const typeValues: Record<string, string> = {};
  let idx = 0;
  for (const t of MIGRATED_TYPES) {
    typeValues[`:t${idx++}`] = t;
  }
  const typeCondition = Object.keys(typeValues).join(", ");

  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: `#t IN (${typeCondition}) AND NOT #st IN (:deleted, :deleting)`,
        ExpressionAttributeNames: { "#t": "type", "#st": "status" },
        ExpressionAttributeValues: {
          ...typeValues,
          ":deleted": "DELETED",
          ":deleting": "DELETING",
        },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const row of scan.Items ?? []) {
      const dsId = row.dataStoreId as string;
      const dsType = row.type as string;
      const status = row.status as string;
      const orgId = (row.orgId ?? row.organization ?? "") as string;

      // Defensive client-side re-check (server-side FilterExpression
      // is the primary filter but mocks may not enforce it)
      const EXCLUDED_STATUSES = new Set(["DELETED", "DELETING"]);
      if (!MIGRATED_TYPES.has(dsType) || EXCLUDED_STATUSES.has(status)) {
        continue;
      }

      // Canary filter
      if (dataStoreIdFilter && dsId !== dataStoreIdFilter) {
        summary.filtered++;
        continue;
      }

      summary.total++;
      const config =
        typeof row.config === "string" ? JSON.parse(row.config) : row.config;

      // For KB: need knowledgeBaseId + collectionId to compute connect policy
      if (dsType === "KNOWLEDGE_BASE") {
        const kbId = config?.knowledgeBaseId as string | undefined;
        const collId = config?.collectionId as string | undefined;
        if (!kbId || !collId) {
          console.log(
            `  SKIP ${dsId}: no knowledgeBaseId/collectionId in config`,
          );
          summary.skipped++;
          continue;
        }
      }

      // For DynamoDB: need tableName
      if (dsType === "DYNAMODB" && !config?.tableName) {
        console.log(`  SKIP ${dsId}: no tableName in config`);
        summary.skipped++;
        continue;
      }

      // For RDS: need dbInstanceIdentifier
      if (
        (dsType === "RDS_POSTGRESQL" || dsType === "RDS_MYSQL") &&
        !config?.dbInstanceIdentifier
      ) {
        console.log(`  SKIP ${dsId}: no dbInstanceIdentifier in config`);
        summary.skipped++;
        continue;
      }

      const roleName = PolicyManager.getRoleName(dsId);
      console.log(
        `  ${dsId} (type: ${dsType}, status: ${status}, role: ${roleName}):`,
      );

      try {
        // ---------------------------------------------------------------
        // 1. Policy resync: read current, compare, re-issue as connect-only
        // ---------------------------------------------------------------
        let currentDoc: {
          Statement?: Array<{ Action: string[]; Resource: string[] }>;
        } | null = null;
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
            console.log(`    SKIP: role ${roleName} not found`);
            summary.skipped++;
            continue;
          }
          throw err;
        }

        // Build the connect-only policy from the adapter
        const adapterType =
          dsType === "RDS_POSTGRESQL" || dsType === "RDS_MYSQL"
            ? dsType
            : dsType;
        const adapter = getAdapter(adapterType);
        const connectPolicies = adapter.requiredPolicies(
          config,
          accountId,
          region,
        ).connect;

        if (policyNeedsMigration(currentDoc)) {
          const currentResources = (currentDoc?.Statement ?? []).flatMap(
            (s) => s.Resource ?? [],
          );
          const currentActions = (currentDoc?.Statement ?? []).flatMap(
            (s) => s.Action ?? [],
          );
          const proposedResources = connectPolicies.flatMap((p) => p.resources);
          const proposedActions = connectPolicies.flatMap((p) => p.actions);

          console.log(`    Current actions:   ${currentActions.join(", ")}`);
          console.log(`    Current resources: ${currentResources.join(", ")}`);
          console.log(`    Proposed actions:  ${proposedActions.join(", ")}`);
          console.log(`    Proposed resources:${proposedResources.join(", ")}`);
          console.log(
            `    Wildcard/*: YES — will be replaced with connect-only`,
          );

          if (apply) {
            await pm.ensureRole(dsId, connectPolicies, accountId, "datastore");
            console.log(`    ✓ Policy updated to connect-only`);
          } else {
            console.log(`    → Would call ensureRole (dry-run)`);
          }
          summary.policyChanged++;
        } else {
          console.log(`    Policy already connect-only — no change needed`);
          summary.policyAlreadyClean++;
        }

        // ---------------------------------------------------------------
        // 2. Role tag backfill
        // ---------------------------------------------------------------
        if (orgId) {
          const roleResult = await reconcileRoleTags(
            iam,
            roleName,
            dsId,
            orgId,
            apply,
          );
          logTagResult("role", roleResult, apply, summary, true);
        } else {
          console.log(`    SKIP role tagging: no orgId on row`);
        }

        // ---------------------------------------------------------------
        // 3. Resource tag backfill
        // ---------------------------------------------------------------
        if (!orgId) {
          console.log(`    SKIP resource tagging: no orgId on row`);
          continue;
        }

        const resources = resolveResources(dsType, config, accountId, region);
        for (const res of resources) {
          const tagResult = await reconcileResourceTags(
            res.tagType,
            res.resourceArn,
            dsId,
            orgId,
            apply,
            deps,
          );
          logTagResult(
            `${res.tagType.toLowerCase()} ${res.resourceArn}`,
            tagResult,
            apply,
            summary,
            false,
          );
        }
      } catch (err) {
        console.error(`    ERROR migrating ${dsId}:`, err);
        summary.errors++;
      }
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    `\n[${mode}] Done. Scanned ${summary.total}, ` +
      `policies ${apply ? "updated" : "would update"} ${summary.policyChanged}, ` +
      `already clean ${summary.policyAlreadyClean}, ` +
      `resources tagged ${summary.resourceTagged}, ` +
      `roles tagged ${summary.roleTagged}, ` +
      `tag conflicts ${summary.tagConflict}, ` +
      `already tagged ${summary.tagAlreadyPresent}, ` +
      `skipped ${summary.skipped}, filtered ${summary.filtered}, ` +
      `errors ${summary.errors}.`,
  );

  if (summary.tagConflict > 0 || summary.errors > 0) {
    console.log(
      `\n⚠ ${summary.tagConflict} CONFLICT(s), ${summary.errors} ERROR(s) — review required.`,
    );
  }

  return summary;
}

function logTagResult(
  label: string,
  result: TagResult,
  apply: boolean,
  summary: MigrationSummary,
  isRole: boolean,
): void {
  switch (result.action) {
    case "tagged":
      if (apply) {
        console.log(`    ✓ Tagged ${label}`);
      } else {
        console.log(`    → would tag ${label} (dry-run)`);
      }
      if (isRole) {
        summary.roleTagged++;
      } else {
        summary.resourceTagged++;
      }
      break;
    case "already_present":
      console.log(`    ${label} tags already correct`);
      summary.tagAlreadyPresent++;
      break;
    case "conflict":
      console.log(`    CONFLICT ${label}: ${result.reason} — skipping`);
      summary.tagConflict++;
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
  const { table, apply, dataStoreId } = parseArgs(rest);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const iam = new IAMClient({ region });
  const dynamodbResource = new DynamoDBResourceClient({ region });
  const rds = new RDSClient({ region });
  const oss = new OpenSearchServerlessClient({ region });
  const pm = new PolicyManager();
  const { accountId } = await pm.getAccountContext();

  const summary = await runMigration(table, apply, dataStoreId, {
    ddb,
    iam,
    dynamodbResource,
    rds,
    oss,
    pm,
    accountId,
    region,
  });

  if (summary.tagConflict > 0 || summary.errors > 0) {
    process.exit(1);
  }
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
