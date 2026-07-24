/**
 * One-time backfill Lambda: stamps `organization: 'Default'` onto every
 * projects-table row written before org scoping existed.
 *
 * Context: createProject used to persist `organization: userOrganization ||
 * undefined` — rows created by a caller whose JWT lacked the
 * `custom:organization` claim were written with NO organization attribute
 * at all. Those rows never landed on the OrganizationIndex GSI, so
 * listProjects's org-scoped query could never surface them and the same
 * org's other members couldn't see them (see project-resolver.ts).
 *
 * This handler scans the full projects table, finds every item missing the
 * `organization` attribute (or where it is explicitly undefined/null),
 * and UpdateCommands it to `organization: 'Default'` — the same fallback
 * createProject/listProjects now use going forward. Existing rows that
 * already carry an organization are left untouched.
 *
 * Idempotent and safe to re-run: a project already backfilled (or created
 * post-fix) simply won't match the FilterExpression on a subsequent run.
 *
 * ── How to run this (one-time migration, no permanent CDK resource) ──────
 *
 * This handler is intentionally NOT wired into any CDK stack — it is a
 * single-shot backfill, not a piece of running infrastructure, so it does
 * not need a permanent Lambda function, schedule, or IAM role in the stack
 * definition. Pick ONE of the following to execute it:
 *
 * Option A — Deploy a temporary Lambda via the CDK CLI / AWS CLI, then invoke it:
 *   1. Bundle this file the same way other resolvers are bundled:
 *        npx esbuild src/lambda/backfill-project-org.ts --bundle \
 *          --platform=node --target=node24 --outdir=dist/lambda \
 *          --external:@aws-sdk/* --format=cjs
 *   2. Create a throwaway Lambda function from dist/lambda/backfill-project-org.js
 *      (handler: backfill-project-org.handler, runtime: nodejs24.x) with an
 *      execution role scoped to Scan/UpdateItem on the projects table, and
 *      set the PROJECTS_TABLE env var to the deployed table name, e.g.:
 *        aws lambda create-function \
 *          --function-name citadel-backfill-project-org-<env> \
 *          --runtime nodejs24.x --handler backfill-project-org.handler \
 *          --role <execution-role-arn> \
 *          --zip-file fileb://dist/lambda/backfill-project-org.zip \
 *          --environment "Variables={PROJECTS_TABLE=<projects-table-name>}"
 *   3. Invoke it once and inspect the result:
 *        aws lambda invoke --function-name citadel-backfill-project-org-<env> /dev/stdout
 *   4. Delete the temporary function afterwards:
 *        aws lambda delete-function --function-name citadel-backfill-project-org-<env>
 *
 * Option B — AWS Console:
 *   1. Console → Lambda → Create function → paste the compiled JS (or upload
 *      the zip from Option A step 1) with handler `backfill-project-org.handler`.
 *   2. Attach an execution role/policy allowing Scan + UpdateItem on the
 *      projects table only (least privilege — no other permissions needed).
 *   3. Set the PROJECTS_TABLE environment variable to the deployed table name.
 *   4. Use the "Test" tab with an empty `{}` event payload to invoke it, and
 *      check the returned scanned/updated/failed counts in the response and
 *      CloudWatch Logs.
 *   5. Delete the function once the backfill result shows failedIds is empty
 *      (or has been manually reconciled).
 *
 * This is a one-off migration: it does not need a permanent CDK Lambda
 * resource, a schedule, or EventBridge wiring — just apply it once per
 * environment, confirm the result, and tear the temporary function down.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Same fallback tenant name used by project-resolver.ts. Kept as a local
 * constant (rather than importing from project-resolver.ts) so this
 * standalone migration Lambda has no runtime dependency on the resolver
 * module — its only coupling to project-resolver is the value itself. */
const DEFAULT_ORGANIZATION = "Default";

function projectsTable(): string {
  return process.env.PROJECTS_TABLE ?? "";
}

export interface BackfillProjectOrgResult {
  /** Total items scanned across all pages. */
  scanned: number;
  /** Ids updated to organization: 'Default'. */
  updatedIds: string[];
  /** Ids that failed to update (logged, not thrown). */
  failedIds: string[];
}

/**
 * Scans the entire projects table (paginating through LastEvaluatedKey) and
 * backfills `organization: 'Default'` onto every item missing it.
 */
export async function backfillProjectOrg(): Promise<BackfillProjectOrgResult> {
  const result: BackfillProjectOrgResult = {
    scanned: 0,
    updatedIds: [],
    failedIds: [],
  };
  const tableName = projectsTable();

  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "attribute_not_exists(organization) OR organization = :nullVal",
        ExpressionAttributeValues: { ":nullVal": null },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const items = page.Items ?? [];
    result.scanned += items.length;

    for (const item of items) {
      const id = item.id as string | undefined;
      if (!id) {
        continue;
      }
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { id },
            UpdateExpression: "SET #organization = :org",
            ExpressionAttributeNames: { "#organization": "organization" },
            ExpressionAttributeValues: {
              ":org": DEFAULT_ORGANIZATION,
              ":nullVal": null,
            },
            // Defensive re-check: only stamp rows still missing/null org at
            // write time, so a concurrent createProject/updateProject that
            // has since set a real organization is never clobbered.
            ConditionExpression:
              "attribute_not_exists(organization) OR organization = :nullVal",
          }),
        );
        result.updatedIds.push(id);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          // Organization was set concurrently between scan and update — no
          // action needed, the row is already correctly scoped.
          continue;
        }
        console.error(
          `backfillProjectOrg: failed to update project "${id}":`,
          err,
        );
        result.failedIds.push(id);
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as
      | Record<string, NativeAttributeValue>
      | undefined;
  } while (exclusiveStartKey);

  console.log(
    JSON.stringify({
      handler: "backfill-project-org",
      scanned: result.scanned,
      updated: result.updatedIds.length,
      failed: result.failedIds.length,
      failedIds: result.failedIds,
    }),
  );

  return result;
}

export const handler = async (): Promise<BackfillProjectOrgResult> => {
  console.log("backfill-project-org: starting scan of", projectsTable());
  const result = await backfillProjectOrg();
  console.log(
    `backfill-project-org: complete — scanned ${result.scanned}, updated ${result.updatedIds.length}, failed ${result.failedIds.length}`,
  );
  return result;
};
