/**
 * Unit tests for setAppConfigSchema mutation handler
 * Validates: Requirements 7.1, 7.3, 7.8
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../app-resolver';

function makeEvent(fieldName: string, args: any) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as any;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

const APP_ITEM = {
  appId: 'app-1',
  orgId: 'org-1',
  groupId: 'APP#app-1',
  sortId: 'METADATA',
  name: 'Test App',
  status: 'DRAFT',
  version: 3,
  workflowIds: [],
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const VALID_SCHEMA = {
  type: 'object',
  properties: {
    apiKey: { type: 'string' },
    maxRetries: { type: 'number' },
  },
  required: ['apiKey'],
};

describe('setAppConfigSchema', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    mockCognitoOrg('org-1');
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // ─── Valid schema storage ──────────────────────────────────────

  describe('valid JSON Schema', () => {
    test('stores valid JSON Schema as CONFIG#schema component item', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { ...APP_ITEM, version: 4 },
          {
            appId: 'app-1',
            groupId: 'APP#app-1',
            sortId: 'CONFIG#schema',
            schema: VALID_SCHEMA,
          },
        ],
      });

      const result = await handler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify(VALID_SCHEMA),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      // Verify PutCommand was called for CONFIG#schema
      const putCalls = ddbMock.commandCalls(PutCommand);
      const schemaPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'CONFIG#schema',
      );
      expect(schemaPut).toBeDefined();

      const item = schemaPut!.args[0].input.Item!;
      expect(item.groupId).toBe('APP#app-1');
      expect(item.sortId).toBe('CONFIG#schema');
      expect(item.appId).toBe('app-1#CONFIG#schema');      expect(item.schema).toEqual(VALID_SCHEMA);
    });

    test('returns full app with components after storing schema', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { ...APP_ITEM, version: 4 },
          {
            appId: 'app-1',
            groupId: 'APP#app-1',
            sortId: 'CONFIG#schema',
            schema: VALID_SCHEMA,
          },
        ],
      });

      const result = await handler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify(VALID_SCHEMA),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      expect(result.appId).toBe('app-1');
      expect(result.configSchema).toEqual(VALID_SCHEMA);
    });
  });

  // ─── Invalid schema rejection ─────────────────────────────────

  describe('invalid JSON Schema', () => {
    test('rejects schema with invalid type keyword', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      const invalidSchema = { type: 'not-a-real-type' };

      await expect(
        handler(
          makeEvent('setAppConfigSchema', {
            appId: 'app-1',
            schema: JSON.stringify(invalidSchema),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/invalid.*schema/i);
    });

    test('rejects non-object schema input', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      await expect(
        handler(
          makeEvent('setAppConfigSchema', {
            appId: 'app-1',
            schema: JSON.stringify('just a string'),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/invalid.*schema/i);
    });
  });

  // ─── Optimistic locking ───────────────────────────────────────

  describe('optimistic locking', () => {
    test('increments app version using optimistic locking', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [{ ...APP_ITEM, version: 4 }] });

      await handler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify(VALID_SCHEMA),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      // Find the version update call
      const versionUpdate = updateCalls.find((c) => {
        const values = c.args[0].input.ExpressionAttributeValues;
        return values?.[':currentVersion'] !== undefined;
      });
      expect(versionUpdate).toBeDefined();
      expect(versionUpdate!.args[0].input.ExpressionAttributeValues![':currentVersion']).toBe(3);
    });

    test('throws conflict error when version mismatch', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(UpdateCommand).rejects({
        name: 'ConditionalCheckFailedException',
        message: 'The conditional request failed',
      });

      await expect(
        handler(
          makeEvent('setAppConfigSchema', {
            appId: 'app-1',
            schema: JSON.stringify(VALID_SCHEMA),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/conflict/i);
    });
  });

  // ─── Access control ───────────────────────────────────────────

  describe('access control', () => {
    test('rejects caller whose orgId does not match app orgId', async () => {
      mockCognitoOrg('org-other');
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      await expect(
        handler(
          makeEvent('setAppConfigSchema', {
            appId: 'app-1',
            schema: JSON.stringify(VALID_SCHEMA),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Access denied');
    });

    test('throws when app not found', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      await expect(
        handler(
          makeEvent('setAppConfigSchema', {
            appId: 'nonexistent',
            schema: JSON.stringify(VALID_SCHEMA),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('App not found');
    });
  });
});
