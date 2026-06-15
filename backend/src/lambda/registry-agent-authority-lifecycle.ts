/**
 * US-ARB-014 per-app (per-registryId during the AgentApp → RegistryAgentRecord
 * migration) fabricator authority unit lifecycle. Previously lived in
 * backend/src/lambda/app-resolver.ts; migrated to its own governance-owned
 * module in PR 3 of the AgentCore Registry governance retrofit so the
 * registry-native resolver (registry-agent-record-resolver.ts) and any
 * future create/delete path can grant and revoke via a single entry point.
 *
 * PR 6a renamed this module from `agent-app-authority-lifecycle.ts` to
 * `registry-agent-authority-lifecycle.ts` alongside the `type AgentApp` →
 * `type RegistryAgentRecord` schema rename. Function exports and wire
 * contract are unchanged.
 *
 * Decision #9: DDB column written is `registryId` (the value remains the
 * appId string for the duration of the migration). The exported function
 * signatures keep the `appId` parameter name to avoid a cascade rename in
 * callers.
 *
 * Contract preserved from app-resolver.ts:
 *   - getAuthorityUnitsTable() reads AUTHORITY_UNITS_TABLE env var at call
 *     time; returns `undefined` gracefully when unset (partial-deploy safe).
 *   - grantFabricatorAuthority(appId) uses ConditionExpression
 *     `attribute_not_exists(unitId)` so duplicate writes are safely idempotent.
 *   - revokeFabricatorAuthority(appId) uses
 *     `attribute_exists(unitId) AND revoked = :false` so revoking twice
 *     does not overwrite `revokedAt` on an already-revoked row.
 *
 * This module is self-contained: it does not import from app-resolver.ts
 * and constructs its own DynamoDBDocumentClient lazily on first use.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// Lazy singleton DynamoDBDocumentClient. Constructed on first use so that
// unit tests that never invoke the authority hooks (e.g. AUTHORITY_UNITS_TABLE
// unset) do not incur SDK client construction cost, and so that tests which
// mock @aws-sdk/lib-dynamodb can do so before the first call.
let _docClient: DynamoDBDocumentClient | undefined;
function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _docClient;
}

// US-ARB-014: Per-app fabricator authority unit lifecycle. The AuthorityUnitsTable
// is defined on ArbiterStack (public readonly). We reference it by env var here
// rather than taking a cross-stack construct dependency. If the env var is unset
// (e.g. in unit-test environments without the arbiter stack), we log a WARN and
// skip the authority write — consistent with the best-effort pattern used by the
// governance notifier. Read at call-time (not module-load time) so tests can
// toggle the env var between cases.
export function getAuthorityUnitsTable(): string | undefined {
  return process.env.AUTHORITY_UNITS_TABLE;
}

export async function grantFabricatorAuthority(appId: string): Promise<void> {
  const tableName = getAuthorityUnitsTable();
  if (!tableName) {
    console.warn('AUTHORITY_UNITS_TABLE unset; skipping fabricator authority grant for app', appId);
    return;
  }
  const now = new Date().toISOString();
  try {
    // registryId column name per Decision #9; value is the appId string during the AgentApp → RegistryAgentRecord deprecation window
    await getDocClient().send(new PutCommand({
      TableName: tableName,
      Item: {
        unitId: `fabricator-${appId}-create-agents`,
        agentId: 'fabricator',
        registryId: appId,
        scope: {
          decision_type: 'create_agent',
          domain: '*',
          conditions: { target_app_id: appId },
          limits: {},
        },
        riskRating: 'low',
        revoked: false,
        createdAt: now,
        createdBy: `app-resolver:createApp:${appId}`,
      },
      ConditionExpression: 'attribute_not_exists(unitId)',
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.warn('Authority unit already exists for app', appId);
      return;
    }
    throw err;
  }
}

export async function revokeFabricatorAuthority(appId: string): Promise<void> {
  const tableName = getAuthorityUnitsTable();
  if (!tableName) {
    console.warn('AUTHORITY_UNITS_TABLE unset; skipping fabricator authority revoke for app', appId);
    return;
  }
  const now = new Date().toISOString();
  try {
    await getDocClient().send(new UpdateCommand({
      TableName: tableName,
      Key: { unitId: `fabricator-${appId}-create-agents` },
      UpdateExpression: 'SET revoked = :true, revokedAt = :now',
      ExpressionAttributeValues: {
        ':true': true,
        ':now': now,
        ':false': false,
      },
      ConditionExpression: 'attribute_exists(unitId) AND revoked = :false',
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.warn('Authority unit not found or already revoked for app', appId);
      return;
    }
    throw err;
  }
}
