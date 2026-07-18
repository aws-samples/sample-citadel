/**
 * Unit tests for API key management — creation, revocation, and rotation.
 *
 * TDD: These tests are written BEFORE the implementation (task 8.6).
 * The implementation will live in app-api-key-management.ts (or extend app-resolver.ts).
 *
 * Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9
 */
import { createHash } from 'crypto';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

import {
  createAppApiKey,
  revokeAppApiKey,
  rotateAppApiKey,
} from '../app-api-key-management';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// ── Helpers ─────────────────────────────────────────────────

const TEST_APP_ID = 'app-test-001';
const TEST_USER_ID = 'user-abc-123';

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    eventBridgeClient: new EventBridgeClient({}),
    appsTable: 'citadel-apps-test',
    eventBusName: 'citadel-agents-test',
  };
}

/** Creates a mock APIKEY# item as it would appear in DynamoDB. */
function makeKeyItem(overrides: Record<string, unknown> = {}) {
  const keyId = (overrides.keyId as string | undefined) || 'key-existing-1';
  return {
    appId: `${TEST_APP_ID}#APIKEY#${keyId}`,
    groupId: `APP#${TEST_APP_ID}`,
    sortId: `APIKEY#${keyId}`,
    keyId,
    name: 'test-key',
    hashedKey: createHash('sha256').update('some-plaintext').digest('hex'),
    prefix: 'someplai',
    status: 'ACTIVE',
    createdAt: '2024-01-15T10:00:00.000Z',
    ...overrides,
  };
}

/** Generates N active key items for max-keys testing. */
function makeActiveKeys(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) =>
    makeKeyItem({ keyId: `key-${i}`, name: `key-${i}`, status: 'ACTIVE' }),
  );
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({});
});


// ── createAppApiKey Tests (Req 5.1, 5.3, 5.4, 5.7, 5.8, 5.9) ──

