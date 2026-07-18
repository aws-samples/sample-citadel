/**
 * Unit tests for unpublish/teardown handler.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
 */
import {
  ApiGatewayV2Client,
  DeleteApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, DeleteRolePolicyCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
import { mockClient } from 'aws-sdk-client-mock';

import { unpublishApp, AppMetadata } from '../app-publish-handler';
import { PolicyManager } from '../../utils/policy-manager';

// ── Mocks ───────────────────────────────────────────────────

const apiGwMock = mockClient(ApiGatewayV2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const stsMock = mockClient(STSClient);
const iamMock = mockClient(IAMClient);

// ── Helpers ─────────────────────────────────────────────────

function makePublishedApp(overrides: Partial<AppMetadata> = {}): AppMetadata {
  return {
    appId: 'app-1',
    name: 'Test App',
    status: 'PUBLISHED',
    workflowIds: ['wf-1'],
    orgId: 'org-1',
    sortId: 'METADATA',
    groupId: 'APP#app-1',
    endpointUrl: 'https://api-123.execute-api.us-east-1.amazonaws.com',
    apiId: 'api-123',
    version: 1,
    ...overrides,
  };
}

function makeApiKeyItem(keyId: string, status: string = 'ACTIVE') {
  return {
    appId: `app-1#APIKEY#${keyId}`,
    groupId: 'APP#app-1',
    sortId: `APIKEY#${keyId}`,
    keyId,
    name: `key-${keyId}`,
    hashedKey: 'abc123',
    prefix: 'abcdefgh',
    status,
    createdAt: '2024-01-15T10:00:00.000Z',
  };
}

const mockPolicyManager = {
  getAccountContext: jest.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  deleteRole: jest.fn().mockResolvedValue(undefined),
} as unknown as PolicyManager;

function makeDefaultDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    apiGwClient: new ApiGatewayV2Client({}),
    eventBridgeClient: new EventBridgeClient({}),
    policyManager: mockPolicyManager,
    appsTable: 'citadel-apps-test',
    eventBusName: 'citadel-agents-test',
    environment: 'dev',
    authorizerFnArn: 'arn:aws:lambda:us-east-1:123:function:auth',
    region: 'us-east-1',
  };
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  apiGwMock.reset();
  ddbMock.reset();
  ebMock.reset();
  stsMock.reset();
  iamMock.reset();

  apiGwMock.on(DeleteApiCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ebMock.on(PutEventsCommand).resolves({});
  stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
  iamMock.on(DeleteRolePolicyCommand).resolves({});
  iamMock.on(DeleteRoleCommand).resolves({});

  (mockPolicyManager.deleteRole as jest.Mock).mockClear();
  (mockPolicyManager.deleteRole as jest.Mock).mockResolvedValue(undefined);
});

// ── Idempotency Tests (Req 8.8) ────────────────────────────

describe('unpublishApp — idempotency', () => {
  test('non-published app (DRAFT) returns current state without error', async () => {
    const draftApp = makePublishedApp({ status: 'DRAFT' });
    ddbMock.on(QueryCommand).resolves({ Items: [draftApp] });

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('DRAFT');
    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test('non-published app (ACTIVE) returns current state without error', async () => {
    const activeApp = makePublishedApp({ status: 'ACTIVE' });
    ddbMock.on(QueryCommand).resolves({ Items: [activeApp] });

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('ACTIVE');
    expect(apiGwMock.commandCalls(DeleteApiCommand)).toHaveLength(0);
  });

  test('non-published app (ARCHIVED) returns current state without error', async () => {
    const archivedApp = makePublishedApp({ status: 'ARCHIVED' });
    ddbMock.on(QueryCommand).resolves({ Items: [archivedApp] });

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('ARCHIVED');
  });
});

// ── Full Teardown Tests (Req 8.2, 8.3, 8.4, 8.5) ──────────

describe('unpublishApp — full teardown', () => {
  test('deletes API Gateway, revokes keys, deletes IAM role, sets status to DRAFT', async () => {
    const publishedApp = makePublishedApp();
    ddbMock.on(QueryCommand).resolves({
      Items: [
        publishedApp,
        makeApiKeyItem('key-1', 'ACTIVE'),
        makeApiKeyItem('key-2', 'ACTIVE'),
        makeApiKeyItem('key-3', 'REVOKED'),
      ],
    });

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    // Status should be DRAFT
    expect(result.app.status).toBe('DRAFT');

    // API Gateway should be deleted
    const deleteCalls = apiGwMock.commandCalls(DeleteApiCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.ApiId).toBe('api-123');

    // Active keys should be revoked (2 active keys)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    // At least 2 key revocations + 1 metadata update
    const keyRevocations = updateCalls.filter(c =>
      c.args[0].input.UpdateExpression?.includes('REVOKED'),
    );
    expect(keyRevocations.length).toBe(2);

    // IAM role should be deleted
    expect(mockPolicyManager.deleteRole).toHaveBeenCalledWith('app-1', 'agent');

    // endpointUrl and apiId should be removed
    expect(result.app.endpointUrl).toBeUndefined();
    expect(result.app.apiId).toBeUndefined();
  });

  test('removes endpointUrl and apiId from app metadata', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });

    await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    // Verify the metadata update removes endpointUrl and apiId
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const metadataUpdate = updateCalls.find(c =>
      c.args[0].input.UpdateExpression?.includes('REMOVE'),
    );
    expect(metadataUpdate).toBeDefined();
    expect(metadataUpdate!.args[0].input.UpdateExpression).toContain('endpointUrl');
    expect(metadataUpdate!.args[0].input.UpdateExpression).toContain('apiId');
  });

  test('Phase 3 Step 2: mirrors DRAFT status to AppsTable metadata row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });

    await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    // Key is appId only — AppsTable has no sort key.
    const metaUpdate = updateCalls.find(
      (c) =>
        (c.args[0].input.Key as Record<string, unknown> | undefined)?.appId === 'app-1' &&
        (c.args[0].input.Key as Record<string, unknown> | undefined)?.sortId === undefined &&
        (c.args[0].input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[
          ':v_status'
        ] === 'DRAFT',
    );
    expect(metaUpdate).toBeDefined();
    const values = metaUpdate!.args[0].input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':v_status']).toBe('DRAFT');
    expect(typeof values[':v_updatedAt']).toBe('string');
  });
});

