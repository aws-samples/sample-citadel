/**
 * environment-release-pointer-history-store.ts — READ-ONLY queries over
 * EnvironmentReleasePointerHistoryTable (G6 — "what ran in PROD on date
 * D").
 *
 * This module is the reader half of a deliberate writer/reader split,
 * mirroring release-store.ts (writer) vs release-gate-evidence.ts
 * (reader): the ONLY writer of the history table is
 * environment-release-pointer-store.ts, which appends a history row
 * inside the SAME TransactWriteItems as every pointer move (so the
 * time-series is gap-free and atomic with the authoritative pointer
 * state). This module issues NO writes — only Query — and must never
 * import a Put/Update/Delete command.
 *
 * Sort-key shape (set by the writer): PK orgId, SK
 * `${agentTargetId}#${environment}#${promotedAt}#${version}`, stored
 * under the `historySortKey` attribute. A `begins_with(historySortKey,
 * "${agentTargetId}#${environment}#")` KeyCondition plus a `<= "${...}#${D}"`
 * upper bound selects every move for that (agent, env) at or before D;
 * the greatest such row (latest promotedAt/version) is what was running
 * at D.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  EnvironmentLiteral,
  EnvironmentReleasePointerHistoryEntry,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function tableName(): string {
  return process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE!;
}

/** SK attribute name — kept in lock-step with the writer
 * (environment-release-pointer-store.ts's historySortKey). */
export const HISTORY_SORT_KEY_ATTR = "historySortKey";

/** The `${agentTargetId}#${environment}#` prefix every history row for
 * one (agent, env) shares — exported so the writer and reader compose
 * the identical prefix. */
export function historySortKeyPrefix(
  agentTargetId: string,
  environment: EnvironmentLiteral,
): string {
  return `${agentTargetId}#${environment}#`;
}

/**
 * Every history row for one (org, agent, environment), oldest→newest.
 * Optionally bounded to rows with promotedAt <= `until` (an ISO-8601
 * timestamp): the "what ran on date D" query.
 *
 * The `<= until#\uffff` upper bound (rather than `<= until#`) ensures a
 * row promoted exactly at `until` — whose SK is
 * `agent#env#until#<version>` — is INCLUDED, since any version suffix
 * sorts before `\uffff`. Without the sentinel, `agent#env#until#3` would
 * sort AFTER `agent#env#until` and be excluded on an exact-boundary
 * match.
 */
export async function queryEnvironmentReleasePointerHistory(
  orgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
  until?: string,
): Promise<EnvironmentReleasePointerHistoryEntry[]> {
  const prefix = historySortKeyPrefix(agentTargetId, environment);

  const expressionAttributeValues: Record<string, unknown> = {
    ":oid": orgId,
    ":prefix": prefix,
  };
  let keyConditionExpression =
    "orgId = :oid AND begins_with(historySortKey, :prefix)";

  if (until !== undefined) {
    // Range from the prefix (inclusive lower) up to `until` plus a
    // high-sentinel version suffix (inclusive of any move AT `until`).
    keyConditionExpression =
      "orgId = :oid AND historySortKey BETWEEN :prefix AND :upper";
    expressionAttributeValues[":upper"] = `${prefix}${until}#\uffff`;
  }

  const res = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      // Ascending SK order — the caller takes the LAST element for the
      // "latest ≤ D" answer.
      ScanIndexForward: true,
    }),
  );
  return (
    (res.Items as EnvironmentReleasePointerHistoryEntry[] | undefined) ?? []
  );
}

/**
 * "What release was running in `environment` at date `until`" — the
 * greatest (latest promotedAt/version) history row at or before `until`,
 * or null when nothing had been promoted to that env by then.
 */
export async function environmentReleaseRunningAt(
  orgId: string,
  agentTargetId: string,
  environment: EnvironmentLiteral,
  until: string,
): Promise<EnvironmentReleasePointerHistoryEntry | null> {
  const rows = await queryEnvironmentReleasePointerHistory(
    orgId,
    agentTargetId,
    environment,
    until,
  );
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}
