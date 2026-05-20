/**
 * Unit tests for app-resolver Lambda — CRUD and binding operations
 * Uses aws-sdk-client-mock for DynamoDB, EventBridge, Cognito
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
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

function makeEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
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

describe('app-resolver', () => {
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

  // ─── getApp ────────────────────────────────────────────────────

  describe('getApp', () => {
    test('returns item when caller orgId matches app orgId', async () => {
      const app = {
        appId: 'app-1',
        orgId: 'org-1',
        name: 'Test App',
        status: 'DRAFT',
        version: 1,
        workflowIds: [],
      };
      ddbMock.on(GetCommand).resolves({ Item: app });
      // getAppWithComponents queries GroupIndex after access check
      ddbMock.on(QueryCommand).resolves({ Items: [{ ...app, groupId: 'APP#app-1', sortId: 'METADATA' }] });

      const result = await handler(
        makeEvent('getApp', { appId: 'app-1' }),
        {} as any,
        {} as any,
      );

      expect(result.appId).toBe('app-1');
      expect(result.name).toBe('Test App');
    });

    test('throws Access denied when caller orgId does not match app orgId', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { appId: 'app-1', orgId: 'org-other', name: 'Other Org App' },
      });

      await expect(
        handler(makeEvent('getApp', { appId: 'app-1' }), {} as any, {} as any),
      ).rejects.toThrow('Access denied');
    });
  });

  // ─── listApps ──────────────────────────────────────────────────

  describe('listApps', () => {
    test('queries OrgIndex GSI scoped to caller orgId', async () => {
      const items = [
        { appId: 'app-1', orgId: 'org-1', name: 'App 1', status: 'DRAFT' },
        { appId: 'app-2', orgId: 'org-1', name: 'App 2', status: 'ACTIVE' },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual({ items, nextToken: undefined });

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('OrgIndex');
    });
  });

  // ─── createApp ─────────────────────────────────────────────────

  describe('createApp', () => {
    test('sets version=1, status=DRAFT, workflowIds=[], generates UUID', async () => {
      ddbMock.on(PutCommand).resolves({});

      const result = await handler(
        makeEvent('createApp', {
          input: {
            name: 'New App',
            description: 'A test app',
            orgId: 'org-1',
          },
        }),
        {} as any,
        {} as any,
      );

      expect(result).toMatchObject({
        name: 'New App',
        orgId: 'org-1',
        status: 'DRAFT',
        version: 1,
        workflowIds: [],
      });
      expect(result.appId).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.createdBy).toBe('user-123');

      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });

  // ─── updateApp ─────────────────────────────────────────────────

  describe('updateApp', () => {
    test('succeeds with correct version (optimistic lock)', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { appId: 'app-1', orgId: 'org-1', version: 1, status: 'DRAFT' },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          appId: 'app-1',
          orgId: 'org-1',
          name: 'Updated Name',
          version: 2,
          status: 'DRAFT',
        },
      });

      const result = await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', name: 'Updated Name', version: 1 },
        }),
        {} as any,
        {} as any,
      );

      expect(result.name).toBe('Updated Name');
      expect(result.version).toBe(2);
    });

    test('throws conflict error when version is stale', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { appId: 'app-1', orgId: 'org-1', version: 3, status: 'DRAFT' },
      });
      const condErr = new Error('ConditionalCheckFailedException');
      condErr.name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateCommand).rejects(condErr);

      await expect(
        handler(
          makeEvent('updateApp', {
            input: { appId: 'app-1', name: 'Stale', version: 1 },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/Conflict/);
    });
  });

  // ─── deleteApp ─────────────────────────────────────────────────

  describe('deleteApp', () => {
    test('unbinds all workflows then deletes the app', async () => {
      // GetCommand returns app with bound workflows
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-1',
            name: 'App To Delete',
            status: 'DRAFT',
            workflowIds: ['wf-1', 'wf-2'],
            version: 1,
          },
        });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(DeleteCommand).resolves({});

      const result = await handler(
        makeEvent('deleteApp', { appId: 'app-1' }),
        {} as any,
        {} as any,
      );

      expect(result).toEqual({ success: true, message: expect.any(String) });

      // Should clear appId on each bound workflow
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);

      // Should delete the app
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });
  });

  // ─── bindWorkflowToApp ────────────────────────────────────────

  describe('bindWorkflowToApp', () => {
    test('appends workflowId to app workflowIds and sets workflow appId', async () => {
      // First GetCommand: app
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-1',
            name: 'My App',
            workflowIds: ['wf-existing'],
            version: 1,
          },
        })
        // Second GetCommand: workflow
        .resolvesOnce({
          Item: {
            workflowId: 'wf-new',
            orgId: 'org-1',
            name: 'New Workflow',
            appId: null,
            version: 1,
          },
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-new' }),
        {} as any,
        {} as any,
      );

      // Should have called UpdateCommand twice: once for app, once for workflow
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
      expect(result).toBeDefined();
    });

    test('rejects cross-org binding (different orgId on workflow vs app)', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: { appId: 'app-1', orgId: 'org-1', workflowIds: [], version: 1 },
        })
        .resolvesOnce({
          Item: { workflowId: 'wf-1', orgId: 'org-other', appId: null, version: 1 },
        });

      await expect(
        handler(
          makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-1' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/org/i);
    });

    test('rejects workflow already bound to a different app', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: { appId: 'app-1', orgId: 'org-1', workflowIds: [], version: 1 },
        })
        .resolvesOnce({
          Item: { workflowId: 'wf-1', orgId: 'org-1', appId: 'app-other', version: 1 },
        });

      await expect(
        handler(
          makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-1' }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/already bound/i);
    });

    test('is idempotent when workflow already bound to same app', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-1',
            name: 'My App',
            workflowIds: ['wf-1'],
            version: 1,
          },
        })
        .resolvesOnce({
          Item: { workflowId: 'wf-1', orgId: 'org-1', appId: 'app-1', version: 1 },
        });

      const result = await handler(
        makeEvent('bindWorkflowToApp', { appId: 'app-1', workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      // Should return app unchanged, no UpdateCommand calls
      expect(result).toBeDefined();
      expect(result.appId).toBe('app-1');
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ─── unbindWorkflowFromApp ────────────────────────────────────

  describe('unbindWorkflowFromApp', () => {
    test('removes workflowId from app workflowIds and clears workflow appId', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({
          Item: {
            appId: 'app-1',
            orgId: 'org-1',
            name: 'My App',
            workflowIds: ['wf-1', 'wf-2'],
            version: 1,
          },
        })
        .resolvesOnce({
          Item: { workflowId: 'wf-1', orgId: 'org-1', appId: 'app-1', version: 1 },
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('unbindWorkflowFromApp', { appId: 'app-1', workflowId: 'wf-1' }),
        {} as any,
        {} as any,
      );

      // Should have called UpdateCommand twice: once for app, once for workflow
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
      expect(result).toBeDefined();
    });
  });

  // ─── EventBridge events ────────────────────────────────────────

  describe('EventBridge events', () => {
    test('emits app.created event on createApp', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(
        makeEvent('createApp', {
          input: { name: 'EB Test App', orgId: 'org-1' },
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.apps');
      expect(entry.DetailType).toBe('app.created');
    });

    test('emits app.updated event on updateApp', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { appId: 'app-1', orgId: 'org-1', version: 1, status: 'DRAFT' },
      });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { appId: 'app-1', orgId: 'org-1', name: 'Updated', version: 2 },
      });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', name: 'Updated', version: 1 },
        }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.apps');
      expect(entry.DetailType).toBe('app.updated');
    });

    test('emits app.deleted event on deleteApp', async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          appId: 'app-1',
          orgId: 'org-1',
          status: 'DRAFT',
          workflowIds: [],
          version: 1,
        },
      });
      ddbMock.on(DeleteCommand).resolves({});

      await handler(
        makeEvent('deleteApp', { appId: 'app-1' }),
        {} as any,
        {} as any,
      );

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('citadel.apps');
      expect(entry.DetailType).toBe('app.deleted');
    });
  });
});
