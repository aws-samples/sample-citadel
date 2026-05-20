/**
 * Unit tests for removeAppComponent mutation handler
 * Validates: Requirements 2.2, 2.6, 2.8, 2.9, 2.10
 */
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
  version: 1,
  workflowIds: [],
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('removeAppComponent', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
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
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // ─── Deletes component by derived sortId ──────────────────────

  describe('deletes component by derived sortId', () => {
    test('deletes AGENT#{agentId} component item using correct key', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'agent',
          componentId: 'agent-1',
        }),
        {} as any,
        {} as any,
      );

      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls.length).toBe(1);

      // Verify the DeleteCommand was issued with the correct key
      const deleteInput = deleteCalls[0].args[0].input;
      expect(deleteInput.Key).toHaveProperty('appId', 'app-1#AGENT#agent-1');
    });

    test('deletes PERMISSION#{permissionId} component item using correct key', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'permission',
          componentId: 'perm-1',
        }),
        {} as any,
        {} as any,
      );

      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls.length).toBe(1);

      const deleteInput = deleteCalls[0].args[0].input;
      expect(deleteInput.Key).toHaveProperty('appId', 'app-1#PERMISSION#perm-1');
    });
  });

  // ─── Idempotent: no error if component doesn't exist ──────────

  describe('idempotent removal', () => {
    test('returns app unchanged when component does not exist', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      const result = await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'agent',
          componentId: 'nonexistent-agent',
        }),
        {} as any,
        {} as any,
      );

      // Should not throw, should return app
      expect(result.appId).toBe('app-1');

      // DeleteCommand is still called (it's a no-op if item doesn't exist)
      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls.length).toBe(1);
    });
  });

  // ─── Org-scoped access control ────────────────────────────────

  describe('org-scoped access control', () => {
    test('rejects caller whose orgId does not match app orgId', async () => {
      mockCognitoOrg('org-other');
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      await expect(
        handler(
          makeEvent('removeAppComponent', {
            appId: 'app-1',
            componentType: 'agent',
            componentId: 'agent-1',
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Access denied');
    });

    test('rejects when app not found', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      await expect(
        handler(
          makeEvent('removeAppComponent', {
            appId: 'nonexistent',
            componentType: 'agent',
            componentId: 'agent-1',
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── EventBridge event ────────────────────────────────────────

  describe('EventBridge event', () => {
    test('emits app.component.removed event with correct detail', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'agent',
          componentId: 'agent-1',
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls.length).toBeGreaterThanOrEqual(1);

      const removedEvent = ebCalls.find((c) => {
        const entry = c.args[0].input.Entries![0];
        return entry.DetailType === 'app.component.removed';
      });
      expect(removedEvent).toBeDefined();

      const entry = removedEvent!.args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.apps');
      expect(entry.DetailType).toBe('app.component.removed');

      const detail = JSON.parse(entry.Detail!);
      expect(detail.appId).toBe('app-1');
      expect(detail.componentType).toBe('agent');
      expect(detail.componentId).toBe('agent-1');
      expect(detail.userId).toBe('user-123');
    });
  });

  // ─── Returns full app with components ─────────────────────────

  describe('return value', () => {
    test('returns app with components from GroupIndex query after removal', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(DeleteCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({
        Items: [APP_ITEM],
      });

      const result = await handler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'agent',
          componentId: 'agent-1',
        }),
        {} as any,
        {} as any,
      );

      expect(result.appId).toBe('app-1');
      expect(result.agentBindings).toBeDefined();
      expect(result.agentBindings).toHaveLength(0);
      expect(result.permissions).toBeDefined();
    });
  });
});
