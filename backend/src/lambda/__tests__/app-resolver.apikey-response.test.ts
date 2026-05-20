/**
 * App Resolver — API Key Response Shape Tests
 *
 * Validates that the resolver flattens internal key management results
 * into the GraphQL AppApiKeyWithPlaintext / AppApiKey types.
 *
 * - createAppApiKey returns flat object with apiKey field
 * - rotateAppApiKey returns flat object (not {newKey, revokedKeyId})
 * - listAppApiKeys items have no apiKey field
 */
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

// Set env vars before importing handler
process.env.APPS_TABLE = 'test-apps';
process.env.WORKFLOWS_TABLE = 'test-workflows';
process.env.AGENT_CONFIG_TABLE = 'test-agents';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.USER_POOL_ID = 'us-east-1_test';

import { handler } from '../app-resolver';

function makeEvent(fieldName: string, args: Record<string, any>) {
  return {
    info: { fieldName, parentTypeName: 'Mutation', selectionSetList: [] },
    arguments: args,
    identity: { sub: 'user-1', claims: {} },
    source: null,
    request: { headers: {} },
    prev: null,
    stash: {},
  } as any;
}

describe('App Resolver — API Key Response Shapes', () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  it('createAppApiKey returns flat AppApiKeyWithPlaintext with apiKey field', async () => {
    // Mock: no existing keys (empty query for active key count)
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(
      makeEvent('createAppApiKey', { appId: 'app-1', name: 'Test Key' }),
      {} as any,
      () => {},
    );

    // Flat shape: top-level fields, not nested
    expect(result).toHaveProperty('keyId');
    expect(result).toHaveProperty('name', 'Test Key');
    expect(result).toHaveProperty('prefix');
    expect(result).toHaveProperty('status', 'ACTIVE');
    expect(result).toHaveProperty('createdAt');
    expect(result).toHaveProperty('apiKey');
    expect(typeof result.apiKey).toBe('string');
    expect(result.apiKey.length).toBeGreaterThan(0);
    // Should NOT have internal fields
    expect(result).not.toHaveProperty('plaintext');
    expect(result).not.toHaveProperty('hashedKey');
  });

  it('rotateAppApiKey returns flat response (not {newKey, revokedKeyId})', async () => {
    // Mock: existing active key found
    ddbMock.on(QueryCommand).resolves({
      Items: [{
        keyId: 'old-key',
        name: 'Existing Key',
        prefix: 'abcd1234',
        status: 'ACTIVE',
        createdAt: '2024-01-01T00:00:00Z',
      }],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(
      makeEvent('rotateAppApiKey', { appId: 'app-1', keyId: 'old-key' }),
      {} as any,
      () => {},
    );

    // Flat shape: NOT { newKey: {...}, revokedKeyId: '...' }
    expect(result).not.toHaveProperty('newKey');
    expect(result).not.toHaveProperty('revokedKeyId');
    // Top-level fields
    expect(result).toHaveProperty('keyId');
    expect(result).toHaveProperty('name', 'Existing Key');
    expect(result).toHaveProperty('prefix');
    expect(result).toHaveProperty('status', 'ACTIVE');
    expect(result).toHaveProperty('apiKey');
    expect(typeof result.apiKey).toBe('string');
  });

  it('listAppApiKeys items have no apiKey field', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { keyId: 'k1', name: 'Key 1', prefix: 'aaaa1111', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00Z' },
        { keyId: 'k2', name: 'Key 2', prefix: 'bbbb2222', status: 'REVOKED', createdAt: '2024-02-01T00:00:00Z' },
      ],
    });

    const result = await handler(
      makeEvent('listAppApiKeys', { appId: 'app-1' }),
      {} as any,
      () => {},
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    for (const key of result) {
      expect(key).toHaveProperty('keyId');
      expect(key).toHaveProperty('name');
      expect(key).toHaveProperty('prefix');
      expect(key).toHaveProperty('status');
      // No plaintext or hashed key in list results
      expect(key).not.toHaveProperty('apiKey');
      expect(key).not.toHaveProperty('plaintext');
      expect(key).not.toHaveProperty('hashedKey');
    }
  });
});
