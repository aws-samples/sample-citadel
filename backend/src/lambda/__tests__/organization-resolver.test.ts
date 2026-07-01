/**
 * Tests for organization-resolver Lambda.
 *
 * Regression coverage for Issue #14 — "Team Management Add/Delete Organization
 * fails with 'Unknown field: undefined' (Lambda:Unhandled)":
 *   - Bug (a): the handler must dispatch on `event.info.fieldName` (the real
 *     AppSync $context shape), NOT `event.fieldName`. `makeEvent` below builds
 *     the REAL AppSync event so the dispatch path is exercised exactly as
 *     production sees it. (The previous helper produced a fake `{ fieldName }`
 *     object that agreed with the buggy resolver and masked the defect.)
 *   - Bug (b): `createOrganization` must never place `description: undefined`
 *     into the DynamoDB item — it must default to '' (matching
 *     project-resolver.ts `input.description || ''`) so PutCommand marshalling
 *     in the real (unmocked) client cannot throw.
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

  // REAL AppSync $context shape: the field name lives under `info.fieldName`,
  // with `arguments` and `identity` alongside — matching project-resolver.test.ts
  // and docs/RESOLVER_GUIDE.md.
  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-1' },
  });

  describe('createOrganization', () => {
    test('creates organization when name is unique and preserves the description', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createOrganization', {
        input: { name: 'New Org', description: 'A test org' },
      }));

      expect(result.orgId).toBe('org-uuid-123');
      expect(result.name).toBe('New Org');
      expect(result.description).toBe('A test org');
      expect(result.createdAt).toBeDefined();

      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect((putCalls[0].args[0].input.Item as any).description).toBe('A test org');
    });

    test('creates organization with a blank description and writes NO undefined attribute', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      dynamoMock.on(PutCommand).resolves({});

      // `description` omitted from input -> resolver must default it to ''.
      const result = await handler(makeEvent('createOrganization', {
        input: { name: 'No Desc Org' },
      }));

      expect(result.orgId).toBe('org-uuid-123');
      expect(result.name).toBe('No Desc Org');
      // Defaulted to '' (matches project-resolver.ts `input.description || ''`).
      expect(result.description).toBe('');

      // The PutCommand Item must contain NO attribute whose value is undefined.
      // An undefined value throws during DynamoDB marshalling in the real
      // (unmocked) client and produced the Lambda:Unhandled error in Issue #14.
      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item as Record<string, unknown>;
      expect(item.description).toBe('');
      const undefinedAttrs = Object.entries(item)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k);
      expect(undefinedAttrs).toEqual([]);
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

  test('throws a clear error naming the unknown field', async () => {
    // Dispatch must resolve the real field name from info.fieldName — an
    // unknown field yields 'Unknown field: <name>', never 'Unknown field: undefined'.
    await expect(
      handler(makeEvent('unknownField', {}))
    ).rejects.toThrow('Unknown field: unknownField');
  });
});
