/**
 * One-off backfill: stamps `organization` on project rows that lack it.
 *
 * Context: createProject used to persist `organization: userOrganization ||
 * undefined` — rows created by a caller whose JWT lacked the
 * `custom:organization` claim were written with NO organization attribute
 * at all. This script scans the projects table and backfills the missing
 * attribute so the OrganizationIndex GSI can surface them.
 *
 * Ported from the dead src/lambda/backfill-project-org.ts Lambda handler
 * into the standard scripts/ convention (dry-run default, --apply,
 * --org required, summary counts, idempotent).
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/backfill-project-org.ts \
 *     --org Default --table <projects-table> [--dry-run] [--apply]
 *
 * --dry-run (default): scans and reports what would change.
 * --apply:             writes organization to project rows.
 * --org:               REQUIRED — the organization name to stamp.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const USAGE =
  "Usage: --org <name> --table <projects-table> [--apply] [--dry-run]";

const KNOWN_FLAGS = new Set(["--org", "--table", "--apply", "--dry-run"]);

export function parseArgs(argv: string[]): {
  org: string;
  table: string;
  dryRun: boolean;
} {
  let org = "";
  let table = "";
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      process.exit(1);
    }
    switch (arg) {
      case "--org":
        org = argv[++i];
        break;
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

  if (!org || !table) {
    console.error(USAGE);
    process.exit(1);
  }
  return { org, table, dryRun };
}

// ---------------------------------------------------------------------------
// Backfill counters
// ---------------------------------------------------------------------------

export interface BackfillProjectOrgCounters {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackfillProjectOrg(
  org: string,
  table: string,
  dryRun: boolean,
): Promise<BackfillProjectOrgCounters> {
  console.log(
    `Backfill project org: org=${org} table=${table} dryRun=${dryRun}`,
  );

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const counters: BackfillProjectOrgCounters = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items = page.Items ?? [];

    for (const item of items) {
      counters.scanned++;
      const id = item.id as string | undefined;
      if (!id) {
        counters.skipped++;
        continue;
      }

      // Only target rows with absent or empty organization.
      const orgVal = item.organization;
      if (orgVal !== undefined && orgVal !== null && orgVal !== "") {
        counters.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[DRY-RUN] Would update project ${id}: organization=${org}`,
        );
        counters.updated++;
      } else {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: table,
              Key: { id },
              UpdateExpression: "SET #organization = :org",
              ExpressionAttributeNames: { "#organization": "organization" },
              ExpressionAttributeValues: {
                ":org": org,
                ":nullVal": null,
                ":empty": "",
              },
              // Defensive re-check: only stamp rows still missing/null/empty
              // org at write time, so a concurrent createProject that has
              // since set a real organization is never clobbered.
              ConditionExpression:
                "attribute_not_exists(organization) OR organization = :nullVal OR organization = :empty",
            }),
          );
          console.log(`Updated project ${id}: organization=${org}`);
          counters.updated++;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.name === "ConditionalCheckFailedException"
          ) {
            // Organization was set concurrently — row is already scoped.
            counters.skipped++;
            continue;
          }
          console.error(`Project ${id}: error:`, err);
          counters.failed++;
        }
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  console.log(
    `Done. scanned=${counters.scanned} updated=${counters.updated} skipped=${counters.skipped} failed=${counters.failed} dryRun=${dryRun}`,
  );

  return counters;
}

async function main(): Promise<void> {
  const { org, table, dryRun } = parseArgs(process.argv.slice(2));

  const counters = await runBackfillProjectOrg(org, table, dryRun);

  if (counters.failed > 0) process.exit(1);
}

const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
