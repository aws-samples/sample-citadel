/**
 * Unit tests for listApps — admin "All Organizations" scan + component filtering
 * Uses aws-sdk-client-mock for DynamoDB and Cognito
 */
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
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

describe('listApps', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agent-config-test';
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
    delete process.env.AGENT_CONFIG_TABLE;
  });

  describe('admin user with "All Organizations"', () => {
    beforeEach(() => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [
          { Name: 'sub', Value: 'user-123' },
          { Name: 'custom:organization', Value: 'All Organizations' },
        ],
      });
    });

    test('returns all metadata apps via table scan when user org is "All Organizations"', async () => {
      const metadataApps = [
        { appId: 'app-1', sortId: 'METADATA', orgId: 'org-a', name: 'App A' },
        { appId: 'app-2', sortId: 'METADATA', orgId: 'org-b', name: 'App B' },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: metadataApps });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-a' }),
        {} as any,
        {} as any,
      );

      expect(result.items).toEqual(metadataApps);
      // Should use ScanCommand, not QueryCommand
      expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test('scan filters out component items (AGENT#, PERMISSION#, CONFIG#)', async () => {
      const allItems = [
        { appId: 'app-1', sortId: 'METADATA', orgId: 'org-a', name: 'App A' },
        { appId: 'app-1', sortId: 'AGENT#agent-1', orgId: 'org-a' },
        { appId: 'app-1', sortId: 'PERMISSION#perm-1', orgId: 'org-a' },
        { appId: 'app-1', sortId: 'CONFIG#cfg-1', orgId: 'org-a' },
      ];
      // DynamoDB would apply the filter server-side, but mock returns what filter would return
      ddbMock.on(ScanCommand).resolves({
        Items: [allItems[0]], // Only METADATA survives the filter
      });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-a' }),
        {} as any,
        {} as any,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sortId).toBe('METADATA');

      // Verify the ScanCommand was sent with a FilterExpression
      const scanCall = ddbMock.commandCalls(ScanCommand)[0];
      const input = scanCall.args[0].input;
      expect(input.FilterExpression).toBeDefined();
    });
  });

  describe('regular user with specific org', () => {
    beforeEach(() => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        UserAttributes: [
          { Name: 'sub', Value: 'user-123' },
          { Name: 'custom:organization', Value: 'org-1' },
        ],
      });
    });

    test('queries OrgIndex for non-admin users', async () => {
      const items = [
        { appId: 'app-1', sortId: 'METADATA', orgId: 'org-1', name: 'App 1' },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: items });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        {} as any,
        {} as any,
      );

      expect(result.items).toEqual(items);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);

      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      expect(queryCall.args[0].input.IndexName).toBe('OrgIndex');
    });

    test('OrgIndex query filters out component items', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { appId: 'app-1', sortId: 'METADATA', orgId: 'org-1', name: 'App 1' },
        ],
      });

      const result = await handler(
        makeEvent('listApps', { orgId: 'org-1' }),
        {} as any,
        {} as any,
      );

      expect(result.items).toHaveLength(1);

      // Verify the QueryCommand includes a FilterExpression to exclude components
      const queryCall = ddbMock.commandCalls(QueryCommand)[0];
      const input = queryCall.args[0].input;
      expect(input.FilterExpression).toBeDefined();
    });
  });
});
