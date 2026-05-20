/**
 * App API Key Management — CRUD operations for API keys.
 *
 * Functions: createAppApiKey, revokeAppApiKey, rotateAppApiKey, listAppApiKeys
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
 */
import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

export interface ApiKeyDeps {
  docClient: DynamoDBDocumentClient;
  eventBridgeClient: EventBridgeClient;
  appsTable: string;
  eventBusName: string;
}

export interface CreateApiKeyResult {
  keyId: string;
  name: string;
  plaintext: string;
  prefix: string;
  hashedKey: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

export interface RevokeApiKeyResult {
  keyId: string;
  name: string;
  prefix: string;
  status: string;
  createdAt: string;
}

export interface RotateApiKeyResult {
  newKey: CreateApiKeyResult;
  revokedKeyId: string;
}

export interface ApiKeyListItem {
  keyId: string;
  name: string;
  prefix: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

const MAX_ACTIVE_KEYS = 10;

/**
 * Generates a cryptographically random API key.
 * Reuses the same algorithm as generateApiKey in app-publish-handler.ts.
 */
function generateKey(): { plaintext: string; hashed: string; prefix: string; keyId: string } {
  const keyBytes = randomBytes(32);
  const plaintext = keyBytes.toString('base64url');
  const hashed = createHash('sha256').update(plaintext).digest('hex');
  const prefix = plaintext.substring(0, 8);
  const keyId = uuidv4();
  return { plaintext, hashed, prefix, keyId };
}

/**
 * Queries all APIKEY# items for an app via GroupIndex.
 */
async function queryApiKeys(
  appId: string,
  deps: ApiKeyDeps,
): Promise<Array<Record<string, any>>> {
  const result = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid AND begins_with(sortId, :sk)',
    ExpressionAttributeValues: {
      ':gid': `APP#${appId}`,
      ':sk': 'APIKEY#',
    },
  }));
  return result.Items || [];
}

/**
 * Emits an EventBridge event for API key lifecycle changes.
 */
async function emitApiKeyEvent(
  detailType: string,
  detail: Record<string, any>,
  deps: ApiKeyDeps,
): Promise<void> {
  await deps.eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'citadel.apps',
      DetailType: detailType,
      Detail: JSON.stringify({
        ...detail,
        timestamp: new Date().toISOString(),
      }),
      EventBusName: deps.eventBusName,
    }],
  }));
}

/**
 * Creates a new API key for an app.
 *
 * - Generates 32-byte random key → base64url plaintext, SHA-256 hex hash, 8-char prefix
 * - Enforces max 10 active keys per app
 * - Stores as APIKEY#{keyId} component item under app's groupId
 * - Emits app.apikey.created EventBridge event
 * - Returns plaintext exactly once
 *
 * Requirements: 5.1, 5.3, 5.4, 5.7, 5.8, 5.9
 */
