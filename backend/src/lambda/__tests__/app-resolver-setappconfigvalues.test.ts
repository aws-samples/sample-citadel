/**
 * Unit tests for setAppConfigValues mutation handler
 * Validates: Requirements 7.2, 7.4, 7.5, 7.8
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

const CONFIG_SCHEMA_ITEM = {
  appId: 'app-1',
  groupId: 'APP#app-1',
  sortId: 'CONFIG#schema',
  schema: VALID_SCHEMA,
};

describe('setAppConfigValues', () => {
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

  // ─── Valid values storage ──────────────────────────────────────

  describe('valid config values', () => {
    test('stores valid config values as CONFIG#values component item', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      // GroupIndex query returns metadata + schema
      ddbMock.on(QueryCommand).callsFake((input) => {
        return { Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] };
      });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});

      const values = { apiKey: 'sk-test-123', maxRetries: 3 };

      const result = await handler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify(values),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      // Verify PutCommand was called for CONFIG#values
      const putCalls = ddbMock.commandCalls(PutCommand);
      const valuesPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'CONFIG#values',
      );
      expect(valuesPut).toBeDefined();

      const item = valuesPut!.args[0].input.Item!;
      expect(item.groupId).toBe('APP#app-1');
      expect(item.sortId).toBe('CONFIG#values');
      expect(item.appId).toBe('app-1#CONFIG#values');
      expect(item.values).toEqual(values);
    });

    test('returns full app with components after storing values', async () => {
      const values = { apiKey: 'sk-test-123', maxRetries: 3 };
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});
      // First query: load schema; second query: getAppWithComponents
      let queryCallCount = 0;
      ddbMock.on(QueryCommand).callsFake(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return { Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] };
        }
        return {
          Items: [
            { ...APP_ITEM, version: 4 },
            CONFIG_SCHEMA_ITEM,
            {
              appId: 'app-1',
              groupId: 'APP#app-1',
              sortId: 'CONFIG#values',
              values,
            },
          ],
        };
      });

      const result = await handler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify(values),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      expect(result.appId).toBe('app-1');
      expect(result.configValues).toEqual(values);
    });

    test('accepts values when no schema exists (allows any values)', async () => {
      const values = { anything: 'goes', nested: { deep: true } };
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      // No schema in GroupIndex results
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify(values),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      expect(result).toBeDefined();
      const putCalls = ddbMock.commandCalls(PutCommand);
      const valuesPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'CONFIG#values',
      );
      expect(valuesPut).toBeDefined();
    });
  });

  // ─── Validation errors ────────────────────────────────────────

  describe('validation against schema', () => {
    test('rejects values missing required properties with per-property errors', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] });

      // Missing required 'apiKey'
      const values = { maxRetries: 3 };

      await expect(
        handler(
          makeEvent('setAppConfigValues', {
            appId: 'app-1',
            values: JSON.stringify(values),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/validation/i);
    });

    test('rejects values with wrong property types', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] });

      // apiKey should be string, not number
      const values = { apiKey: 12345, maxRetries: 3 };

      await expect(
        handler(
          makeEvent('setAppConfigValues', {
            appId: 'app-1',
            values: JSON.stringify(values),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/validation/i);
    });

    test('error message includes per-property details', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] });

      // Missing required 'apiKey'
      const values = { maxRetries: 'not-a-number' };

      try {
        await handler(
          makeEvent('setAppConfigValues', {
            appId: 'app-1',
            values: JSON.stringify(values),
            version: 3,
          }),
          {} as any,
          {} as any,
        );
        fail('Expected error to be thrown');
      } catch (error: any) {
        // Should mention the failing property or path
        expect(error.message).toMatch(/apiKey|maxRetries/i);
      }
    });
  });

  // ─── Optimistic locking ───────────────────────────────────────

  describe('optimistic locking', () => {
    test('increments app version using optimistic locking', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] });
      ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 4 } });
      ddbMock.on(PutCommand).resolves({});

      const values = { apiKey: 'sk-test-123' };

      await handler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify(values),
          version: 3,
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      const versionUpdate = updateCalls.find((c) => {
        const vals = c.args[0].input.ExpressionAttributeValues;
        return vals?.[':currentVersion'] !== undefined;
      });
      expect(versionUpdate).toBeDefined();
      expect(versionUpdate!.args[0].input.ExpressionAttributeValues![':currentVersion']).toBe(3);
    });

    test('throws conflict error when version mismatch', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, CONFIG_SCHEMA_ITEM] });
      ddbMock.on(UpdateCommand).rejects({
        name: 'ConditionalCheckFailedException',
        message: 'The conditional request failed',
      });

      const values = { apiKey: 'sk-test-123' };

      await expect(
        handler(
          makeEvent('setAppConfigValues', {
            appId: 'app-1',
            values: JSON.stringify(values),
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
          makeEvent('setAppConfigValues', {
            appId: 'app-1',
            values: JSON.stringify({ apiKey: 'test' }),
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
          makeEvent('setAppConfigValues', {
            appId: 'nonexistent',
            values: JSON.stringify({ apiKey: 'test' }),
            version: 3,
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('App not found');
    });
  });
});
