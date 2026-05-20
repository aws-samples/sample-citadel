/**
 * Unit test for createApp writing groupId/sortId fields
 * Validates: Requirement 1.2 — app metadata item includes groupId=APP#{appId} and sortId=METADATA
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
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
import { deriveGroupId } from '../app-resolver';

function makeEvent(fieldName: string, args: any) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as any;
}

describe('createApp — groupId/sortId fields', () => {
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
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'custom:organization', Value: 'org-1' },
      ],
    });
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  test('PutCommand item includes groupId set to APP#{appId}', async () => {
    const result = await handler(
      makeEvent('createApp', {
        input: { name: 'Test App', description: 'desc', orgId: 'org-1' },
      }),
      {} as any,
      {} as any,
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);

    const item = putCalls[0].args[0].input.Item!;
    expect(item.groupId).toBe(`APP#${result.appId}`);
  });

  test('PutCommand item includes sortId set to METADATA', async () => {
    const result = await handler(
      makeEvent('createApp', {
        input: { name: 'Test App', description: 'desc', orgId: 'org-1' },
      }),
      {} as any,
      {} as any,
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.sortId).toBe('METADATA');
  });

  test('groupId uses deriveGroupId helper', async () => {
    const result = await handler(
      makeEvent('createApp', {
        input: { name: 'Helper Test', orgId: 'org-1' },
      }),
      {} as any,
      {} as any,
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.groupId).toBe(deriveGroupId(result.appId));
  });

  test('returned app object includes groupId and sortId', async () => {
    const result = await handler(
      makeEvent('createApp', {
        input: { name: 'Return Test', orgId: 'org-1' },
      }),
      {} as any,
      {} as any,
    );

    expect(result.groupId).toBe(`APP#${result.appId}`);
    expect(result.sortId).toBe('METADATA');
  });
});
