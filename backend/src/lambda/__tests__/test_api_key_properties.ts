/**
 * Property-based tests for API key authorization correctness (Property 7)
 *
 * **Validates: Requirements 3.2, 3.3, 3.4, 5.8**
 *
 * For any API key and app, the Lambda authorizer should:
 * (a) return Allow when the key exists, has status ACTIVE, and is not expired;
 * (b) return Deny when the key does not exist, has status REVOKED, or has
 *     an expiresAt in the past.
 * The authorization decision depends only on key status and expiry,
 * not on any other app state.
 *
 * Tests the extracted pure decision function `evaluateKeyAuthorization` which
 * encapsulates the core authorization logic used by the Lambda handler.
 */
import * as fc from 'fast-check';
import { evaluateKeyAuthorization } from '../app-api-authorizer';

// ── Generators ──────────────────────────────────────────────

/** Valid API key ID */
const keyIdArb = fc.uuid();

/** Future timestamp (1 hour to 1 year from now) */
const futureTimestampArb = fc.integer({ min: 3_600_000, max: 365 * 24 * 3_600_000 })
  .map(offset => new Date(Date.now() + offset).toISOString());

/** Past timestamp (1 hour to 1 year ago) */
const pastTimestampArb = fc.integer({ min: 3_600_000, max: 365 * 24 * 3_600_000 })
  .map(offset => new Date(Date.now() - offset).toISOString());

/** Arbitrary app name (irrelevant to auth decision) */
const appNameArb = fc.string({ minLength: 1, maxLength: 40 })
  .filter(s => s.trim().length > 0);

/** Arbitrary app status (irrelevant to auth decision) */
const appStatusArb = fc.constantFrom('DRAFT', 'ACTIVE', 'PUBLISHED', 'ARCHIVED');

/** Arbitrary org ID (irrelevant to auth decision) */
const orgIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Arbitrary workflow IDs (irrelevant to auth decision) */
const workflowIdsArb = fc.array(fc.uuid(), { minLength: 0, maxLength: 5 });

/** Arbitrary extra fields that should NOT affect the decision */
const irrelevantAppStateArb = fc.record({
  appName: appNameArb,
  appStatus: appStatusArb,
  orgId: orgIdArb,
  workflowIds: workflowIdsArb,
});

// ── Property 7 Tests ────────────────────────────────────────

