/**
 * Unit tests for EventBridge event emission on status transitions (Task 8.4)
 * Validates: Requirements 8.1, 8.2, 8.6
 *
 * When a status transition occurs in updateApp:
 * 1. Emit EventBridge event with source `citadel.apps` and detail type `app.status.{from}_to_{to}`
 * 2. Include appId, orgId, previousStatus, newStatus, userId, timestamp (ISO 8601), correlationId
 * 3. Call publishAppStatusEvent mutation via AppSync for subscription
 */
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

// Mock the appsync utility
jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

// Mock the appsync-publish utility for publishAppStatusEvent
const mockPublishAppStatusEvent = jest.fn().mockResolvedValue({});
jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: mockPublishAppStatusEvent,
}));

// Mock uuid to return predictable values
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-correlation-id'),
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

function makeAppItem(overrides: Record<string, any> = {}) {
  return {
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

// ── Tests ───────────────────────────────────────────────────

describe('EventBridge status transition event emission', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
    process.env.AWS_REGION = 'us-east-1';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    iamMock.reset();
    stsMock.reset();
    mockPublishAppStatusEvent.mockClear();
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
    delete process.env.APPSYNC_ENDPOINT;
    delete process.env.AWS_REGION;
  });

  // ─── DRAFT → ACTIVE ──────────────────────────────────────

  test('emits app.status.draft_to_active EventBridge event on DRAFT→ACTIVE transition', async () => {
    const app = makeAppItem({ status: 'DRAFT' });
    const binding = makeAgentBinding('agent-1', 'READY');
    const permission = makePermission('perm-1', ['s3:GetObject'], ['arn:aws:s3:::bucket/*']);

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, binding, permission] });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ACTIVE', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    // Should have at least 2 EventBridge calls: app.updated + app.status.draft_to_active
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(e => e?.DetailType === 'app.status.draft_to_active');

    expect(statusEvent).toBeDefined();
    expect(statusEvent!.Source).toBe('citadel.apps');
    expect(statusEvent!.EventBusName).toBe('citadel-agents-test');

    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-1');
    expect(detail.previousStatus).toBe('DRAFT');
    expect(detail.newStatus).toBe('ACTIVE');
    expect(detail.userId).toBe('user-123');
    expect(detail.timestamp).toBeDefined();
    expect(detail.correlationId).toBe('test-correlation-id');
  });

  // ─── ACTIVE → ARCHIVED ───────────────────────────────────

  test('emits app.status.active_to_archived EventBridge event on ACTIVE→ARCHIVED transition', async () => {
    const app = makeAppItem({ status: 'ACTIVE' });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app] });
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

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(e => e?.DetailType === 'app.status.active_to_archived');

    expect(statusEvent).toBeDefined();
    expect(statusEvent!.Source).toBe('citadel.apps');

    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-1');
    expect(detail.previousStatus).toBe('ACTIVE');
    expect(detail.newStatus).toBe('ARCHIVED');
    expect(detail.userId).toBe('user-123');
    expect(detail.timestamp).toBeDefined();
    expect(detail.correlationId).toBe('test-correlation-id');
  });

  // ─── ARCHIVED → DRAFT ────────────────────────────────────

  test('emits app.status.archived_to_draft EventBridge event on ARCHIVED→DRAFT transition', async () => {
    const app = makeAppItem({ status: 'ARCHIVED', version: 3 });

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

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(e => e?.DetailType === 'app.status.archived_to_draft');

    expect(statusEvent).toBeDefined();
    expect(statusEvent!.Source).toBe('citadel.apps');

    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-1');
    expect(detail.previousStatus).toBe('ARCHIVED');
    expect(detail.newStatus).toBe('DRAFT');
    expect(detail.userId).toBe('user-123');
    expect(detail.timestamp).toBeDefined();
    expect(detail.correlationId).toBe('test-correlation-id');
  });

  // ─── Event detail field validation ────────────────────────

  test('status event timestamp is valid ISO 8601', async () => {
    const app = makeAppItem({ status: 'ARCHIVED', version: 3 });

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

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(e => e?.DetailType === 'app.status.archived_to_draft');
    const detail = JSON.parse(statusEvent!.Detail!);

    // Verify timestamp is valid ISO 8601
    const parsed = new Date(detail.timestamp);
    expect(parsed.toISOString()).toBe(detail.timestamp);
  });

  // ─── No status event for non-status updates ──────────────

  test('does not emit status transition event for non-status updates', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, name: 'Updated Name', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', name: 'Updated Name', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvents = allEntries.filter(e => e?.DetailType?.startsWith('app.status.'));

    expect(statusEvents.length).toBe(0);
  });

  test('does not emit status transition event when status is unchanged', async () => {
    const app = makeAppItem({ status: 'DRAFT' });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, name: 'Updated', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', name: 'Updated', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
    const statusEvents = allEntries.filter(e => e?.DetailType?.startsWith('app.status.'));

    expect(statusEvents.length).toBe(0);
  });

  // ─── AppSync subscription publishing ─────────────────────

  test('calls publishAppStatusEvent for DRAFT→ACTIVE transition', async () => {
    const app = makeAppItem({ status: 'DRAFT' });
    const binding = makeAgentBinding('agent-1', 'READY');
    const permission = makePermission('perm-1', ['s3:GetObject'], ['arn:aws:s3:::bucket/*']);

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app, binding, permission] });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'ACTIVE', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'ACTIVE', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(mockPublishAppStatusEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishAppStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        previousStatus: 'DRAFT',
        newStatus: 'ACTIVE',
        timestamp: expect.any(String),
      }),
    );
  });

  test('calls publishAppStatusEvent for ACTIVE→ARCHIVED transition', async () => {
    const app = makeAppItem({ status: 'ACTIVE' });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [app] });
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

    expect(mockPublishAppStatusEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishAppStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        previousStatus: 'ACTIVE',
        newStatus: 'ARCHIVED',
      }),
    );
  });

  test('calls publishAppStatusEvent for ARCHIVED→DRAFT transition', async () => {
    const app = makeAppItem({ status: 'ARCHIVED', version: 3 });

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

    expect(mockPublishAppStatusEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishAppStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        previousStatus: 'ARCHIVED',
        newStatus: 'DRAFT',
      }),
    );
  });

  test('does not call publishAppStatusEvent for non-status updates', async () => {
    const app = makeAppItem();

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, name: 'Updated Name', version: 2 },
    });

    await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', name: 'Updated Name', version: 1 },
      }),
      {} as any,
      {} as any,
    );

    expect(mockPublishAppStatusEvent).not.toHaveBeenCalled();
  });

  // ─── Graceful handling of AppSync publish failure ─────────

  test('does not fail updateApp if publishAppStatusEvent throws', async () => {
    mockPublishAppStatusEvent.mockRejectedValueOnce(new Error('AppSync unreachable'));

    const app = makeAppItem({ status: 'ARCHIVED', version: 3 });

    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...app, status: 'DRAFT', version: 4 },
    });

    // Should not throw — AppSync publish failure is non-fatal
    const result = await handler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
      {} as any,
      {} as any,
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('DRAFT');
  });
});
