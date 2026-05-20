/**
 * Unit tests for validatePermissionActions and its integration into addAppComponent
 * Validates: Requirements 4.1, 4.8
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

import { handler, validatePermissionActions } from '../app-resolver';

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

describe('validatePermissionActions', () => {
  test('rejects bare wildcard *', () => {
    const result = validatePermissionActions(['*']);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Bare wildcard');
  });

  test('accepts service-prefixed actions like s3:GetObject', () => {
    const result = validatePermissionActions(['s3:GetObject']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts service-prefixed wildcard like s3:*', () => {
    const result = validatePermissionActions(['s3:*']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts dynamodb:Query', () => {
    const result = validatePermissionActions(['dynamodb:Query']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects invalid format without colon', () => {
    const result = validatePermissionActions(['s3GetObject']);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain('Invalid IAM action format');
  });

  test('rejects empty string', () => {
    const result = validatePermissionActions(['']);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  test('rejects action with spaces', () => {
    const result = validatePermissionActions(['s3: GetObject']);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  test('validates multiple actions and collects all errors', () => {
    const result = validatePermissionActions(['*', 's3:GetObject', 'invalid']);
    expect(result.valid).toBe(false);
    // Should have errors for '*' and 'invalid', but not for 's3:GetObject'
    expect(result.errors.length).toBe(2);
  });

  test('accepts multiple valid actions', () => {
    const result = validatePermissionActions(['s3:GetObject', 'dynamodb:Query', 'lambda:InvokeFunction']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts service names with hyphens like cognito-idp:AdminGetUser', () => {
    const result = validatePermissionActions(['cognito-idp:AdminGetUser']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('addAppComponent permission validation integration', () => {
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

  test('rejects permission component with bare wildcard * in actions', async () => {
    ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

    await expect(
      handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: 'perm-bad',
              actions: ['*'],
              resources: ['arn:aws:s3:::my-bucket/*'],
            }),
          },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow('Bare wildcard');
  });

  test('rejects permission component with invalid action format', async () => {
    ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

    await expect(
      handler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: 'perm-bad',
              actions: ['noColonHere'],
              resources: ['arn:aws:s3:::my-bucket/*'],
            }),
          },
        }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow('Invalid IAM action format');
  });

  test('allows permission component with valid service-prefixed actions', async () => {
    ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

    const result = await handler(
      makeEvent('addAppComponent', {
        appId: 'app-1',
        component: {
          type: 'permission',
          data: JSON.stringify({
            permissionId: 'perm-ok',
            actions: ['s3:GetObject', 'dynamodb:*'],
            resources: ['arn:aws:s3:::my-bucket/*'],
          }),
        },
      }),
      {} as any,
      {} as any,
    );

    // Should succeed and return app
    expect(result).toBeDefined();
    expect(result.appId).toBe('app-1');
  });
});
