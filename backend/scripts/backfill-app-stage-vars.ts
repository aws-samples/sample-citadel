/**
 * Backfill: stamp StageVariables.appId onto the $default stage of every
 * PUBLISHED app's existing API Gateway (Gap1 rollout).
 *
 * Apps published BEFORE the app-invoke-path fix have a $default stage with
 * no StageVariables, so `$context.authorizer.appId` (consumed by the new
 * app-invoke-handler via the EventBridge integration's Resources
 * RequestParameters) resolves to empty for those APIs until this backfill
 * runs. New publishes already get the stage variable from
 * provisionApiGateway.
 *
 * Chosen approach: idempotent `UpdateStageCommand` reconciler (this script).
 * Rejected: re-publish, because unpublishApp/publishApp rotates the default
 * API key and the endpoint — an unacceptable disruption for a metadata-only
 * fix. This script performs NO key rotation and NO downtime; it only sets a
 * stage variable on the existing $default stage.
 *
 * Recon-first: always runs a read-only pass and logs a per-app plan before
 * any write. `--apply` is required to actually call UpdateStageCommand;
 * default is dry-run.
 *
 * Idempotent: if StageVariables.appId is already correct, the app is
 * skipped (no API call). Safe to re-run.
 *
 * Usage:
 *   ts-node backend/scripts/backfill-app-stage-vars.ts --dry-run   (default)
 *   ts-node backend/scripts/backfill-app-stage-vars.ts --apply
 *
 * Required env:
 *   APPS_TABLE   – DynamoDB table name for apps (citadel-apps-{env})
 *   AWS_REGION   – optional, defaults to us-east-1
 */
import {
  ApiGatewayV2Client,
  GetStageCommand,
  UpdateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishedApp {
  appId: string;
  apiId: string;
}

export interface BackfillOptions {
  apply: boolean;
}

export interface BackfillSummary {
  mode: "dry-run" | "apply";
  scanned: number;
  eligible: number;
  alreadySet: number;
  fixed: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[backfill-app-stage-vars] ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scans the apps table for PUBLISHED #META rows that have an apiId.
 * Apps without an apiId (never published, or unpublished/torn down) are
 * skipped — there is no API Gateway to update.
 */
async function findPublishedAppsWithApi(
  docClient: DynamoDBDocumentClient,
  appsTable: string,
): Promise<PublishedApp[]> {
  const results: PublishedApp[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: appsTable,
        FilterExpression:
          "sortId = :meta AND #status = :published AND attribute_exists(apiId)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":meta": "METADATA",
          ":published": "PUBLISHED",
        },
        ExclusiveStartKey,
      }),
    );

    for (const item of page.Items || []) {
      if (
        typeof item.appId === "string" &&
        typeof item.apiId === "string" &&
        item.apiId
      ) {
        results.push({ appId: item.appId, apiId: item.apiId });
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (ExclusiveStartKey);

  return results;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Runs the recon-then-apply backfill and returns a structured summary.
 * Per-app errors are logged and swallowed — one bad API/apiId never aborts
 * the run for the rest of the apps.
 */
export async function runBackfill(
  options: BackfillOptions,
  deps: {
    docClient: DynamoDBDocumentClient;
    apiGwClient: ApiGatewayV2Client;
    appsTable: string;
  },
): Promise<BackfillSummary> {
  const { apply } = options;
  const dryRun = !apply;

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);

  const summary: BackfillSummary = {
    mode: dryRun ? "dry-run" : "apply",
    scanned: 0,
    eligible: 0,
    alreadySet: 0,
    fixed: 0,
    errors: 0,
  };

  const apps = await findPublishedAppsWithApi(deps.docClient, deps.appsTable);
  summary.scanned = apps.length;

  for (const app of apps) {
    try {
      summary.eligible += 1;

      const stage = await deps.apiGwClient.send(
        new GetStageCommand({
          ApiId: app.apiId,
          StageName: "$default",
        }),
      );

      const currentAppId = stage.StageVariables?.appId;
      if (currentAppId === app.appId) {
        summary.alreadySet += 1;
        log(
          "info",
          `SKIP ${app.appId} (apiId=${app.apiId}) — StageVariables.appId already correct`,
        );
        continue;
      }

      log(
        "info",
        `${dryRun ? "WOULD SET" : "SETTING"} ${app.appId} (apiId=${app.apiId}) — ` +
          `StageVariables.appId: ${currentAppId ?? "<unset>"} -> ${app.appId}`,
      );

      if (apply) {
        await deps.apiGwClient.send(
          new UpdateStageCommand({
            ApiId: app.apiId,
            StageName: "$default",
            StageVariables: { appId: app.appId },
          }),
        );
        summary.fixed += 1;
      }
    } catch (error: unknown) {
      summary.errors += 1;
      log(
        "error",
        `FAILED ${app.appId} (apiId=${app.apiId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  log(
    "info",
    `Summary: scanned=${summary.scanned} eligible=${summary.eligible} ` +
      `alreadySet=${summary.alreadySet} fixed=${summary.fixed} errors=${summary.errors}`,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const appsTable = process.env.APPS_TABLE;
  if (!appsTable) throw new Error("APPS_TABLE env var required");
  const region = process.env.AWS_REGION || "us-east-1";

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const apiGwClient = new ApiGatewayV2Client({ region });

  const summary = await runBackfill(
    { apply },
    { docClient, apiGwClient, appsTable },
  );

  if (summary.errors > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    log(
      "error",
      `Fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