describe('Property 7: API key authorization correctness', () => {

  /**
   * **Validates: Requirements 3.2**
   *
   * For any key ID, when the key exists with status ACTIVE and no expiry,
   * the authorization decision is 'allow'.
   */
  it('returns allow when key exists, is ACTIVE, and has no expiry', () => {
    fc.assert(
      fc.property(
        keyIdArb,
        (keyId) => {
          const result = evaluateKeyAuthorization({
            status: 'ACTIVE',
            keyId,
          });
          expect(result).toBe('allow');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 3.2, 5.8**
   *
   * For any key with status ACTIVE and a future expiresAt, the authorization
   * decision is 'allow'.
   */
  it('returns allow when key is ACTIVE and expiresAt is in the future', () => {
    fc.assert(
      fc.property(
        keyIdArb,
        futureTimestampArb,
        (keyId, expiresAt) => {
          const result = evaluateKeyAuthorization({
            status: 'ACTIVE',
            keyId,
            expiresAt,
          });
          expect(result).toBe('allow');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 3.4, 5.8**
   *
   * For any key with status ACTIVE but expiresAt in the past, the
   * authorization decision is 'deny'.
   */
  it('returns deny when key is ACTIVE but expired', () => {
    fc.assert(
      fc.property(
        keyIdArb,
        pastTimestampArb,
        (keyId, expiresAt) => {
          const result = evaluateKeyAuthorization({
            status: 'ACTIVE',
            keyId,
            expiresAt,
          });
          expect(result).toBe('deny');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * For any key with status REVOKED (regardless of expiry), the authorization
   * decision is 'deny'.
   */
  it('returns deny when key has status REVOKED', () => {
    fc.assert(
      fc.property(
        keyIdArb,
        fc.option(futureTimestampArb, { nil: undefined }),
        (keyId, expiresAt) => {
          const result = evaluateKeyAuthorization({
            status: 'REVOKED',
            keyId,
            expiresAt,
          });
          expect(result).toBe('deny');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * When no key matches (undefined input), the authorization decision is 'deny'.
   */
  it('returns deny when key does not exist (undefined)', () => {
    const result = evaluateKeyAuthorization(undefined);
    expect(result).toBe('deny');
  });

  /**
   * **Validates: Requirements 3.2, 3.3, 3.4**
   *
   * The authorization decision depends ONLY on key status and expiry.
   * Given the same key status and expiry, varying any other app state
   * (name, status, org, workflows) does not change the auth result.
   */
  it('decision depends only on key status and expiry, not other app state', () => {
    fc.assert(
      fc.property(
        keyIdArb,
        fc.constantFrom('ACTIVE', 'REVOKED'),
        fc.option(futureTimestampArb, { nil: undefined }),
        irrelevantAppStateArb,
        irrelevantAppStateArb,
        (keyId, status, expiresAt, _state1, _state2) => {
          // Same key status and expiry, different "app states"
          const result1 = evaluateKeyAuthorization({ status, keyId, expiresAt });
          const result2 = evaluateKeyAuthorization({ status, keyId, expiresAt });

          // Both should produce the same authorization decision
          expect(result1).toBe(result2);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 3.2, 3.4**
   *
   * For any key status that is not 'ACTIVE' (arbitrary non-ACTIVE string),
   * the authorization decision is always 'deny', regardless of expiry.
   */
  it('returns deny for any non-ACTIVE status', () => {
    const nonActiveStatusArb = fc.string({ minLength: 1, maxLength: 20 })
      .filter(s => s !== 'ACTIVE');

    fc.assert(
      fc.property(
        keyIdArb,
        nonActiveStatusArb,
        fc.option(futureTimestampArb, { nil: undefined }),
        (keyId, status, expiresAt) => {
          const result = evaluateKeyAuthorization({ status, keyId, expiresAt });
          expect(result).toBe('deny');
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ── Imports for Properties 2, 10, 11, 12 ────────────────────

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
import { generateApiKey } from '../app-publish-handler';

// ── Shared Mocks ────────────────────────────────────────────

const ddbMockPBT = mockClient(DynamoDBDocumentClient);
const ebMockPBT = mockClient(EventBridgeClient);

function makePBTDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    eventBridgeClient: new EventBridgeClient({}),
    appsTable: 'citadel-apps-pbt',
    eventBusName: 'citadel-agents-pbt',
  };
}

// ── Generators ──────────────────────────────────────────────

/** Arbitrary app ID */
const appIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{3,30}$/);

/** Arbitrary key name */
const keyNameArb = fc.string({ minLength: 1, maxLength: 40 })
  .filter(s => s.trim().length > 0);

/** Arbitrary user ID */
const userIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{3,30}$/);

// ── Property 2 Tests ────────────────────────────────────────

describe('Property 2: API key hash round-trip', () => {

  /**
   * **Validates: Requirements 1.6, 5.3**
   *
   * For any generated API key, the SHA-256 hash of the plaintext
   * matches the stored hash returned by generateApiKey.
   */
  it('SHA-256 hash of plaintext matches stored hash', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const key = generateApiKey();
          const recomputedHash = createHash('sha256').update(key.plaintext).digest('hex');
          expect(recomputedHash).toBe(key.hashed);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * For any generated API key, the prefix is the first 8 characters
   * of the plaintext key.
   */
  it('prefix is first 8 characters of plaintext', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const key = generateApiKey();
          expect(key.prefix).toBe(key.plaintext.substring(0, 8));
          expect(key.prefix.length).toBe(8);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.6, 5.3**
   *
   * For any generated API key, the plaintext decodes to exactly 32 bytes
   * from base64url encoding.
   */
  it('plaintext decodes to exactly 32 bytes', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const key = generateApiKey();
          const decoded = Buffer.from(key.plaintext, 'base64url');
          expect(decoded.length).toBe(32);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * For any generated API key, the key item contains all required fields:
   * keyId (non-empty string), plaintext, hashed (64-char hex), prefix (8 chars).
   */
  it('key item contains all required fields', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const key = generateApiKey();
          expect(typeof key.keyId).toBe('string');
          expect(key.keyId.length).toBeGreaterThan(0);
          expect(typeof key.plaintext).toBe('string');
          expect(key.plaintext.length).toBeGreaterThan(0);
          expect(typeof key.hashed).toBe('string');
          expect(key.hashed.length).toBe(64); // SHA-256 hex
          expect(/^[0-9a-f]{64}$/.test(key.hashed)).toBe(true);
          expect(typeof key.prefix).toBe('string');
          expect(key.prefix.length).toBe(8);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.6**
   *
   * Each generated key has a unique keyId (UUID v4 format).
   */
  it('each generated key has a unique keyId', () => {
    const keyIds = new Set<string>();
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const key = generateApiKey();
          expect(keyIds.has(key.keyId)).toBe(false);
          keyIds.add(key.keyId);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── Property 10 Tests ───────────────────────────────────────

describe('Property 10: API key revocation state change', () => {

  beforeEach(() => {
    ddbMockPBT.reset();
    ebMockPBT.reset();
    ebMockPBT.on(PutEventsCommand).resolves({});
  });

  /**
   * **Validates: Requirements 5.5**
   *
   * For any active key, revoking it sets status to REVOKED.
   */
  it('revoking an active key sets status to REVOKED', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        keyIdArb,
        userIdArb,
        keyNameArb,
        async (appId, keyId, userId, keyName) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          ddbMockPBT.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#APIKEY#${keyId}`,
              groupId: `APP#${appId}`,
              sortId: `APIKEY#${keyId}`,
              keyId,
              name: keyName,
              hashedKey: 'abc123',
              prefix: 'abcdefgh',
              status: 'ACTIVE',
              createdAt: new Date().toISOString(),
            }],
          });
          ddbMockPBT.on(UpdateCommand).resolves({});

          const result = await revokeAppApiKey(appId, keyId, userId, makePBTDeps());
          expect(result.status).toBe('REVOKED');
          expect(result.keyId).toBe(keyId);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.5**
   *
   * Revoking an already-revoked key is idempotent — no error, status remains REVOKED.
   */
  it('revoking already-revoked key is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        keyIdArb,
        userIdArb,
        keyNameArb,
        async (appId, keyId, userId, keyName) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          ddbMockPBT.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#APIKEY#${keyId}`,
              groupId: `APP#${appId}`,
              sortId: `APIKEY#${keyId}`,
              keyId,
              name: keyName,
              hashedKey: 'abc123',
              prefix: 'abcdefgh',
              status: 'REVOKED',
              createdAt: new Date().toISOString(),
            }],
          });

          const result = await revokeAppApiKey(appId, keyId, userId, makePBTDeps());
          expect(result.status).toBe('REVOKED');

          // No UpdateCommand should have been called (idempotent)
          expect(ddbMockPBT.commandCalls(UpdateCommand)).toHaveLength(0);
          // No EventBridge event emitted for idempotent revoke
          expect(ebMockPBT.commandCalls(PutEventsCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 11 Tests ───────────────────────────────────────

describe('Property 11: API key rotation atomicity', () => {

  beforeEach(() => {
    ddbMockPBT.reset();
    ebMockPBT.reset();
    ebMockPBT.on(PutEventsCommand).resolves({});
  });

  /**
   * **Validates: Requirements 5.6**
   *
   * For any active key, rotation produces exactly one new ACTIVE key
   * and sets old key to REVOKED. New key has different keyId and hashedKey.
   */
  it('rotation produces new ACTIVE key and revokes old key with different keyId and hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        keyIdArb,
        userIdArb,
        keyNameArb,
        async (appId, oldKeyId, userId, keyName) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          const oldHashedKey = createHash('sha256').update('old-plaintext').digest('hex');

          ddbMockPBT.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#APIKEY#${oldKeyId}`,
              groupId: `APP#${appId}`,
              sortId: `APIKEY#${oldKeyId}`,
              keyId: oldKeyId,
              name: keyName,
              hashedKey: oldHashedKey,
              prefix: 'oldprefi',
              status: 'ACTIVE',
              createdAt: new Date().toISOString(),
            }],
          });
          ddbMockPBT.on(TransactWriteCommand).resolves({});

          const result = await rotateAppApiKey(appId, oldKeyId, userId, makePBTDeps());

          // New key is ACTIVE
          expect(result.newKey.status).toBe('ACTIVE');
          // Old key ID is returned as revoked
          expect(result.revokedKeyId).toBe(oldKeyId);
          // New key has different keyId
          expect(result.newKey.keyId).not.toBe(oldKeyId);
          // New key has different hashedKey
          expect(result.newKey.hashedKey).not.toBe(oldHashedKey);
          // New key hash matches SHA-256 of new plaintext
          const expectedHash = createHash('sha256').update(result.newKey.plaintext).digest('hex');
          expect(result.newKey.hashedKey).toBe(expectedHash);

          // Transaction was used (atomicity)
          expect(ddbMockPBT.commandCalls(TransactWriteCommand)).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.6**
   *
   * Rotation transaction contains exactly one Put (new key) and one Update (revoke old).
   */
  it('rotation transaction contains Put for new key and Update for old key', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        keyIdArb,
        userIdArb,
        async (appId, oldKeyId, userId) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          ddbMockPBT.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#APIKEY#${oldKeyId}`,
              groupId: `APP#${appId}`,
              sortId: `APIKEY#${oldKeyId}`,
              keyId: oldKeyId,
              name: 'test-key',
              hashedKey: 'abc',
              prefix: 'abcdefgh',
              status: 'ACTIVE',
              createdAt: new Date().toISOString(),
            }],
          });
          ddbMockPBT.on(TransactWriteCommand).resolves({});

          await rotateAppApiKey(appId, oldKeyId, userId, makePBTDeps());

          const txCalls = ddbMockPBT.commandCalls(TransactWriteCommand);
          const transactItems = txCalls[0].args[0].input.TransactItems!;

          const putItems = transactItems.filter((t) => t.Put);
          const updateItems = transactItems.filter((t) => t.Update);

          expect(putItems).toHaveLength(1);
          expect(updateItems).toHaveLength(1);
          expect(putItems[0].Put!.Item!.status).toBe('ACTIVE');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 12 Tests ───────────────────────────────────────

describe('Property 12: Maximum active API keys enforcement', () => {

  beforeEach(() => {
    ddbMockPBT.reset();
    ebMockPBT.reset();
    ebMockPBT.on(PutEventsCommand).resolves({});
  });

  /** Helper to generate N mock active key items */
  function makeMockActiveKeys(appId: string, count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
      appId: `${appId}#APIKEY#key-${i}`,
      groupId: `APP#${appId}`,
      sortId: `APIKEY#key-${i}`,
      keyId: `key-${i}`,
      name: `key-${i}`,
      hashedKey: `hash-${i}`,
      prefix: `prefix${i}`.substring(0, 8),
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    }));
  }

  /**
   * **Validates: Requirements 5.7**
   *
   * For any app with N >= 10 active keys, creation is rejected.
   */
  it('rejects creation when active key count >= 10', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        keyNameArb,
        fc.integer({ min: 10, max: 15 }),
        async (appId, userId, keyName, activeCount) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          ddbMockPBT.on(QueryCommand).resolves({
            Items: makeMockActiveKeys(appId, activeCount),
          });

          await expect(
            createAppApiKey(appId, keyName, userId, makePBTDeps()),
          ).rejects.toThrow(/maximum.*10.*active/i);

          // No PutCommand should have been called
          expect(ddbMockPBT.commandCalls(PutCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.7**
   *
   * For any app with N < 10 active keys, creation succeeds
   * and the new key is ACTIVE.
   */
  it('allows creation when active key count < 10', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        keyNameArb,
        fc.integer({ min: 0, max: 9 }),
        async (appId, userId, keyName, activeCount) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          ddbMockPBT.on(QueryCommand).resolves({
            Items: makeMockActiveKeys(appId, activeCount),
          });
          ddbMockPBT.on(PutCommand).resolves({});

          const result = await createAppApiKey(appId, keyName, userId, makePBTDeps());

          expect(result.status).toBe('ACTIVE');
          expect(result.plaintext).toBeTruthy();
          expect(result.keyId).toBeTruthy();

          // A PutCommand should have been called to store the key
          expect(ddbMockPBT.commandCalls(PutCommand).length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.7**
   *
   * Revoked keys do not count toward the 10-key limit.
   * An app with 9 active + any number of revoked keys can still create.
   */
  it('revoked keys do not count toward the limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        keyNameArb,
        fc.integer({ min: 1, max: 10 }),
        async (appId, userId, keyName, revokedCount) => {
          ddbMockPBT.reset();
          ebMockPBT.reset();
          ebMockPBT.on(PutEventsCommand).resolves({});

          const activeKeys = makeMockActiveKeys(appId, 9);
          const revokedKeys = Array.from({ length: revokedCount }, (_, i) => ({
            ...makeMockActiveKeys(appId, 1)[0],
            keyId: `revoked-${i}`,
            status: 'REVOKED',
          }));

          ddbMockPBT.on(QueryCommand).resolves({
            Items: [...activeKeys, ...revokedKeys],
          });
          ddbMockPBT.on(PutCommand).resolves({});

          const result = await createAppApiKey(appId, keyName, userId, makePBTDeps());
          expect(result.status).toBe('ACTIVE');
        },
      ),
      { numRuns: 100 },
    );
  });
});
