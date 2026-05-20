/**
 * Property-based tests for org-scoped access control.
 *
 * Property 6: Org-scoped access control
 * **Validates: Requirements 2.9**
 *
 * For any app with orgId = X and any caller with orgId = Y where X ≠ Y,
 * all mutation operations (addAppComponent, removeAppComponent) should be
 * rejected with an "Access denied" error.
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

// ── Generators ──────────────────────────────────────────────

/** Generate a non-empty alphanumeric org ID */
const orgIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Generate a pair of distinct org IDs (app org ≠ caller org) */
const distinctOrgPairArb = fc
  .tuple(orgIdArb, orgIdArb)
  .filter(([appOrg, callerOrg]) => appOrg !== callerOrg);

/** Generate a valid agent ID */
const agentIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Generate a valid permission ID */
const permissionIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Generate a component type for removal */
const componentTypeArb = fc.constantFrom('agent', 'permission');

// ── Property 6 Tests ────────────────────────────────────────

describe('Property 6: Org-scoped access control', () => {
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
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  /**
   * **Validates: Requirements 2.9**
   *
   * For any app with orgId = X and any caller with orgId = Y where X ≠ Y,
   * addAppComponent with type "agent" should reject with "Access denied".
   */
  it('addAppComponent (agent) rejects when caller orgId ≠ app orgId', () => {
    return fc.assert(
      fc.asyncProperty(distinctOrgPairArb, agentIdArb, async ([appOrg, callerOrg], agentId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        mockCognitoOrg(callerOrg);
        ebMock.on(PutEventsCommand).resolves({});

        ddbMock.on(GetCommand).resolves({
          Item: {
            appId: 'app-1',
            orgId: appOrg,
            groupId: 'APP#app-1',
            sortId: 'METADATA',
            name: 'Test App',
            status: 'DRAFT',
            version: 1,
            workflowIds: [],
            createdBy: 'user-other',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        });

        const event = makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId }),
          },
        });

        await expect(handler(event, {} as any, {} as any)).rejects.toThrow('Access denied');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.9**
   *
   * For any app with orgId = X and any caller with orgId = Y where X ≠ Y,
   * addAppComponent with type "permission" should reject with "Access denied".
   */
  it('addAppComponent (permission) rejects when caller orgId ≠ app orgId', () => {
    return fc.assert(
      fc.asyncProperty(distinctOrgPairArb, permissionIdArb, async ([appOrg, callerOrg], permId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        mockCognitoOrg(callerOrg);
        ebMock.on(PutEventsCommand).resolves({});

        ddbMock.on(GetCommand).resolves({
          Item: {
            appId: 'app-1',
            orgId: appOrg,
            groupId: 'APP#app-1',
            sortId: 'METADATA',
            name: 'Test App',
            status: 'DRAFT',
            version: 1,
            workflowIds: [],
            createdBy: 'user-other',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        });

        const event = makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: permId,
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::bucket/*'],
            }),
          },
        });

        await expect(handler(event, {} as any, {} as any)).rejects.toThrow('Access denied');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.9**
   *
   * For any app with orgId = X and any caller with orgId = Y where X ≠ Y,
   * removeAppComponent should reject with "Access denied".
   */
  it('removeAppComponent rejects when caller orgId ≠ app orgId', () => {
    return fc.assert(
      fc.asyncProperty(
        distinctOrgPairArb,
        componentTypeArb,
        agentIdArb,
        async ([appOrg, callerOrg], compType, compId) => {
          ddbMock.reset();
          ebMock.reset();
          cognitoMock.reset();

          mockCognitoOrg(callerOrg);
          ebMock.on(PutEventsCommand).resolves({});

          ddbMock.on(GetCommand).resolves({
            Item: {
              appId: 'app-1',
              orgId: appOrg,
              groupId: 'APP#app-1',
              sortId: 'METADATA',
              name: 'Test App',
              status: 'DRAFT',
              version: 1,
              workflowIds: [],
              createdBy: 'user-other',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          });

          const event = makeEvent('removeAppComponent', {
            appId: 'app-1',
            componentType: compType,
            componentId: compId,
          });

          await expect(handler(event, {} as any, {} as any)).rejects.toThrow('Access denied');
        },
      ),
      { numRuns: 100 },
    );
  });
});
