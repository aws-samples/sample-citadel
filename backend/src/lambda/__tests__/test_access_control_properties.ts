/**
 * Property-based tests for app access control (Properties 16, 17, 18)
 *
 * Uses fast-check to verify universal properties across randomized inputs.
 *
 * **Validates: Requirements 9.1, 9.2, 9.6, 9.7, 9.8, 9.9, 9.10**
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import {
  autoAssignOwner,
  grantAppAccess,
  revokeAppAccess,
  checkOperationAccess,
  hasMinimumRole,
  isAdmin,
  getRequiredRole,
} from '../app-access-control';

import type { AppRole, CallerContext } from '../app-access-control';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: 'citadel-apps-pbt',
  };
}

// ── Generators ──────────────────────────────────────────────

const appIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{3,30}$/);
const userIdArb = fc.stringMatching(/^[a-zA-Z0-9_-]{3,30}$/);
const roleArb = fc.constantFrom<AppRole>('owner', 'editor', 'viewer');

/** All operations from the mutation gating table */
const viewerOps = ['getApp', 'listApps', 'getAppMetrics', 'listAppApiKeys', 'listAppAccessEntries'] as const;
const editorOps = [
  'updateApp', 'addAppComponent', 'removeAppComponent', 'updateAgentBinding',
  'setAppConfigSchema', 'setAppConfigValues', 'createAppApiKey', 'revokeAppApiKey',
  'rotateAppApiKey', 'setAppAuthConfig',
] as const;
const ownerOps = ['publishApp', 'unpublishApp', 'grantAppAccess', 'revokeAppAccess'] as const;

const viewerOpArb = fc.constantFrom(...viewerOps);
const editorOpArb = fc.constantFrom(...editorOps);
const ownerOpArb = fc.constantFrom(...ownerOps);
const anyOpArb = fc.constantFrom(...viewerOps, ...editorOps, ...ownerOps);

// ── Property 16: Role-based access control enforcement ──────

