/**
 * App API Authorizer — Lambda authorizer for per-app API Gateway endpoints.
 *
 * Validates x-api-key header against hashed API key records in DynamoDB.
 * Uses API Gateway Lambda authorizer v2 format (simple response).
 *
 * Authorization flow:
 * 1. Extract appId from stage variables
 * 2. Hash provided x-api-key with SHA-256
 * 3. Query GroupIndex for APIKEY# items under APP#{appId}
 * 4. Match by hashedKey, check status === ACTIVE and not expired
 * 5. Return { isAuthorized: true/false }
 * 6. Update lastUsedAt asynchronously (best-effort)
 * 7. Log all attempts for audit
 *
 * Requirements: 3.2, 3.3, 3.4, 3.8, 3.9
 */
import { createHash } from 'crypto';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// ── Types ───────────────────────────────────────────────────

export interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: {
    http?: { sourceIp?: string };
    stage?: string;
    apiId?: string;
  };
  stageVariables?: Record<string, string>;
}

export interface SimpleAuthorizerResult {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

export interface AuditLogEntry {
  appId: string;
  apiKeyId: string;
  sourceIp: string;
  timestamp: string;
  result: 'allow' | 'deny';
}

// ── SDK Client (lazy-initialized) ───────────────────────────

const APPS_TABLE = process.env.APPS_TABLE || 'citadel-apps-dev';

let _docClient: DynamoDBDocumentClient | undefined;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _docClient;
}

// ── Audit Logger ────────────────────────────────────────────

function logAudit(entry: AuditLogEntry): void {
  console.log(JSON.stringify(entry));
}

// ── Authorization Decision (pure logic) ─────────────────────

/**
 * Pure authorization decision based on key status and expiry.
 * Returns 'allow' if key is ACTIVE and not expired, 'deny' otherwise.
 * This function has no side effects and depends only on key state.
 */
export function evaluateKeyAuthorization(
  matchedKey: { status: string; expiresAt?: string; keyId?: string } | undefined,
): 'allow' | 'deny' {
  if (!matchedKey) return 'deny';
  if (matchedKey.status !== 'ACTIVE') return 'deny';
  if (matchedKey.expiresAt && new Date(matchedKey.expiresAt) <= new Date()) return 'deny';
  return 'allow';
}

// ── Handler ─────────────────────────────────────────────────

/**
 * Lambda authorizer handler (v2 simple response format).
 *
 * Extracts appId from stage variables, hashes the x-api-key,
 * queries DynamoDB for matching APIKEY# items, and returns
 * isAuthorized based on key status and expiry.
 */
export const handler = async (
  event: AuthorizerEvent,
  _context?: unknown,
  deps: { docClient?: DynamoDBDocumentClient; appsTable?: string } = {},
): Promise<SimpleAuthorizerResult> => {
  const docClient = deps.docClient || getDocClient();
  const appsTable = deps.appsTable || APPS_TABLE;
  const appId = event.stageVariables?.appId || '';
  const sourceIp = event.requestContext?.http?.sourceIp || 'unknown';
  const apiKey = event.headers?.['x-api-key'];

  // Missing or empty x-api-key → 401 Unauthorized
  if (!apiKey) {
    logAudit({
      appId,
      apiKeyId: 'unknown',
      sourceIp,
      timestamp: new Date().toISOString(),
      result: 'deny',
    });
    throw new Error('Unauthorized');
  }

  // Hash the provided key
  const hashedKey = createHash('sha256').update(apiKey).digest('hex');

  try {
    // Query GroupIndex for APIKEY# items under APP#{appId}
    const result = await docClient.send(new QueryCommand({
      TableName: appsTable,
      IndexName: 'GroupIndex',
      KeyConditionExpression: 'groupId = :gid AND begins_with(sortId, :sk)',
      ExpressionAttributeValues: {
        ':gid': `APP#${appId}`,
        ':sk': 'APIKEY#',
      },
    }));

    const items = result.Items || [];

    // Find matching key by hash
    const matchedKey = items.find((item) => item.hashedKey === hashedKey) as
      | { status: string; expiresAt?: string; keyId?: string; appId?: string }
      | undefined;

    // Evaluate authorization using pure decision logic
    const decision = evaluateKeyAuthorization(matchedKey);

    logAudit({
      appId,
      apiKeyId: matchedKey?.keyId || 'unknown',
      sourceIp,
      timestamp: new Date().toISOString(),
      result: decision,
    });

    if (decision === 'deny') {
      return { isAuthorized: false };
    }

    // Best-effort async update of lastUsedAt
    docClient.send(new UpdateCommand({
      TableName: appsTable,
      Key: { appId: matchedKey!.appId },
      UpdateExpression: 'SET lastUsedAt = :now',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
      },
    })).catch(() => {
      // Best-effort — swallow errors silently
    });

    return {
      isAuthorized: true,
      context: {
        appId,
        apiKeyId: matchedKey!.keyId as string,
      },
    };
  } catch (error) {
    // DynamoDB failure → fail closed (deny)
    logAudit({
      appId,
      apiKeyId: 'unknown',
      sourceIp,
      timestamp: new Date().toISOString(),
      result: 'deny',
    });
    return { isAuthorized: false };
  }
};
