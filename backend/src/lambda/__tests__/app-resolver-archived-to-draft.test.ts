/**
 * Unit tests for ARCHIVED→DRAFT transition logic (Task 8.3)
 * Validates: Requirement 8.1
 *
 * The ARCHIVED→DRAFT transition is a simple status update with no precondition
 * checks — no IAM role creation, no binding validation, no config checks.
 * The existing updateApp flow handles it without special logic.
 */
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

function makeArchivedApp(overrides: Record<string, any> = {}) {
  return {
    appId: 'app-1',
    orgId: 'org-1',
    groupId: 'APP#app-1',
    sortId: 'METADATA',
    name: 'Test App',
    status: 'ARCHIVED',
    version: 3,
    workflowIds: ['wf-1'],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('ARCHIVED→DRAFT transition logic', () => {
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

  test('transitions ARCHIVED→DRAFT with a simple status update', async () => {
    const app = makeArchivedApp();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT', version: 4 },
    });

    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
      {} as any,
      {} as any,
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('DRAFT');
    expect(result.version).toBe(4);
  });

  test('does not call PolicyManager or query GroupIndex for bindings', async () => {
    const app = makeArchivedApp();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT', version: 4 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
      {} as any,
      {} as any,
    );

    // Only 1 UpdateCommand for the status change — no binding resets
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);

    // The status update should set status to DRAFT
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.ExpressionAttributeValues).toHaveProperty(':status', 'DRAFT');
  });

  test('emits app.updated event after transition', async () => {
    const app = makeArchivedApp();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT', version: 4 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
      {} as any,
      {} as any,
    );

    // Verify EventBridge event was emitted
    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    expect(ebCalls.length).toBeGreaterThanOrEqual(1);

    const eventEntry = ebCalls[0].args[0].input.Entries?.[0];
    expect(eventEntry?.Source).toBe('citadel.apps');
    expect(eventEntry?.DetailType).toBe('app.updated');
  });

  test('uses optimistic locking via version field', async () => {
    const app = makeArchivedApp({ version: 5 });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT', version: 6 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 5 },
      }),
      {} as any,
      {} as any,
    );

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const updateInput = updateCalls[0].args[0].input;

    // Should check current version and increment
    expect(updateInput.ConditionExpression).toBe('version = :currentVersion');
    expect(updateInput.ExpressionAttributeValues).toHaveProperty(':currentVersion', 5);
    expect(updateInput.ExpressionAttributeValues).toHaveProperty(':nextVersion', 6);
  });

  test('rejects transition when app not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await expect(
      handler(
        makeEvent('updateApp', {
          input: { appId: 'nonexistent', status: 'DRAFT', version: 1 },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow('App not found');
  });

  test('rejects transition when org does not match', async () => {
    const app = makeArchivedApp({ orgId: 'org-other' });

    ddbMock.on(GetCommand).resolves({ Item: app });

    await expect(
      handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'DRAFT', version: 3 },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow('Access denied');
  });
});
