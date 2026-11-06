/**
 * Shared detection + merge-only writer for seeder-owned DynamoDB cache rows.
 *
 * A seeder-owned row is one written by the arbiter seedConfig custom resource:
 *   - createdBy === 'seedConfig'
 *   - projectionVersion is present (the seedConfig handler sets it)
 *
 * When a script encounters such a row, it must NEVER overwrite it with a
 * PutCommand. Instead, only non-ownership fields (status, approval, timestamps)
 * may be updated via UpdateCommand — config, orgId, citadelKind, and
 * projectionVersion must be preserved.
 *
 * Shared by: backfill-list-projection.ts (and any future script that writes
 * agent/tool projection rows). registry-sync.ts has its own inline guard
 * (syncSeederOwnedRow) because it runs in Lambda, not in scripts.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Detects whether a DynamoDB item is a seeder-owned canonical row.
 *
 * A row is seeder-owned when both conditions hold:
 *   1. createdBy === 'seedConfig'
 *   2. projectionVersion is present (not undefined/null)
 *
 * This matches the detection logic in registry-sync's handleGaUpsert seeder
 * guard and reconcile-seeded-rows' isSeederOwnedRecordIdRow (minus the
 * recordId shape check, since this guard applies to any key shape).
 */
export function isSeederOwnedRow(item: Record<string, unknown>): boolean {
  return item.createdBy === "seedConfig" && item.projectionVersion != null;
}

/**
 * Fields that a merge-only update is allowed to SET on a seeder-owned row.
 * Config, orgId, citadelKind, and projectionVersion are deliberately excluded.
 */
const MERGE_FIELDS = [
  "registryStatus",
  "statusUpdatedAt",
  "registryRecordId",
  "state",
  "decidedBy",
  "decidedAt",
  "statusReason",
  "updatedAt",
  "projectedAt",
] as const;

export interface MergeOnlySource {
  registryStatus?: string;
  state?: string;
  registryRecordId?: string;
  decidedBy?: string;
  decidedAt?: string;
  statusReason?: string;
  [key: string]: unknown;
}

/**
 * Performs a merge-only UpdateCommand on a seeder-owned row: updates ONLY
 * approval/status/timestamp fields, preserving config, orgId, citadelKind,
 * and projectionVersion.
 *
 * @param dryRun When true, logs but does not write; returns true.
 * @returns true if the update was applied (or would be in dry-run).
 */
export async function mergeOnlySeederRow(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, string>,
  source: MergeOnlySource,
  dryRun: boolean,
): Promise<boolean> {
  const keyStr = JSON.stringify(key);
  const now = new Date().toISOString();

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setClauses: string[] = [];

  // Always set updatedAt and projectedAt
  names["#updatedAt"] = "updatedAt";
  values[":updatedAt"] = now;
  setClauses.push("#updatedAt = :updatedAt");

  names["#projectedAt"] = "projectedAt";
  values[":projectedAt"] = now;
  setClauses.push("#projectedAt = :projectedAt");

  for (const field of MERGE_FIELDS) {
    if (field === "updatedAt" || field === "projectedAt") continue; // already handled
    const val = source[field];
    if (val !== undefined && val !== null) {
      names[`#${field}`] = field;
      values[`:${field}`] = val;
      setClauses.push(`#${field} = :${field}`);
    }
  }

  if (dryRun) {
    console.log(`seeder-owned: merge-only ${keyStr} (dry-run)`);
    return true;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
  console.log(`seeder-owned: merge-only ${keyStr}`);
  return true;
}
