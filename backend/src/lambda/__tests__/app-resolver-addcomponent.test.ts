/**
 * Unit tests for addAppComponent mutation handler
 * Validates: Requirements 2.1, 2.3, 2.4, 2.5, 2.7, 2.9, 2.10
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

describe('addAppComponent', () => {
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

  // ─── Agent component ──────────────────────────────────────────

  describe('type "agent"', () => {
    test('creates AGENT#{agentId} component with DESIGN status', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({
        Items: [
          APP_ITEM,
          {
            appId: 'app-1',
            groupId: 'APP#app-1',
            sortId: 'AGENT#agent-1',
            agentId: 'agent-1',
            status: 'DESIGN',
            addedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      });

      const result = await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
        {} as any,
        {} as any,
      );

      // Verify PutCommand was called for the component
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThanOrEqual(1);

      const componentPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'AGENT#agent-1',
      );
      expect(componentPut).toBeDefined();

      const item = componentPut!.args[0].input.Item!;
      expect(item.groupId).toBe('APP#app-1');
      expect(item.sortId).toBe('AGENT#agent-1');
      expect(item.agentId).toBe('agent-1');
      expect(item.status).toBe('DESIGN');
      expect(item.addedAt).toBeDefined();
      expect(item.appId).toBe('app-1#AGENT#agent-1');
    });

    test('includes override fields from data when provided', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({
              agentId: 'agent-2',
              systemPromptAddition: 'Be helpful',
              toolRestrictions: ['tool-x'],
              modelOverride: 'us.anthropic.claude-sonnet-4-6',
            }),
          },
        }),
        {} as any,
        {} as any,
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      const componentPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'AGENT#agent-2',
      );
      expect(componentPut).toBeDefined();

      const item = componentPut!.args[0].input.Item!;
      expect(item.systemPromptAddition).toBe('Be helpful');
      expect(item.toolRestrictions).toEqual(['tool-x']);
      expect(item.modelOverride).toBe('us.anthropic.claude-sonnet-4-6');
    });
  });

  // ─── Permission component ─────────────────────────────────────

  describe('type "permission"', () => {
    test('creates PERMISSION#{permissionId} component', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: 'perm-1',
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::my-bucket/*'],
              description: 'Read access to S3',
            }),
          },
        }),
        {} as any,
        {} as any,
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      const componentPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'PERMISSION#perm-1',
      );
      expect(componentPut).toBeDefined();

      const item = componentPut!.args[0].input.Item!;
      expect(item.groupId).toBe('APP#app-1');
      expect(item.sortId).toBe('PERMISSION#perm-1');
      expect(item.permissionId).toBe('perm-1');
      expect(item.actions).toEqual(['s3:GetObject']);
      expect(item.resources).toEqual(['arn:aws:s3:::my-bucket/*']);
      expect(item.description).toBe('Read access to S3');
      expect(item.appId).toBe('app-1#PERMISSION#perm-1');
    });
  });

  // ─── Upsert behavior ──────────────────────────────────────────

  describe('upsert behavior', () => {
    test('PutCommand overwrites existing component (no condition expression)', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
        {} as any,
        {} as any,
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      const componentPut = putCalls.find(
        (c) => c.args[0].input.Item?.sortId === 'AGENT#agent-1',
      );
      // PutCommand should NOT have a ConditionExpression (upsert)
      expect(componentPut!.args[0].input.ConditionExpression).toBeUndefined();
    });
  });

  // ─── Org-scoped access control ────────────────────────────────

  describe('org-scoped access control', () => {
    test('rejects caller whose orgId does not match app orgId', async () => {
      mockCognitoOrg('org-other');
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      await expect(
        handler(
          makeEvent('addAppComponent', {
            appId: 'app-1',
            component: {
              type: 'agent',
              data: JSON.stringify({ agentId: 'agent-1' }),
            },
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
          makeEvent('addAppComponent', {
            appId: 'nonexistent',
            component: {
              type: 'agent',
              data: JSON.stringify({ agentId: 'agent-1' }),
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── EventBridge event ────────────────────────────────────────

  describe('EventBridge event', () => {
    test('emits app.component.added event with correct detail', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

      await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls.length).toBeGreaterThanOrEqual(1);

      const addedEvent = ebCalls.find((c) => {
        const entry = c.args[0].input.Entries![0];
        return entry.DetailType === 'app.component.added';
      });
      expect(addedEvent).toBeDefined();

      const entry = addedEvent!.args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.apps');
      expect(entry.DetailType).toBe('app.component.added');

      const detail = JSON.parse(entry.Detail!);
      expect(detail.appId).toBe('app-1');
      expect(detail.componentType).toBe('agent');
      expect(detail.componentId).toBe('agent-1');
      expect(detail.userId).toBe('user-123');
    });
  });

  // ─── Returns full app with components ─────────────────────────

  describe('return value', () => {
    test('returns app with components from GroupIndex query', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(QueryCommand).resolves({
        Items: [
          APP_ITEM,
          {
            appId: 'app-1',
            groupId: 'APP#app-1',
            sortId: 'AGENT#agent-1',
            agentId: 'agent-1',
            status: 'DESIGN',
            addedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      });

      const result = await handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
        {} as any,
        {} as any,
      );

      // Should return the full app with components
      expect(result.appId).toBe('app-1');
      expect(result.agentBindings).toBeDefined();
      expect(result.permissions).toBeDefined();
    });
  });
});