describe('createAppApiKey', () => {
  test('generates a 32-byte key and stores SHA-256 hash as APIKEY#{keyId}', async () => {
    // No existing keys
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(
      TEST_APP_ID,
      'my-key',
      TEST_USER_ID,
      makeDeps(),
    );

    // Plaintext should be base64url of 32 bytes (43 chars)
    expect(result.plaintext).toBeDefined();
    expect(typeof result.plaintext).toBe('string');
    const decodedBytes = Buffer.from(result.plaintext, 'base64url');
    expect(decodedBytes.length).toBe(32);

    // Verify the stored hash matches SHA-256 of the plaintext
    const expectedHash = createHash('sha256').update(result.plaintext).digest('hex');
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.hashedKey).toBe(expectedHash);

    // sortId follows APIKEY#{keyId} pattern
    expect(storedItem.sortId).toMatch(/^APIKEY#.+$/);
  });

  test('returns plaintext key exactly once in the response', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(
      TEST_APP_ID,
      'my-key',
      TEST_USER_ID,
      makeDeps(),
    );

    expect(result.plaintext).toBeTruthy();
    expect(result.keyId).toBeTruthy();
    expect(result.name).toBe('my-key');
    expect(result.status).toBe('ACTIVE');
  });

  test('key item has all required fields: keyId, name, hashedKey, prefix, status, createdAt', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await createAppApiKey(TEST_APP_ID, 'production-key', TEST_USER_ID, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;

    expect(storedItem.keyId).toBeDefined();
    expect(typeof storedItem.keyId).toBe('string');
    expect(storedItem.name).toBe('production-key');
    expect(storedItem.hashedKey).toBeDefined();
    expect(typeof storedItem.hashedKey).toBe('string');
    expect(storedItem.hashedKey.length).toBe(64); // SHA-256 hex = 64 chars
    expect(storedItem.prefix).toBeDefined();
    expect(typeof storedItem.prefix).toBe('string');
    expect(storedItem.prefix.length).toBe(8);
    expect(storedItem.status).toBe('ACTIVE');
    expect(storedItem.createdAt).toBeDefined();
    // Verify createdAt is valid ISO 8601
    expect(new Date(storedItem.createdAt).toISOString()).toBe(storedItem.createdAt);
  });

  test('prefix is the first 8 characters of the plaintext key', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(TEST_APP_ID, 'my-key', TEST_USER_ID, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.prefix).toBe(result.plaintext.substring(0, 8));
  });

  test('stores key under correct groupId APP#{appId}', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await createAppApiKey(TEST_APP_ID, 'my-key', TEST_USER_ID, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.groupId).toBe(`APP#${TEST_APP_ID}`);
  });

  test('max 10 active keys enforced — creation rejected at limit', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: makeActiveKeys(10) });

    await expect(
      createAppApiKey(TEST_APP_ID, 'one-too-many', TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/maximum.*10.*active/i);

    // Should NOT have stored a new key
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('creation succeeds when fewer than 10 active keys exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: makeActiveKeys(9) });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(TEST_APP_ID, 'ninth-key', TEST_USER_ID, makeDeps());

    expect(result.plaintext).toBeTruthy();
    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThanOrEqual(1);
  });

  test('revoked keys do not count toward the 10-key limit', async () => {
    const keys = [
      ...makeActiveKeys(9),
      makeKeyItem({ keyId: 'key-revoked', status: 'REVOKED' }),
    ];
    ddbMock.on(QueryCommand).resolves({ Items: keys });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(TEST_APP_ID, 'new-key', TEST_USER_ID, makeDeps());

    expect(result.plaintext).toBeTruthy();
  });

  test('expiresIn sets expiresAt timestamp correctly', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const expiresInSeconds = 3600; // 1 hour
    const before = Date.now();
    await createAppApiKey(TEST_APP_ID, 'expiring-key', TEST_USER_ID, makeDeps(), expiresInSeconds);
    const after = Date.now();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.expiresAt).toBeDefined();

    const expiresAtMs = new Date(storedItem.expiresAt).getTime();
    // expiresAt should be approximately now + expiresInSeconds
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + expiresInSeconds * 1000 - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + expiresInSeconds * 1000 + 1000);
  });

  test('expiresAt is omitted when expiresIn is not provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    await createAppApiKey(TEST_APP_ID, 'no-expiry-key', TEST_USER_ID, makeDeps());

    const putCalls = ddbMock.commandCalls(PutCommand);
    const storedItem = putCalls[0].args[0].input.Item!;
    expect(storedItem.expiresAt).toBeUndefined();
  });

  test('emits app.apikey.created EventBridge event', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await createAppApiKey(TEST_APP_ID, 'event-key', TEST_USER_ID, makeDeps());

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const entry = ebCalls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe('citadel.apps');
    expect(entry.DetailType).toBe('app.apikey.created');
    const detail = JSON.parse(entry.Detail!);
    expect(detail.appId).toBe(TEST_APP_ID);
    expect(detail.keyId).toBe(result.keyId);
    expect(detail.keyName).toBe('event-key');
    expect(detail.userId).toBe(TEST_USER_ID);
    expect(detail.timestamp).toBeDefined();
  });
});


// ── revokeAppApiKey Tests (Req 5.5, 5.9) ───────────────────