// ── EventBridge Event Tests (Req 8.6) ──────────────────────

describe('unpublishApp — EventBridge event', () => {
  test('emits app.status.published_to_draft event', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });

    await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls).toHaveLength(1);
    const entry = ebCalls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe('citadel.apps');
    expect(entry.DetailType).toBe('app.status.published_to_draft');
  });

  test('event detail contains appId, orgId, userId, timestamp, correlationId', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp({ orgId: 'org-test' })],
    });

    await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(ebCalls[0].args[0].input.Entries![0].Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-test');
    expect(detail.userId).toBe('user-1');
    expect(detail.timestamp).toBeDefined();
    expect(detail.correlationId).toBeDefined();
    // Verify timestamp is valid ISO 8601
    expect(new Date(detail.timestamp).toISOString()).toBe(detail.timestamp);
    // Verify correlationId is a UUID-like string
    expect(detail.correlationId.length).toBeGreaterThan(0);
  });
});

// ── Correlation ID Tests (Req 8.9) ─────────────────────────

describe('unpublishApp — correlation ID', () => {
  test('uses a correlation ID for the teardown flow', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });

    await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(ebCalls[0].args[0].input.Entries![0].Detail!);
    expect(detail.correlationId).toBeDefined();
    expect(typeof detail.correlationId).toBe('string');
    expect(detail.correlationId.length).toBeGreaterThan(0);
  });
});

// ── Best-Effort Tests (Req 8.7) ────────────────────────────

describe('unpublishApp — best-effort teardown', () => {
  test('continues when API Gateway deletion fails, returns warning', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });
    apiGwMock.on(DeleteApiCommand).rejects(new Error('API GW delete failed'));

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    // Should still set status to DRAFT
    expect(result.app.status).toBe('DRAFT');
    // Should have warnings
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings!.some((w: string) => w.includes('API Gateway'))).toBe(true);
  });

  test('continues when key revocation fails, returns warning', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makePublishedApp(),
        makeApiKeyItem('key-1', 'ACTIVE'),
      ],
    });
    // First UpdateCommand (key revocation) fails, second (metadata update) succeeds
    ddbMock.on(UpdateCommand)
      .resolvesOnce({}) // key revocation succeeds or we can make it fail
      .resolves({});

    // Make key revocation fail by rejecting the first update
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makePublishedApp(),
        makeApiKeyItem('key-1', 'ACTIVE'),
      ],
    });
    // We need a way to make key revocation fail but metadata update succeed
    // The implementation should handle this via try/catch per step
    let updateCallCount = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      updateCallCount++;
      if (updateCallCount === 1) {
        throw new Error('Key revocation failed');
      }
      return {};
    });

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('DRAFT');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w: string) => w.includes('revok'))).toBe(true);
  });

  test('continues when IAM role deletion fails, returns warning', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });
    (mockPolicyManager.deleteRole as jest.Mock).mockRejectedValueOnce(
      new Error('IAM role delete failed'),
    );

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('DRAFT');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w: string) => w.includes('IAM role'))).toBe(true);
  });

  test('collects multiple warnings when multiple steps fail', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makePublishedApp()],
    });
    apiGwMock.on(DeleteApiCommand).rejects(new Error('API GW failed'));
    (mockPolicyManager.deleteRole as jest.Mock).mockRejectedValueOnce(
      new Error('IAM failed'),
    );

    const result = await unpublishApp('app-1', 'user-1', makeDefaultDeps());

    expect(result.app.status).toBe('DRAFT');
    expect(result.warnings!.length).toBeGreaterThanOrEqual(2);
  });
});

// ── App Not Found Test ──────────────────────────────────────

describe('unpublishApp — error handling', () => {
  test('throws error when app not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      unpublishApp('nonexistent', 'user-1', makeDefaultDeps()),
    ).rejects.toThrow('App not found');
  });
});
