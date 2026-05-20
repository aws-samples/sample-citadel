/**
 * Property-based tests for status transition event construction.
 *
 * Property 16: Status transition event construction
 * **Validates: Requirements 8.1, 8.2**
 *
 * For any valid app status transition (DRAFT→ACTIVE, ACTIVE→ARCHIVED, ARCHIVED→DRAFT),
 * the constructed EventBridge event should have:
 *   (a) correct detail type: app.status.{from}_to_{to} (lowercase)
 *   (b) all required fields: appId, orgId, previousStatus, newStatus, userId, timestamp (ISO 8601), correlationId
 *   (c) source: citadel.apps
 */
import * as fc from 'fast-check';
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

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue({}),
}));

import { handler } from '../app-resolver';

// ── Valid transitions ───────────────────────────────────────

const VALID_TRANSITIONS: Array<{ from: string; to: string }> = [
  { from: 'DRAFT', to: 'ACTIVE' },
  { from: 'ACTIVE', to: 'ARCHIVED' },
  { from: 'ARCHIVED', to: 'DRAFT' },
];

// ── Generators ──────────────────────────────────────────────

const transitionArb = fc.constantFrom(...VALID_TRANSITIONS);

const appIdArb = fc.string({ minLength: 1, maxLength: 36 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

const orgIdArb = fc.string({ minLength: 1, maxLength: 36 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

// ── Helpers ─────────────────────────────────────────────────

function makeEvent(fieldName: string, args: any) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as any;
}

function makeAppItem(appId: string, orgId: string, status: string) {
  return {
    appId,
    orgId,
    groupId: `APP#${appId}`,
    sortId: 'METADATA',
    name: 'Test App',
    status,
    version: 1,
    workflowIds: [],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function setupMocksForTransition(
  appId: string,
  orgId: string,
  fromStatus: string,
  toStatus: string,
) {
  const app = makeAppItem(appId, orgId, fromStatus);

  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });

  ebMock.on(PutEventsCommand).resolves({});

  stsMock.on(GetCallerIdentityCommand).resolves({
    Account: '123456789012',
    Arn: 'arn:aws:sts::123456789012:assumed-role/citadel-app-resolver-role/session',
  });

  // DRAFT→ACTIVE needs preconditions to pass (no DESIGN agents, no config issues)
  if (fromStatus === 'DRAFT' && toStatus === 'ACTIVE') {
    ddbMock.on(GetCommand).resolves({ Item: app });
    // GroupIndex query for precondition check — app only, no DESIGN agents
    ddbMock.on(QueryCommand).resolves({ Items: [app] });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
  }

  // ACTIVE→ARCHIVED needs IAM cleanup
  if (fromStatus === 'ACTIVE' && toStatus === 'ARCHIVED') {
    ddbMock.on(GetCommand).resolves({ Item: app });
    ddbMock.on(QueryCommand).resolves({ Items: [app] });
    iamMock.on(DeleteRolePolicyCommand).resolves({});
    iamMock.on(DeleteRoleCommand).resolves({});
  }

  // ARCHIVED→DRAFT is a simple status update
  if (fromStatus === 'ARCHIVED' && toStatus === 'DRAFT') {
    ddbMock.on(GetCommand).resolves({ Item: app });
  }

  ddbMock.on(UpdateCommand).resolves({
    Attributes: { ...app, status: toStatus, version: 2 },
  });
}

function extractStatusEvent(fromStatus: string, toStatus: string): any | undefined {
  const expectedDetailType = `app.status.${fromStatus.toLowerCase()}_to_${toStatus.toLowerCase()}`;
  const ebCalls = ebMock.commandCalls(PutEventsCommand);
  const allEntries = ebCalls.flatMap(c => c.args[0].input.Entries || []);
  return allEntries.find(e => e?.DetailType === expectedDetailType);
}

// ── Property 16: Status transition event construction ───────

describe('Property 16: Status transition event construction', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
    iamMock.reset();
    stsMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.APPSYNC_ENDPOINT;
  });

  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * For any valid status transition and any appId/orgId, the EventBridge event
   * detail type must be `app.status.{from}_to_{to}` in lowercase.
   */
  it('event detail type follows app.status.{from}_to_{to} pattern (lowercase)', () => {
    return fc.assert(
      fc.asyncProperty(transitionArb, appIdArb, orgIdArb, async (transition, appId, orgId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupMocksForTransition(appId, orgId, transition.from, transition.to);

        await handler(
          makeEvent('updateApp', {
            input: { appId, status: transition.to, version: 1 },
          }),
          {} as any,
          {} as any,
        );

        const statusEvent = extractStatusEvent(transition.from, transition.to);
        expect(statusEvent).toBeDefined();

        const expectedDetailType = `app.status.${transition.from.toLowerCase()}_to_${transition.to.toLowerCase()}`;
        expect(statusEvent!.DetailType).toBe(expectedDetailType);
      }),
      { numRuns: 30 },
    );
  });

  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * For any valid status transition, the event source must be `citadel.apps`.
   */
  it('event source is citadel.apps for all transitions', () => {
    return fc.assert(
      fc.asyncProperty(transitionArb, appIdArb, orgIdArb, async (transition, appId, orgId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupMocksForTransition(appId, orgId, transition.from, transition.to);

        await handler(
          makeEvent('updateApp', {
            input: { appId, status: transition.to, version: 1 },
          }),
          {} as any,
          {} as any,
        );

        const statusEvent = extractStatusEvent(transition.from, transition.to);
        expect(statusEvent).toBeDefined();
        expect(statusEvent!.Source).toBe('citadel.apps');
      }),
      { numRuns: 30 },
    );
  });

  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * For any valid status transition, the event detail must contain all required
   * fields: appId, orgId, previousStatus, newStatus, userId, timestamp, correlationId.
   */
  it('event detail contains all required fields', () => {
    return fc.assert(
      fc.asyncProperty(transitionArb, appIdArb, orgIdArb, async (transition, appId, orgId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupMocksForTransition(appId, orgId, transition.from, transition.to);

        await handler(
          makeEvent('updateApp', {
            input: { appId, status: transition.to, version: 1 },
          }),
          {} as any,
          {} as any,
        );

        const statusEvent = extractStatusEvent(transition.from, transition.to);
        expect(statusEvent).toBeDefined();

        const detail = JSON.parse(statusEvent!.Detail!);

        // All required fields must be present
        expect(detail).toHaveProperty('appId');
        expect(detail).toHaveProperty('orgId');
        expect(detail).toHaveProperty('previousStatus');
        expect(detail).toHaveProperty('newStatus');
        expect(detail).toHaveProperty('userId');
        expect(detail).toHaveProperty('timestamp');
        expect(detail).toHaveProperty('correlationId');

        // Field values must match the transition context
        expect(detail.appId).toBe(appId);
        expect(detail.orgId).toBe(orgId);
        expect(detail.previousStatus).toBe(transition.from);
        expect(detail.newStatus).toBe(transition.to);
        expect(detail.userId).toBe('user-123');
      }),
      { numRuns: 30 },
    );
  });

  /**
   * **Validates: Requirements 8.2**
   *
   * For any valid status transition, the timestamp field must be a valid ISO 8601 string.
   */
  it('event timestamp is valid ISO 8601', () => {
    return fc.assert(
      fc.asyncProperty(transitionArb, appIdArb, orgIdArb, async (transition, appId, orgId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupMocksForTransition(appId, orgId, transition.from, transition.to);

        await handler(
          makeEvent('updateApp', {
            input: { appId, status: transition.to, version: 1 },
          }),
          {} as any,
          {} as any,
        );

        const statusEvent = extractStatusEvent(transition.from, transition.to);
        expect(statusEvent).toBeDefined();

        const detail = JSON.parse(statusEvent!.Detail!);
        const parsed = new Date(detail.timestamp);
        expect(parsed.toISOString()).toBe(detail.timestamp);
        expect(isNaN(parsed.getTime())).toBe(false);
      }),
      { numRuns: 30 },
    );
  });

  /**
   * **Validates: Requirements 8.2**
   *
   * For any valid status transition, the correlationId must be a non-empty string.
   */
  it('event correlationId is a non-empty string', () => {
    return fc.assert(
      fc.asyncProperty(transitionArb, appIdArb, orgIdArb, async (transition, appId, orgId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        iamMock.reset();
        stsMock.reset();

        setupMocksForTransition(appId, orgId, transition.from, transition.to);

        await handler(
          makeEvent('updateApp', {
            input: { appId, status: transition.to, version: 1 },
          }),
          {} as any,
          {} as any,
        );

        const statusEvent = extractStatusEvent(transition.from, transition.to);
        expect(statusEvent).toBeDefined();

        const detail = JSON.parse(statusEvent!.Detail!);
        expect(typeof detail.correlationId).toBe('string');
        expect(detail.correlationId.length).toBeGreaterThan(0);
      }),
      { numRuns: 30 },
    );
  });
});