export async function createAppApiKey(
  appId: string,
  name: string,
  userId: string,
  deps: ApiKeyDeps,
  expiresIn?: number,
): Promise<CreateApiKeyResult> {
  // Query existing keys to enforce max active limit
  const existingKeys = await queryApiKeys(appId, deps);
  const activeCount = existingKeys.filter(k => k.status === 'ACTIVE').length;

  if (activeCount >= MAX_ACTIVE_KEYS) {
    throw new Error(`Maximum of ${MAX_ACTIVE_KEYS} active API keys reached. Revoke an existing key first.`);
  }

  const key = generateKey();
  const now = new Date().toISOString();

  const item: Record<string, any> = {
    appId: `${appId}#APIKEY#${key.keyId}`,
    groupId: `APP#${appId}`,
    sortId: `APIKEY#${key.keyId}`,
    keyId: key.keyId,
    name,
    hashedKey: key.hashed,
    prefix: key.prefix,
    status: 'ACTIVE',
    createdAt: now,
  };

  if (expiresIn !== undefined) {
    item.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  await deps.docClient.send(new PutCommand({
    TableName: deps.appsTable,
    Item: item,
  }));

  // Emit EventBridge event
  await emitApiKeyEvent('app.apikey.created', {
    appId,
    keyId: key.keyId,
    keyName: name,
    userId,
  }, deps);

  return {
    keyId: key.keyId,
    name,
    plaintext: key.plaintext,
    prefix: key.prefix,
    hashedKey: key.hashed,
    status: 'ACTIVE',
    createdAt: now,
    expiresAt: item.expiresAt,
  };
}

/**
 * Revokes an API key by setting its status to REVOKED.
 * Idempotent: revoking an already-revoked key returns success without modification.
 *
 * Requirements: 5.5, 5.9
 */
export async function revokeAppApiKey(
  appId: string,
  keyId: string,
  userId: string,
  deps: ApiKeyDeps,
): Promise<RevokeApiKeyResult> {
  const existingKeys = await queryApiKeys(appId, deps);
  const keyItem = existingKeys.find(k => k.keyId === keyId);

  if (!keyItem) {
    throw new Error(`API key not found: ${keyId}`);
  }

  // Idempotent: already revoked → return current state
  if (keyItem.status === 'REVOKED') {
    return {
      keyId: keyItem.keyId,
      name: keyItem.name,
      prefix: keyItem.prefix || '',
      status: 'REVOKED',
      createdAt: keyItem.createdAt || new Date().toISOString(),
    };
  }

  await deps.docClient.send(new UpdateCommand({
    TableName: deps.appsTable,
    Key: { appId: `${appId}#APIKEY#${keyId}` },
    UpdateExpression: 'SET #status = :REVOKED, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':REVOKED': 'REVOKED',
      ':now': new Date().toISOString(),
    },
  }));

  // Emit EventBridge event
  await emitApiKeyEvent('app.apikey.revoked', {
    appId,
    keyId,
    keyName: keyItem.name,
    userId,
  }, deps);

  return {
    keyId: keyItem.keyId,
    name: keyItem.name,
    prefix: keyItem.prefix || '',
    status: 'REVOKED',
    createdAt: keyItem.createdAt || new Date().toISOString(),
  };
}

/**
 * Rotates an API key: creates a new key and revokes the old one atomically
 * using DynamoDB TransactWriteItems.
 *
 * Requirements: 5.6
 */
export async function rotateAppApiKey(
  appId: string,
  keyId: string,
  userId: string,
  deps: ApiKeyDeps,
): Promise<RotateApiKeyResult> {
  const existingKeys = await queryApiKeys(appId, deps);
  const oldKeyItem = existingKeys.find(k => k.keyId === keyId);

  if (!oldKeyItem) {
    throw new Error(`API key not found: ${keyId}`);
  }

  if (oldKeyItem.status === 'REVOKED') {
    throw new Error(`Cannot rotate a revoked key: ${keyId}`);
  }

  const newKey = generateKey();
  const now = new Date().toISOString();

  const newKeyItem: Record<string, any> = {
    appId: `${appId}#APIKEY#${newKey.keyId}`,
    groupId: `APP#${appId}`,
    sortId: `APIKEY#${newKey.keyId}`,
    keyId: newKey.keyId,
    name: oldKeyItem.name,
    hashedKey: newKey.hashed,
    prefix: newKey.prefix,
    status: 'ACTIVE',
    createdAt: now,
  };

  // Atomic transaction: put new key + revoke old key
  await deps.docClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: deps.appsTable,
          Item: newKeyItem,
        },
      },
      {
        Update: {
          TableName: deps.appsTable,
          Key: { appId: `${appId}#APIKEY#${keyId}` },
          UpdateExpression: 'SET #status = :REVOKED, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':REVOKED': 'REVOKED',
            ':now': now,
          },
        },
      },
    ],
  }));

  return {
    newKey: {
      keyId: newKey.keyId,
      name: oldKeyItem.name,
      plaintext: newKey.plaintext,
      prefix: newKey.prefix,
      hashedKey: newKey.hashed,
      status: 'ACTIVE',
      createdAt: now,
    },
    revokedKeyId: keyId,
  };
}

/**
 * Lists all API keys for an app (without plaintext or hashed values).
 *
 * Requirements: 5.2
 */
export async function listAppApiKeys(
  appId: string,
  deps: ApiKeyDeps,
): Promise<ApiKeyListItem[]> {
  const items = await queryApiKeys(appId, deps);
  return items.map(item => ({
    keyId: item.keyId,
    name: item.name,
    prefix: item.prefix,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    lastUsedAt: item.lastUsedAt,
  }));
}