describe('revokeAppApiKey', () => {
  test('sets status to REVOKED for an active key', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-to-revoke', status: 'ACTIVE' })],
    });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await revokeAppApiKey(TEST_APP_ID, 'key-to-revoke', TEST_USER_ID, makeDeps());

    expect(result.status).toBe('REVOKED');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.UpdateExpression).toContain('REVOKED');
  });

  test('idempotent on already-revoked key — no error, status remains REVOKED', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-already-revoked', status: 'REVOKED' })],
    });

    const result = await revokeAppApiKey(TEST_APP_ID, 'key-already-revoked', TEST_USER_ID, makeDeps());

    expect(result.status).toBe('REVOKED');
    // Should NOT call UpdateCommand since already revoked
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test('throws error when key not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      revokeAppApiKey(TEST_APP_ID, 'nonexistent-key', TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/not found/i);
  });

  test('emits app.apikey.revoked EventBridge event', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-revoke-event', status: 'ACTIVE' })],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await revokeAppApiKey(TEST_APP_ID, 'key-revoke-event', TEST_USER_ID, makeDeps());

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const entry = ebCalls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe('citadel.apps');
    expect(entry.DetailType).toBe('app.apikey.revoked');
    const detail = JSON.parse(entry.Detail!);
    expect(detail.appId).toBe(TEST_APP_ID);
    expect(detail.keyId).toBe('key-revoke-event');
    expect(detail.userId).toBe(TEST_USER_ID);
    expect(detail.timestamp).toBeDefined();
  });

  test('does not emit event when revoking already-revoked key (idempotent)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-already-revoked', status: 'REVOKED' })],
    });

    await revokeAppApiKey(TEST_APP_ID, 'key-already-revoked', TEST_USER_ID, makeDeps());

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
});


// ── rotateAppApiKey Tests (Req 5.6) ─────────────────────────

describe('rotateAppApiKey', () => {
  test('creates new key and revokes old key in a transaction', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-old', status: 'ACTIVE' })],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await rotateAppApiKey(TEST_APP_ID, 'key-old', TEST_USER_ID, makeDeps());

    // Should use TransactWriteItems for atomicity
    const txCalls = ddbMock.commandCalls(TransactWriteCommand);
    expect(txCalls).toHaveLength(1);

    // Result should contain the new key
    expect(result.newKey).toBeDefined();
    expect(result.newKey.plaintext).toBeTruthy();
    expect(result.newKey.keyId).toBeTruthy();
    expect(result.newKey.status).toBe('ACTIVE');
  });

  test('new key has different keyId and hashedKey than old key', async () => {
    const oldKey = makeKeyItem({ keyId: 'key-old', status: 'ACTIVE' });
    ddbMock.on(QueryCommand).resolves({ Items: [oldKey] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await rotateAppApiKey(TEST_APP_ID, 'key-old', TEST_USER_ID, makeDeps());

    expect(result.newKey.keyId).not.toBe('key-old');
    // Verify the new hash differs from the old hash
    const newHash = createHash('sha256').update(result.newKey.plaintext).digest('hex');
    expect(newHash).not.toBe(oldKey.hashedKey);
  });

  test('transaction contains both Put (new key) and Update (revoke old)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-old', status: 'ACTIVE' })],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await rotateAppApiKey(TEST_APP_ID, 'key-old', TEST_USER_ID, makeDeps());

    const txCalls = ddbMock.commandCalls(TransactWriteCommand);
    const transactItems = txCalls[0].args[0].input.TransactItems!;

    // Should have at least 2 items: one Put for new key, one Update for old key
    expect(transactItems.length).toBeGreaterThanOrEqual(2);

    const putItem = transactItems.find((t) => t.Put);
    const updateItem = transactItems.find((t) => t.Update);

    expect(putItem).toBeDefined();
    expect(updateItem).toBeDefined();

    // New key should be ACTIVE
    expect(putItem!.Put!.Item!.status).toBe('ACTIVE');
    // Old key should be set to REVOKED
    expect(updateItem!.Update!.UpdateExpression).toContain('REVOKED');
  });

  test('throws error when old key not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      rotateAppApiKey(TEST_APP_ID, 'nonexistent-key', TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/not found/i);
  });

  test('throws error when old key is already revoked', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeKeyItem({ keyId: 'key-revoked', status: 'REVOKED' })],
    });

    await expect(
      rotateAppApiKey(TEST_APP_ID, 'key-revoked', TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/cannot rotate.*revoked/i);
  });
});
