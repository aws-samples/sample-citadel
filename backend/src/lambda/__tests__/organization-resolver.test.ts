/**
 * Tests for organization-resolver Lambda
 */
// Env vars must be set BEFORE the resolver module loads — the resolver
// captures process.env values into top-level constants at import time.
process.env.ORGANIZATIONS_TABLE = 'test-orgs';
process.env.USER_POOL_ID = 'us-east-1_testpool';

import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('uuid', () => ({ v4: jest.fn().mockReturnValue('org-uuid-123') }));

import { handler } from '../organization-resolver';

describe('organization-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    cognitoMock.reset();
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('createOrganization', () => {
    test('creates organization when name is unique', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createOrganization', {
        input: { name: 'New Org', description: 'A test org' },
      }));

      expect(result.orgId).toBe('org-uuid-123');
      expect(result.name).toBe('New Org');
      expect(result.createdAt).toBeDefined();
    });

    test('throws when organization name already exists', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'existing', name: 'Duplicate' }],
      });

      await expect(
        handler(makeEvent('createOrganization', {
          input: { name: 'Duplicate' },
        }))
      ).rejects.toThrow('already exists');
    });

    test('creates organization with no description, writing no undefined attributes', async () => {
      // Regression: the resolver's document client is created without
      // `removeUndefinedValues`, so a PutCommand carrying `description:
      // undefined` fails marshalling at runtime (surfaces as
      // Lambda:Unhandled). The frontend sends `description: undefined`
      // whenever the field is left blank, so this path must not write
      // an undefined value.
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createOrganization', {
        input: { name: 'No Desc Org' },
      }));

      expect(result.name).toBe('No Desc Org');

      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = (putCalls[0].args[0].input as any).Item;
      // Absent description defaults to '' (mirrors project-resolver).
      expect(item.description).toBe('');
      // No attribute may be undefined — that is exactly what breaks
      // DynamoDB marshalling in production.
      expect(Object.values(item).every((v) => v !== undefined)).toBe(true);
    });
  });

  describe('deleteOrganization', () => {
    test('deletes empty organization, calls ListUsersCommand with correct filter, then DeleteCommand', async () => {
      // Existence check returns the org row.
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Org' }],
      });
      // Cognito returns no users with matching custom:organization claim.
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteOrganization', { orgId: 'org-1' }));

      expect(result.success).toBe(true);

      // ListUsersCommand was invoked with the correct user-pool + filter.
      const listUsersCalls = cognitoMock.commandCalls(ListUsersCommand);
      expect(listUsersCalls).toHaveLength(1);
      const listInput = listUsersCalls[0].args[0].input as any;
      expect(listInput.UserPoolId).toBe('us-east-1_testpool');
      expect(listInput.Filter).toBe('"custom:organization" = "org-1"');
      expect(listInput.Limit).toBe(1);

      // DeleteCommand ran exactly once.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    test('throws when organization still has users assigned, DeleteCommand NOT called', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Org' }],
      });
      // Cognito returns one user — org cannot be deleted while users link to it.
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [{ Username: 'still-here-user', Attributes: [] }],
      });

      await expect(
        handler(makeEvent('deleteOrganization', { orgId: 'org-1' }))
      ).rejects.toThrow(/user\(s\) still assigned/);

      // DeleteCommand must NOT have run.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    test('throws "not found" and does NOT call Cognito when organization does not exist', async () => {
      // Existence check returns no row.
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      await expect(
        handler(makeEvent('deleteOrganization', { orgId: 'missing' }))
      ).rejects.toThrow('not found');

      // Cognito must NOT be consulted — existence check short-circuits first.
      // Pins the ordering invariant: existence-check → user-count check → delete.
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
