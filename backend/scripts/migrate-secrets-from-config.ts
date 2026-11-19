/**
 * One-time migration: move secret-like fields from DynamoDB `config` column
 * into Secrets Manager, then strip them from config.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-secrets-from-config.ts [--apply]
 *
 * Env vars:
 *   DATASTORES_TABLE  — required, the DynamoDB table name
 *   AWS_REGION        — required, or --region flag
 *
 * Flags:
 *   --apply           — actually write changes (default: dry-run)
 *   --region <r>      — override AWS_REGION
 *
 * Dry-run (default) scans the table and reports which rows would be migrated.
 * --apply creates/updates Secrets Manager secrets and strips config.
 *
 * Idempotent: rows whose config contains no SECRET_FIELD_KEYS are skipped.
 * Rows that already have a secretArn AND no leaked keys are skipped.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  ResourceExistsException,
} from "@aws-sdk/client-secrets-manager";

const SECRET_FIELD_KEYS = new Set([
  "masterPassword",
  "password",
  "apiKey",
  "connectionString",
  "token",
  "secretAccessKey",
  "sessionToken",
]);

const CREDENTIAL_ADJACENT_KEYS = new Set(["masterUsername", "username"]);

function parseArgs(): { apply: boolean; region: string; table: string } {
  const args = process.argv.slice(2);
  let apply = false;
  let region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
  const table = process.env.DATASTORES_TABLE || "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    if (args[i] === "--region" && args[i + 1]) {
      region = args[i + 1];
      i++;
    }
  }

  if (!region) {
    console.error("Region required: pass --region or set AWS_REGION");
    process.exit(2);
  }
  if (!table) {
    console.error("Fatal: DATASTORES_TABLE env var is required");
    process.exit(1);
  }

  return { apply, region, table };
}

interface MigrationRow {
  dataStoreId: string;
  orgId?: string;
  type?: string;
  config: string | Record<string, unknown>;
  secretArn?: string;
}

async function main() {
  const { apply, region, table } = parseArgs();
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[${mode}] Scanning ${table} for secret-like fields in config...`,
  );

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sm = new SecretsManagerClient({ region });

  let scanned = 0;
  let migrated = 0;
  let alreadyClean = 0;
  let errors = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of (result.Items || []) as MigrationRow[]) {
      scanned++;
      const dsId = item.dataStoreId;
      const configStr =
        typeof item.config === "string"
          ? item.config
          : JSON.stringify(item.config);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(configStr);
      } catch {
        console.log(`  SKIP ${dsId}: config is not valid JSON`);
        continue;
      }

      // Find leaked secret keys
      const leakedSecrets: Record<string, unknown> = {};
      const leakedAdjacent: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config)) {
        if (SECRET_FIELD_KEYS.has(key)) {
          leakedSecrets[key] = value;
        } else if (CREDENTIAL_ADJACENT_KEYS.has(key)) {
          leakedAdjacent[key] = value;
        }
      }

      if (Object.keys(leakedSecrets).length === 0) {
        alreadyClean++;
        continue;
      }

      const secretData = { ...leakedSecrets, ...leakedAdjacent };
      const secretName = `/citadel/datastores/${item.orgId || "unknown"}/${item.type || "unknown"}-${dsId}`;

      console.log(
        `  ${dsId}: ${Object.keys(leakedSecrets).join(", ")} found in config → ${apply ? "migrating" : "would migrate"} to ${secretName}`,
      );

      if (!apply) {
        migrated++;
        continue;
      }

      try {
        // Create or update the secret
        let secretArn: string;
        try {
          const createResult = await sm.send(
            new CreateSecretCommand({
              Name: secretName,
              SecretString: JSON.stringify(secretData),
              Description: `Citadel datastore credentials for ${dsId}`,
            }),
          );
          secretArn = createResult.ARN!;
        } catch (err) {
          if (err instanceof ResourceExistsException) {
            await sm.send(
              new UpdateSecretCommand({
                SecretId: secretName,
                SecretString: JSON.stringify(secretData),
              }),
            );
            secretArn = item.secretArn || secretName;
          } else {
            throw err;
          }
        }

        // Strip secret keys from config
        const cleanConfig = { ...config };
        for (const key of [...SECRET_FIELD_KEYS, ...CREDENTIAL_ADJACENT_KEYS]) {
          delete cleanConfig[key];
        }

        // Update DynamoDB: clean config + secretArn
        await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: { dataStoreId: dsId },
            UpdateExpression:
              "SET config = :config, secretArn = :arn, updatedAt = :now",
            ExpressionAttributeValues: {
              ":config": JSON.stringify(cleanConfig),
              ":arn": secretArn,
              ":now": new Date().toISOString(),
            },
          }),
        );

        migrated++;
        console.log(`  ✓ ${dsId}: migrated`);
      } catch (err) {
        errors++;
        console.error(`  ERROR ${dsId}:`, err);
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  console.log(
    `\n[${mode}] Done. Scanned: ${scanned}, migrated: ${migrated}, already clean: ${alreadyClean}, errors: ${errors}`,
  );
  if (!apply && migrated > 0) {
    console.log("Re-run with --apply to execute the migration.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
