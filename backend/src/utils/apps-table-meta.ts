/**
 * Eventually-consistent write helpers for the AppsTable metadata row.
 *
 * The AppsTable schema (see backend-stack.ts) declares ONLY a partition key
 * `appId` — there is no sort key. The legacy convention in this codebase
 * (visible in app-publish-handler.ts and app-api-key-management.ts) is:
 *
 *   - App metadata row : Key = { appId: '<bare appId>' },
 *                        with a data attribute `sortId: 'METADATA'`.
 *   - API key rows     : Key = { appId: '<appId>#APIKEY#<keyId>' },
 *                        with a data attribute `sortId: 'APIKEY#<keyId>'`.
 *   - Component rows   : same composite-string PK pattern.
 *
 * The OrgIndex GSI (PK=orgId, SK=createdAt) only includes rows that have
 * BOTH `orgId` AND `createdAt` attributes. Metadata rows do; API/component
 * rows don't, so they auto-exclude from OrgIndex queries.
 *
 * These helpers maintain the metadata row (the one carrying the projection
 * required by `listApps`). Failures log and return false; they do NOT
 * throw. The Registry remains the source of truth; a separate reconciler
 * script catches drift.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

let _docClient: DynamoDBDocumentClient | undefined;
function docClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _docClient;
}

/**
 * Value of the `sortId` data attribute on the metadata row. Other row
 * families on the same table use other prefixes (e.g. APIKEY#, AGENT#,
 * CONFIG#) — kept here only so callers can filter scans/queries.
 *
 * NOTE: this is NOT a key component. The AppsTable has a single-attribute
 * partition key (`appId`) and no sort key.
 */
export const APP_META_SORT_VALUE = 'METADATA';

export interface AppMetaRow {
  appId: string;
  orgId: string;
  name: string;
  description?: string;
  status: string;
  workflowIds?: string[];
  routingConfig?: string; // serialised JSON
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * Upserts the metadata row for an app. Uses UpdateCommand (not Put) so the
 * operation PRESERVES any attributes the legacy app-publish-handler /
 * app-component-registration-handler / fabricator-request-resolver may
 * have written to the same row. Returns true on success, false on any
 * failure (failure is logged).
 */
export async function upsertAppMeta(
  tableName: string,
  meta: AppMetaRow,
): Promise<boolean> {
  if (!tableName) {
    console.warn('upsertAppMeta: empty tableName, skipping');
    return false;
  }
  // Deterministic field order keeps the UpdateExpression stable for tests.
  const fields: Array<[string, unknown]> = [
    ['orgId', meta.orgId],
    ['name', meta.name],
    ['description', meta.description ?? ''],
    ['status', meta.status],
    ['workflowIds', meta.workflowIds ?? []],
    ['routingConfig', meta.routingConfig ?? ''],
    ['createdBy', meta.createdBy],
    ['createdAt', meta.createdAt],
    ['updatedAt', meta.updatedAt],
    ['version', meta.version],
    ['sortId', APP_META_SORT_VALUE],
    ['groupId', `APP#${meta.appId}`],
  ];
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of fields) {
    const nameAlias = `#k_${key}`;
    const placeholder = `:v_${key}`;
    sets.push(`${nameAlias} = ${placeholder}`);
    names[nameAlias] = key;
    values[placeholder] = value;
  }
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { appId: meta.appId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    console.warn('upsertAppMeta: failed (eventually-consistent, reconciler will recover)', {
      tableName,
      appId: meta.appId,
      err: String(err),
    });
    return false;
  }
}

/**
 * Updates a subset of fields on the metadata row. Only fields actually
 * present in `partial` are written, matching DynamoDB UpdateExpression
 * semantics. Always bumps `updatedAt` to the supplied value.
 */
export async function updateAppMetaFields(
  tableName: string,
  appId: string,
  partial: Partial<Omit<AppMetaRow, 'appId' | 'createdAt' | 'createdBy'>>,
): Promise<boolean> {
  if (!tableName || !appId) {
    console.warn('updateAppMetaFields: missing tableName or appId, skipping');
    return false;
  }
  const allowed: Array<keyof typeof partial> = [
    'orgId',
    'name',
    'description',
    'status',
    'workflowIds',
    'routingConfig',
    'updatedAt',
    'version',
  ];
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  for (const key of allowed) {
    if (partial[key] === undefined) continue;
    const placeholder = `:v_${key}`;
    const nameAlias = `#k_${key}`;
    sets.push(`${nameAlias} = ${placeholder}`);
    values[placeholder] = partial[key];
    names[nameAlias] = key as string;
  }
  if (sets.length === 0) return true;
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { appId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    console.warn('updateAppMetaFields: failed (eventually-consistent)', {
      tableName,
      appId,
      err: String(err),
    });
    return false;
  }
}

/**
 * Deletes the metadata row for an app. Other app-scoped rows (API keys,
 * components, etc.) live under different composite-string PKs and are
 * untouched — use the existing per-domain helpers for those.
 */
export async function deleteAppMeta(tableName: string, appId: string): Promise<boolean> {
  if (!tableName || !appId) {
    console.warn('deleteAppMeta: missing tableName or appId, skipping');
    return false;
  }
  try {
    await docClient().send(
      new DeleteCommand({
        TableName: tableName,
        Key: { appId },
      }),
    );
    return true;
  } catch (err) {
    console.warn('deleteAppMeta: failed (eventually-consistent)', {
      tableName,
      appId,
      err: String(err),
    });
    return false;
  }
}
