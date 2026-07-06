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
    // Orphan-user guard rationale (Issue #14, 2nd bug): the user↔org link lives
    // ONLY in the Cognito `custom:organization` user-pool attribute. Cognito
    // ListUsers supports server-side `Filter` on STANDARD attributes only — a
    // `custom:*` Filter raises InvalidParameterException ("Input fails to
    // satisfy the constraints") in the real service (aws-sdk-client-mock does
    // NOT enforce that constraint, which is exactly what masked the bug). The
    // resolver must therefore PAGINATE ListUsers and match attributes
    // client-side, failing closed on the first match.

    // (b): a delete SUCCEEDS when users exist in the pool but NONE carry
    // custom:organization === the org NAME — the resolver must discriminate on
    // the attribute value, not merely on "any users returned". The org's
    // orgId (a UUID) differs from its name, so a user still carrying the orgId
    // as its attribute value must NOT block the delete (Issue #19).
    test('deletes organization when no user matches the org name, then calls DeleteCommand', async () => {
      // Existence check returns the org row (name differs from orgId).
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Operations' }],
      });
      // Users exist but NONE carry custom:organization === 'Operations'.
      // 'other-1' still holds the orgId UUID — proving the guard keys off name.
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          { Username: 'other-1', Attributes: [{ Name: 'custom:organization', Value: 'org-1' }] },
          { Username: 'diff-org', Attributes: [{ Name: 'custom:organization', Value: 'different-org' }] },
          { Username: 'no-attr', Attributes: [] },
        ],
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteOrganization', { orgId: 'org-1' }));

      expect(result.success).toBe(true);
      // DeleteCommand ran exactly once.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    // (c): the ListUsers input must NOT contain a `custom:` attribute Filter —
    // that server-side filter is precisely what Cognito rejects.
    test('does NOT send a custom: attribute Filter to ListUsers', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Operations' }],
      });
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      dynamoMock.on(DeleteCommand).resolves({});

      await handler(makeEvent('deleteOrganization', { orgId: 'org-1' }));

      const listUsersCalls = cognitoMock.commandCalls(ListUsersCommand);
      expect(listUsersCalls.length).toBeGreaterThanOrEqual(1);
      const listInput = listUsersCalls[0].args[0].input as any;
      expect(listInput.UserPoolId).toBe('us-east-1_testpool');
      const filterStr = listInput.Filter === undefined ? '' : String(listInput.Filter);
      expect(filterStr.includes('custom:')).toBe(false);
    });

    // (a): delete is BLOCKED (fail-closed) when a returned user's
    // custom:organization attribute equals the target org NAME.
    test('throws when a user custom:organization matches the org name, DeleteCommand NOT called', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Operations' }],
      });
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          { Username: 'still-here-user', Attributes: [{ Name: 'custom:organization', Value: 'Operations' }] },
        ],
      });

      await expect(
        handler(makeEvent('deleteOrganization', { orgId: 'org-1' }))
      ).rejects.toThrow(/user\(s\) still assigned/);

      // DeleteCommand must NOT have run.
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    // (a'): regression for Issue #19 — the guard must key off the org NAME,
    // not the orgId. A user whose custom:organization holds the orgId UUID
    // (which is NEVER what the attribute actually stores) must NOT block the
    // delete; the pre-fix code compared against orgId and would wrongly block
    // here while wrongly allowing the real name-valued case above.
    test('does NOT block on the orgId UUID (custom:organization stores the name, not the id)', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Operations' }],
      });
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          { Username: 'carries-uuid', Attributes: [{ Name: 'custom:organization', Value: 'org-1' }] },
        ],
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteOrganization', { orgId: 'org-1' }));

      expect(result.success).toBe(true);
      expect(dynamoMock.commandCalls(DeleteCommand)).toHaveLength(1);
    });

    // (d): pagination — a match on the SECOND page must still block the delete.
    // Page 1 returns a non-matching user + PaginationToken; page 2 returns the
    // match. The resolver must follow the token and catch it.
    test('paginates ListUsers and blocks the delete on a second-page match', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Operations' }],
      });
      cognitoMock
        .on(ListUsersCommand)
        .resolvesOnce({
          Users: [
            { Username: 'other', Attributes: [{ Name: 'custom:organization', Value: 'different-org' }] },
          ],
          PaginationToken: 'page-2-token',
        })
        .resolvesOnce({
          Users: [
            { Username: 'matching-user', Attributes: [{ Name: 'custom:organization', Value: 'Operations' }] },
          ],
        });

      await expect(
        handler(makeEvent('deleteOrganization', { orgId: 'org-1' }))
      ).rejects.toThrow(/user\(s\) still assigned/);

      // Both pages were fetched — the PaginationToken from page 1 was followed.
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(2);
      // And the delete was blocked.
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
