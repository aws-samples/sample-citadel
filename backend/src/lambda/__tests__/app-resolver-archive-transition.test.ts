/**
 * Unit tests for ACTIVE→ARCHIVED transition logic (Task 8.2)
 * Validates: Requirements 4.6, 8.8
 *
 * When status changes from ACTIVE to ARCHIVED:
 * 1. Call PolicyManager.deleteRole(appId, 'agent') to clean up scoped IAM role
 * 2. Query GroupIndex for all AGENT# bindings and update each to status=DESIGN
 * 3. Then proceed with the normal status update
 */
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, DeleteRoleCommand, DeleteRolePolicyCommand } from '@aws-sdk/client-iam';
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

function makeAppItem(overrides: Record<string, any> = {}) {
  return {
    appId: 'app-1',
    orgId: 'org-1',
    groupId: 'APP#app-1',
    sortId: 'METADATA',
    name: 'Test App',
    status: 'ACTIVE',
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

// ── Tests ───────────────────────────────────────────────────

describe('ACTIVE→ARCHIVED transition logic', () => {
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
    iamMock.reset();
    stsMock.reset();
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

  test('calls PolicyManager.deleteRole(appId, "agent") when transitioning ACTIVE→ARCHIVED', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    // GroupIndex query returns app metadata + agent bindings
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, makeAgentBinding('agent-1', 'READY')],
    });
    // IAM deleteRole calls succeed
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
    // UpdateCommand for binding reset + status change
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

    // Verify deleteRole was called (DeleteRolePolicyCommand + DeleteRoleCommand)
    const deletePolicyCalls = iamMock.commandCalls(DeleteRolePolicyCommand);
    expect(deletePolicyCalls.length).toBe(1);
    expect(deletePolicyCalls[0].args[0].input.RoleName).toBe('citadel-agent-app-1');

    const deleteRoleCalls = iamMock.commandCalls(DeleteRoleCommand);
    expect(deleteRoleCalls.length).toBe(1);
    expect(deleteRoleCalls[0].args[0].input.RoleName).toBe('citadel-agent-app-1');
  });

  test('resets all AGENT# bindings to status=DESIGN', async () => {
    const app = makeAppItem();
    const binding1 = makeAgentBinding('agent-1', 'READY');
    const binding2 = makeAgentBinding('agent-2', 'READY');

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, binding1, binding2],
    });
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ARCHIVED', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ARCHIVED', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    // Should have UpdateCommand calls for each binding + the status update
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    // 2 binding resets + 1 status update = 3
    expect(updateCalls.length).toBe(3);

    // Check binding reset calls set status to DESIGN
    const bindingResetCalls = updateCalls.filter(call => {
      const input = call.args[0].input;
      return input.ExpressionAttributeValues?.[':designStatus'] === 'DESIGN';
    });
    expect(bindingResetCalls.length).toBe(2);
  });

  test('succeeds when app has no agent bindings', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    // GroupIndex query returns only metadata (no bindings)
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
    expect(result.status).toBe('ARCHIVED');

    // Only 1 UpdateCommand for the status change (no binding resets)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
  });

  test('resets DESIGN bindings too (all bindings become DESIGN)', async () => {
    const app = makeAppItem();
    const readyBinding = makeAgentBinding('agent-1', 'READY');
    const designBinding = makeAgentBinding('agent-2', 'DESIGN');

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, readyBinding, designBinding],
    });
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ARCHIVED', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ARCHIVED', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    // 2 binding resets + 1 status update = 3
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(3);
  });

  test('handles PolicyManager.deleteRole failure gracefully', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [app, makeAgentBinding('agent-1', 'READY')],
    });
    // PolicyManager fails
    iamMock.on(DeleteRolePolicyCommand).rejects(new Error('IAM permission denied'));

    await expect(
      handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'ARCHIVED', version: 1 },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow();
  });
});
