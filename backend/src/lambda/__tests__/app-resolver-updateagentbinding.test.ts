/**
 * Unit tests for updateAgentBinding mutation handler
 * Validates: Requirements 3.3, 3.4, 3.5, 5.3, 5.4
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
  version: 1,
  workflowIds: [],
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const AGENT_BINDING_ITEM = {
  appId: 'app-1',
  groupId: 'APP#app-1',
  sortId: 'AGENT#agent-1',
  agentId: 'agent-1',
  status: 'DESIGN',
  addedAt: '2024-01-01T00:00:00.000Z',
};

describe('updateAgentBinding', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
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
    delete process.env.AGENT_CONFIG_TABLE;
  });

  // ─── Binding exists validation (Req 3.5) ──────────────────────

  describe('binding existence validation', () => {
    test('throws error when agent binding does not exist for the app', async () => {
      // App exists but no agent binding found in GroupIndex query
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      // Binding query returns empty (no matching AGENT# item)
      ddbMock.on(QueryCommand).resolvesOnce({ Items: [] });

      await expect(
        handler(
          makeEvent('updateAgentBinding', {
            input: {
              appId: 'app-1',
              agentId: 'agent-1',
              systemPromptAddition: 'Be helpful',
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Agent is not a component of this app');
    });

    test('throws error when app does not exist', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      await expect(
        handler(
          makeEvent('updateAgentBinding', {
            input: {
              appId: 'nonexistent',
              agentId: 'agent-1',
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('App not found');
    });
  });

  // ─── Org-scoped access control ────────────────────────────────

  describe('org-scoped access control', () => {
    test('rejects caller whose orgId does not match app orgId', async () => {
      mockCognitoOrg('org-other');
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

      await expect(
        handler(
          makeEvent('updateAgentBinding', {
            input: {
              appId: 'app-1',
              agentId: 'agent-1',
              systemPromptAddition: 'Be helpful',
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Access denied');
    });
  });

  // ─── Override field updates (Req 3.4) ─────────────────────────

  describe('override field updates', () => {
    test('updates systemPromptAddition on existing binding', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      // First QueryCommand: check binding exists
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        // Second QueryCommand: getAppWithComponents return
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...AGENT_BINDING_ITEM, systemPromptAddition: 'Be helpful' },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            systemPromptAddition: 'Be helpful',
          },
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('updates toolRestrictions on existing binding', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...AGENT_BINDING_ITEM, toolRestrictions: ['tool-x', 'tool-y'] },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            toolRestrictions: ['tool-x', 'tool-y'],
          },
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('updates modelOverride on existing binding', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...AGENT_BINDING_ITEM, modelOverride: 'us.anthropic.claude-sonnet-4-6' },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            modelOverride: 'us.anthropic.claude-sonnet-4-6',
          },
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('updates multiple override fields at once', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] });
      ddbMock.on(UpdateCommand).resolves({});

      await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            systemPromptAddition: 'Be concise',
            toolRestrictions: ['tool-z'],
            modelOverride: 'us.anthropic.claude-haiku-3',
          },
        }),
        {} as any,
        {} as any,
      );

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Status change to READY (Req 5.3, 5.4) ───────────────────

  describe('status change to READY', () => {
    test('succeeds when agent exists with state=active', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({ Item: APP_ITEM }) // getApp
        .resolvesOnce({ Item: { agentId: 'agent-1', state: 'active', config: {} } }); // agent lookup
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...AGENT_BINDING_ITEM, status: 'READY' },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            status: 'READY',
          },
        }),
        {} as any,
        {} as any,
      );

      expect(result).toBeDefined();
      expect(result.appId).toBe('app-1');
    });

    test('throws error when agent does not exist in agents table', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({ Item: APP_ITEM }) // getApp
        .resolvesOnce({ Item: undefined }); // agent not found
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] });

      await expect(
        handler(
          makeEvent('updateAgentBinding', {
            input: {
              appId: 'app-1',
              agentId: 'agent-1',
              status: 'READY',
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Agent must be active before it can be marked as ready');
    });

    test('throws error when agent exists but state is not active', async () => {
      ddbMock.on(GetCommand)
        .resolvesOnce({ Item: APP_ITEM }) // getApp
        .resolvesOnce({ Item: { agentId: 'agent-1', state: 'inactive', config: {} } }); // agent inactive
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] });

      await expect(
        handler(
          makeEvent('updateAgentBinding', {
            input: {
              appId: 'app-1',
              agentId: 'agent-1',
              status: 'READY',
            },
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow('Agent must be active before it can be marked as ready');
    });

    test('allows status change to DESIGN without agent validation', async () => {
      const readyBinding = { ...AGENT_BINDING_ITEM, status: 'READY' };
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, readyBinding] })
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...readyBinding, status: 'DESIGN' },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            status: 'DESIGN',
          },
        }),
        {} as any,
        {} as any,
      );

      // Should NOT have queried the agents table
      const getCalls = ddbMock.commandCalls(GetCommand);
      // Only 1 GetCommand for getApp, no second for agent lookup
      expect(getCalls.length).toBe(1);
      expect(result).toBeDefined();
    });
  });

  // ─── Return value ─────────────────────────────────────────────

  describe('return value', () => {
    test('returns full app with components via getAppWithComponents', async () => {
      ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [APP_ITEM, AGENT_BINDING_ITEM] })
        .resolvesOnce({
          Items: [
            APP_ITEM,
            { ...AGENT_BINDING_ITEM, systemPromptAddition: 'Updated' },
          ],
        });
      ddbMock.on(UpdateCommand).resolves({});

      const result = await handler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            systemPromptAddition: 'Updated',
          },
        }),
        {} as any,
        {} as any,
      );

      expect(result.appId).toBe('app-1');
      expect(result.agentBindings).toBeDefined();
      expect(result.agentBindings.length).toBe(1);
    });
  });
});
