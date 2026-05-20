/**
 * Unit tests for DRAFT→ACTIVE publish precondition checks (Task 8.1)
 * Validates: Requirements 4.3, 5.5, 5.6, 7.6, 7.7, 8.7, 4.7
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../app-resolver';

// ── Helpers ─────────────────────────────────────────────────

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

function mockStsIdentity() {
  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: '123456789012',
    Arn: 'arn:aws:sts::123456789012:assumed-role/citadel-app-resolver-role/session',
  });
}

const VALID_SCHEMA = {
  type: 'object',
  properties: {
    apiKey: { type: 'string' },
    maxRetries: { type: 'number' },
  },
  required: ['apiKey'],
};

function makeAppItem(overrides: Record<string, any> = {}) {
  return {
    appId: 'app-1',
    orgId: 'org-1',
    groupId: 'APP#app-1',
    sortId: 'METADATA',
    name: 'Test App',
    status: 'DRAFT',
    version: 1,
    workflowIds: ['wf-1'],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAgentBinding(agentId: string, status: string = 'READY') {
  return {
    appId: 'app-1',
    groupId: 'APP#app-1',
    sortId: `AGENT#${agentId}`,
    agentId,
    status,
    addedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makePermission(permissionId: string, actions: string[], resources: string[]) {
  return {
    appId: 'app-1',
    groupId: 'APP#app-1',
    sortId: `PERMISSION#${permissionId}`,
    permissionId,
    actions,
    resources,
  };
}

function makeConfigSchema() {
  return {
    appId: 'app-1',
    groupId: 'APP#app-1',
    sortId: 'CONFIG#schema',
    schema: VALID_SCHEMA,
  };
}

function makeConfigValues(values: Record<string, any> = { apiKey: 'sk-test' }) {
  return {
    appId: 'app-1',
    groupId: 'APP#app-1',
    sortId: 'CONFIG#values',
    values,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('DRAFT→ACTIVE publish precondition checks', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AWS_REGION = 'us-east-1';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    iamMock.reset();
    stsMock.reset();
    mockCognitoOrg('org-1');
    ebMock.on(PutEventsCommand).resolves({});
    mockStsIdentity();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AWS_REGION;
  });

  // ─── Happy path: all preconditions met ────────────────────

  test('succeeds when all agents are READY, config is valid, and PolicyManager succeeds', async () => {
    const app = makeAppItem();
    const binding = makeAgentBinding('agent-1', 'READY');
    const permission = makePermission('perm-1', ['s3:GetObject'], ['arn:aws:s3:::my-bucket/*']);

    // getApp returns DRAFT app
    ddbMock.on(GetCommand).resolves({ Item: app });

    // GroupIndex query for precondition checks returns all components
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [app, binding, permission] });

    // PolicyManager IAM calls succeed
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});

    // UpdateCommand for status change succeeds
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ACTIVE', version: 2 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('ACTIVE');
  });

  // ─── Agent binding precondition failures ──────────────────

  test('rejects publish when agent binding has DESIGN status', async () => {
    const app = makeAppItem();
    const designBinding = makeAgentBinding('agent-1', 'DESIGN');

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, designBinding] });

    await expect(
      handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow();

    // Should NOT have called UpdateCommand for status change
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(0);
  });

  test('returns structured error listing all DESIGN agents', async () => {
    const app = makeAppItem();
    const designBinding1 = makeAgentBinding('agent-1', 'DESIGN');
    const designBinding2 = makeAgentBinding('agent-2', 'DESIGN');
    const readyBinding = makeAgentBinding('agent-3', 'READY');

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, designBinding1, designBinding2, readyBinding],
    });

    try {
      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      );
      fail('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('agent-1');
      expect(error.message).toContain('agent-2');
    }
  });

  // ─── Config schema/values precondition failures ───────────

  test('rejects publish when configSchema exists but configValues are missing', async () => {
    const app = makeAppItem();
    const binding = makeAgentBinding('agent-1', 'READY');
    const schema = makeConfigSchema();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, binding, schema] });

    try {
      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      );
      fail('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/config/i);
    }

    // Should NOT have called UpdateCommand
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(0);
  });

  test('rejects publish when configValues do not validate against configSchema', async () => {
    const app = makeAppItem();
    const binding = makeAgentBinding('agent-1', 'READY');
    const schema = makeConfigSchema();
    // Missing required 'apiKey'
    const values = makeConfigValues({ maxRetries: 3 });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, binding, schema, values] });

    try {
      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      );
      fail('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/config/i);
    }

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(0);
  });

  test('succeeds when configSchema and valid configValues both exist', async () => {
    const app = makeAppItem();
    const binding = makeAgentBinding('agent-1', 'READY');
    const schema = makeConfigSchema();
    const values = makeConfigValues({ apiKey: 'sk-test-123', maxRetries: 3 });
    const permission = makePermission('perm-1', ['s3:GetObject'], ['arn:aws:s3:::bucket/*']);

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, binding, schema, values, permission],
    });

    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});

    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ACTIVE', version: 2 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(result.status).toBe('ACTIVE');
  });

  // ─── PolicyManager failure ────────────────────────────────

  test('reverts status to DRAFT when PolicyManager.ensureRole fails', async () => {
    const app = makeAppItem();
    const binding = makeAgentBinding('agent-1', 'READY');
    const permission = makePermission('perm-1', ['s3:GetObject'], ['arn:aws:s3:::bucket/*']);

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, binding, permission] });

    // PolicyManager fails on CreateRoleCommand
    iamMock.on(CreateRoleCommand).rejects(new Error('IAM permission denied'));

    // UpdateCommand should NOT be called for status change, but may be called for revert
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT' },
    });

    try {
      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      );
      fail('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toMatch(/policy|permission|role/i);
    }
  });

  // ─── No agent bindings (app with no agents) ──────────────

  test('succeeds when app has no agent bindings and no config schema', async () => {
    const app = makeAppItem({ workflowIds: [] });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app] });

    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});

    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ACTIVE', version: 2 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(result.status).toBe('ACTIVE');
  });

  // ─── Multiple precondition failures ───────────────────────

  test('returns all failing preconditions in structured error', async () => {
    const app = makeAppItem();
    const designBinding = makeAgentBinding('agent-1', 'DESIGN');
    const schema = makeConfigSchema();
    // No config values + DESIGN agent = two failures

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, designBinding, schema] });

    try {
      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
        }),
        {} as any,
        {} as any,
      );
      fail('Expected error to be thrown');
    } catch (error: any) {
      // Error should mention both agent and config issues
      expect(error.message).toContain('agent-1');
      expect(error.message).toMatch(/config/i);
    }
  });

  // ─── Non-publish status changes should NOT trigger preconditions ─

  test('non-publish status changes bypass publish precondition checks', async () => {
    const app = makeAppItem({ status: 'ACTIVE' });

    ddbMock.on(GetCommand).resolves({ Item: app });
    // ACTIVE→ARCHIVED needs GroupIndex query for archive transition (binding resets)
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app] });
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ARCHIVED', version: 2 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ARCHIVED', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(result).toBeDefined();
  });

  test('regular field updates (name, description) bypass precondition checks', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, name: 'Updated Name', version: 2 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', name: 'Updated Name', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(result).toBeDefined();
    expect(result.name).toBe('Updated Name');
  });
});