describe('Property 16: Role-based access control enforcement', () => {

  beforeEach(() => {
    ddbMock.reset();
  });

  /**
   * **Validates: Requirements 9.1, 9.6**
   *
   * Owner allows all operations.
   */
  it('owner allows all operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        anyOpArb,
        async (appId, userId, operation) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#ACCESS#${userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${userId}`,
              userId,
              role: 'owner',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            }],
          });

          const caller: CallerContext = { userId };
          const result = await checkOperationAccess(appId, caller, operation, makeDeps());
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 9.7**
   *
   * Editor allows read + modify operations but denies publish/access-management.
   */
  it('editor allows read and modify but denies publish/access-management', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        fc.oneof(viewerOpArb, editorOpArb),
        async (appId, userId, allowedOp) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#ACCESS#${userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${userId}`,
              userId,
              role: 'editor',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            }],
          });

          const caller: CallerContext = { userId };
          const result = await checkOperationAccess(appId, caller, allowedOp, makeDeps());
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('editor denied on owner-level operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        ownerOpArb,
        async (appId, userId, deniedOp) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#ACCESS#${userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${userId}`,
              userId,
              role: 'editor',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            }],
          });

          const caller: CallerContext = { userId };
          await expect(
            checkOperationAccess(appId, caller, deniedOp, makeDeps()),
          ).rejects.toThrow(/Access denied: requires owner role/);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 9.8**
   *
   * Viewer allows only read operations.
   */
  it('viewer allows only read operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        viewerOpArb,
        async (appId, userId, readOp) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#ACCESS#${userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${userId}`,
              userId,
              role: 'viewer',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            }],
          });

          const caller: CallerContext = { userId };
          const result = await checkOperationAccess(appId, caller, readOp, makeDeps());
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('viewer denied on editor and owner operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        fc.oneof(editorOpArb, ownerOpArb),
        async (appId, userId, deniedOp) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({
            Items: [{
              appId: `${appId}#ACCESS#${userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${userId}`,
              userId,
              role: 'viewer',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            }],
          });

          const caller: CallerContext = { userId };
          await expect(
            checkOperationAccess(appId, caller, deniedOp, makeDeps()),
          ).rejects.toThrow(/Access denied/);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 9.8**
   *
   * No-role denies all operations.
   */
  it('no-role user denied on all operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        anyOpArb,
        async (appId, userId, operation) => {
          ddbMock.reset();
          ddbMock.on(QueryCommand).resolves({ Items: [] });

          const caller: CallerContext = { userId };
          await expect(
            checkOperationAccess(appId, caller, operation, makeDeps()),
          ).rejects.toThrow(/Access denied/);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 9.9**
   *
   * Admin group bypasses all role checks.
   */
  it('admin group bypasses all role checks regardless of role entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        anyOpArb,
        async (appId, userId, operation) => {
          ddbMock.reset();
          // No access entries — admin should still pass
          ddbMock.on(QueryCommand).resolves({ Items: [] });

          const caller: CallerContext = { userId, groups: ['admin'] };
          const result = await checkOperationAccess(appId, caller, operation, makeDeps());
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 17: Auto-assign owner on app creation ──────────

describe('Property 17: Auto-assign owner on app creation', () => {

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
  });

  /**
   * **Validates: Requirements 9.2**
   *
   * For any newly created app, an ACCESS#{userId} item exists with
   * role = owner, grantedBy = system, and valid grantedAt.
   * Creating user's ID matches the userId.
   */
  it('auto-assigns owner with correct fields for any appId and userId', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        async (appId, userId) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const before = new Date().toISOString();
          const result = await autoAssignOwner(appId, userId, makeDeps());
          const after = new Date().toISOString();

          // Result has correct fields
          expect(result.userId).toBe(userId);
          expect(result.role).toBe('owner');
          expect(result.grantedBy).toBe('system');

          // grantedAt is a valid ISO 8601 timestamp within the test window
          expect(new Date(result.grantedAt).toISOString()).toBe(result.grantedAt);
          expect(result.grantedAt >= before).toBe(true);
          expect(result.grantedAt <= after).toBe(true);

          // DynamoDB item stored correctly
          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls).toHaveLength(1);
          const item = putCalls[0].args[0].input.Item!;
          expect(item.sortId).toBe(`ACCESS#${userId}`);
          expect(item.groupId).toBe(`APP#${appId}`);
          expect(item.userId).toBe(userId);
          expect(item.role).toBe('owner');
          expect(item.grantedBy).toBe('system');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 18: Last owner protection ──────────────────────

describe('Property 18: Last owner protection', () => {

  beforeEach(() => {
    ddbMock.reset();
  });

  /**
   * **Validates: Requirements 9.10**
   *
   * For any app with exactly one owner, revoking that owner is rejected.
   */
  it('rejects revoking the sole owner for any appId and userId', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        fc.array(
          fc.record({
            userId: userIdArb,
            role: fc.constantFrom<'editor' | 'viewer'>('editor', 'viewer'),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        async (appId, ownerId, nonOwners) => {
          ddbMock.reset();

          // Build access entries: one owner + N non-owners
          const items = [
            {
              appId: `${appId}#ACCESS#${ownerId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${ownerId}`,
              userId: ownerId,
              role: 'owner',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            },
            ...nonOwners.map(no => ({
              appId: `${appId}#ACCESS#${no.userId}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${no.userId}`,
              userId: no.userId,
              role: no.role,
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            })),
          ];

          ddbMock.on(QueryCommand).resolves({ Items: items });

          await expect(
            revokeAppAccess(appId, ownerId, makeDeps()),
          ).rejects.toThrow(/Cannot revoke the last owner/);

          // No delete should have been issued
          expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 9.10**
   *
   * For apps with multiple owners, revoking one succeeds.
   */
  it('allows revoking one owner when multiple owners exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        appIdArb,
        userIdArb,
        fc.array(userIdArb, { minLength: 1, maxLength: 4 }),
        async (appId, ownerToRevoke, additionalOwnerIds) => {
          ddbMock.reset();

          // Ensure ownerToRevoke is not in additionalOwnerIds to avoid duplicates
          const uniqueAdditional = additionalOwnerIds.filter(id => id !== ownerToRevoke);
          if (uniqueAdditional.length === 0) return; // Need at least 2 distinct owners

          const items = [
            {
              appId: `${appId}#ACCESS#${ownerToRevoke}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${ownerToRevoke}`,
              userId: ownerToRevoke,
              role: 'owner',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            },
            ...uniqueAdditional.map(uid => ({
              appId: `${appId}#ACCESS#${uid}`,
              groupId: `APP#${appId}`,
              sortId: `ACCESS#${uid}`,
              userId: uid,
              role: 'owner',
              grantedBy: 'system',
              grantedAt: new Date().toISOString(),
            })),
          ];

          ddbMock.on(QueryCommand).resolves({ Items: items });
          ddbMock.on(DeleteCommand).resolves({});

          // Should succeed without throwing
          await revokeAppAccess(appId, ownerToRevoke, makeDeps());

          const deleteCalls = ddbMock.commandCalls(DeleteCommand);
          expect(deleteCalls).toHaveLength(1);
          expect(deleteCalls[0].args[0].input.Key!.appId).toBe(
            `${appId}#ACCESS#${ownerToRevoke}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
