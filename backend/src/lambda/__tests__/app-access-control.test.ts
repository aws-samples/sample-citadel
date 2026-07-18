/**
 * Unit tests for app access control — CRUD and enforcement.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10
 */
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import {
  autoAssignOwner,
  grantAppAccess,
  revokeAppAccess,
  listAppAccessEntries,
  checkOperationAccess,
  hasMinimumRole,
  isAdmin,
  getRequiredRole,
} from '../app-access-control';

import type { CallerContext } from '../app-access-control';

// ── Mocks ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

// ── Helpers ─────────────────────────────────────────────────

const TEST_APP_ID = 'app-acl-001';
const TEST_USER_ID = 'user-owner-1';
const TEST_EDITOR_ID = 'user-editor-1';
const TEST_VIEWER_ID = 'user-viewer-1';

function makeDeps() {
  return {
    docClient: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    appsTable: 'citadel-apps-test',
  };
}

function makeAccessItem(overrides: Record<string, unknown> = {}) {
  const userId = (overrides.userId as string | undefined) || TEST_USER_ID;
  return {
    appId: `${TEST_APP_ID}#ACCESS#${userId}`,
    groupId: `APP#${TEST_APP_ID}`,
    sortId: `ACCESS#${userId}`,
    userId,
    role: 'owner',
    grantedBy: 'system',
    grantedAt: '2024-01-15T10:00:00.000Z',
    ...overrides,
  };
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

// ── autoAssignOwner Tests (Req 9.2) ─────────────────────────

describe('autoAssignOwner', () => {
  test('creates ACCESS#{userId} item with role=owner', async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await autoAssignOwner(TEST_APP_ID, TEST_USER_ID, makeDeps());

    expect(result.userId).toBe(TEST_USER_ID);
    expect(result.role).toBe('owner');
    expect(result.grantedBy).toBe('system');
    expect(result.grantedAt).toBeDefined();
    expect(new Date(result.grantedAt).toISOString()).toBe(result.grantedAt);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.sortId).toBe(`ACCESS#${TEST_USER_ID}`);
    expect(item.groupId).toBe(`APP#${TEST_APP_ID}`);
    expect(item.role).toBe('owner');
    expect(item.grantedBy).toBe('system');
  });

  test('grantedBy is always "system" for auto-assignment', async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await autoAssignOwner(TEST_APP_ID, 'any-user', makeDeps());

    expect(result.grantedBy).toBe('system');
  });
});

// ── grantAppAccess Tests (Req 9.3, 9.9) ────────────────────

describe('grantAppAccess', () => {
  test('stores ACCESS#{userId} with role, grantedBy, grantedAt', async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await grantAppAccess(
      TEST_APP_ID, TEST_EDITOR_ID, 'editor', TEST_USER_ID, makeDeps(),
    );

    expect(result.userId).toBe(TEST_EDITOR_ID);
    expect(result.role).toBe('editor');
    expect(result.grantedBy).toBe(TEST_USER_ID);
    expect(result.grantedAt).toBeDefined();

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.sortId).toBe(`ACCESS#${TEST_EDITOR_ID}`);
    expect(item.groupId).toBe(`APP#${TEST_APP_ID}`);
    expect(item.role).toBe('editor');
    expect(item.grantedBy).toBe(TEST_USER_ID);
  });

  test('rejects invalid role values', async () => {
    await expect(
      grantAppAccess(TEST_APP_ID, TEST_EDITOR_ID, 'superadmin', TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/Invalid role/);

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('accepts all valid roles: owner, editor, viewer', async () => {
    ddbMock.on(PutCommand).resolves({});

    for (const role of ['owner', 'editor', 'viewer']) {
      ddbMock.reset();
      ddbMock.on(PutCommand).resolves({});
      const result = await grantAppAccess(TEST_APP_ID, 'user-x', role, TEST_USER_ID, makeDeps());
      expect(result.role).toBe(role);
    }
  });
});

// ── revokeAppAccess Tests (Req 9.3, 9.10) ──────────────────

describe('revokeAppAccess', () => {
  test('deletes ACCESS#{userId} item', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeAccessItem({ userId: TEST_USER_ID, role: 'owner' }),
        makeAccessItem({ userId: 'user-owner-2', role: 'owner' }),
        makeAccessItem({ userId: TEST_EDITOR_ID, role: 'editor' }),
      ],
    });
    ddbMock.on(DeleteCommand).resolves({});

    await revokeAppAccess(TEST_APP_ID, TEST_EDITOR_ID, makeDeps());

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key!.appId).toBe(`${TEST_APP_ID}#ACCESS#${TEST_EDITOR_ID}`);
  });

  test('rejects revoking the only owner (last owner protection)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeAccessItem({ userId: TEST_USER_ID, role: 'owner' }),
        makeAccessItem({ userId: TEST_EDITOR_ID, role: 'editor' }),
      ],
    });

    await expect(
      revokeAppAccess(TEST_APP_ID, TEST_USER_ID, makeDeps()),
    ).rejects.toThrow(/Cannot revoke the last owner/);

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  test('allows revoking an owner when multiple owners exist', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeAccessItem({ userId: TEST_USER_ID, role: 'owner' }),
        makeAccessItem({ userId: 'user-owner-2', role: 'owner' }),
      ],
    });
    ddbMock.on(DeleteCommand).resolves({});

    await revokeAppAccess(TEST_APP_ID, TEST_USER_ID, makeDeps());

    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  test('throws error when user not found in access list', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAccessItem({ userId: TEST_USER_ID, role: 'owner' })],
    });

    await expect(
      revokeAppAccess(TEST_APP_ID, 'nonexistent-user', makeDeps()),
    ).rejects.toThrow(/not found/i);
  });
});

// ── checkAppAccess / checkOperationAccess Tests (Req 9.1, 9.6, 9.7, 9.8, 9.9) ──

describe('checkAppAccess — mutation gating', () => {
  test('viewer denied on updateApp (requires editor)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAccessItem({ userId: TEST_VIEWER_ID, role: 'viewer' })],
    });

    const caller: CallerContext = { userId: TEST_VIEWER_ID };
    await expect(
      checkOperationAccess(TEST_APP_ID, caller, 'updateApp', makeDeps()),
    ).rejects.toThrow(/Access denied: requires editor role/);
  });

  test('editor denied on publishApp (requires owner)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAccessItem({ userId: TEST_EDITOR_ID, role: 'editor' })],
    });

    const caller: CallerContext = { userId: TEST_EDITOR_ID };
    await expect(
      checkOperationAccess(TEST_APP_ID, caller, 'publishApp', makeDeps()),
    ).rejects.toThrow(/Access denied: requires owner role/);
  });

  test('editor allowed on updateApp', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAccessItem({ userId: TEST_EDITOR_ID, role: 'editor' })],
    });

    const caller: CallerContext = { userId: TEST_EDITOR_ID };
    const result = await checkOperationAccess(TEST_APP_ID, caller, 'updateApp', makeDeps());
    expect(result).toBe(true);
  });

  test('owner allowed on all operations', async () => {
    const ownerCaller: CallerContext = { userId: TEST_USER_ID };

    for (const op of ['getApp', 'updateApp', 'publishApp', 'grantAppAccess']) {
      ddbMock.reset();
      ddbMock.on(QueryCommand).resolves({
        Items: [makeAccessItem({ userId: TEST_USER_ID, role: 'owner' })],
      });

      const result = await checkOperationAccess(TEST_APP_ID, ownerCaller, op, makeDeps());
      expect(result).toBe(true);
    }
  });

  test('user with no role denied on all operations', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const caller: CallerContext = { userId: 'no-role-user' };
    await expect(
      checkOperationAccess(TEST_APP_ID, caller, 'getApp', makeDeps()),
    ).rejects.toThrow(/Access denied/);
  });

  test('admin group bypasses all role checks', async () => {
    // No access entries at all — admin should still pass
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const adminCaller: CallerContext = { userId: 'admin-user', groups: ['admin'] };

    for (const op of ['getApp', 'updateApp', 'publishApp', 'grantAppAccess']) {
      const result = await checkOperationAccess(TEST_APP_ID, adminCaller, op, makeDeps());
      expect(result).toBe(true);
    }
  });

  test('grantAppAccess requires owner role', () => {
    const requiredRole = getRequiredRole('grantAppAccess');
    expect(requiredRole).toBe('owner');
  });

  test('revokeAppAccess requires owner role', () => {
    const requiredRole = getRequiredRole('revokeAppAccess');
    expect(requiredRole).toBe('owner');
  });
});

// ── listAppAccessEntries Tests (Req 9.4, 9.5) ──────────────

describe('listAppAccessEntries', () => {
  test('returns all access entries for an app', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        makeAccessItem({ userId: TEST_USER_ID, role: 'owner' }),
        makeAccessItem({ userId: TEST_EDITOR_ID, role: 'editor' }),
        makeAccessItem({ userId: TEST_VIEWER_ID, role: 'viewer' }),
      ],
    });

    const entries = await listAppAccessEntries(TEST_APP_ID, makeDeps());

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(expect.objectContaining({
      userId: TEST_USER_ID,
      role: 'owner',
      grantedBy: 'system',
    }));
    expect(entries[1]).toEqual(expect.objectContaining({
      userId: TEST_EDITOR_ID,
      role: 'editor',
    }));
    expect(entries[2]).toEqual(expect.objectContaining({
      userId: TEST_VIEWER_ID,
      role: 'viewer',
    }));
  });

  test('returns empty array when no access entries exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const entries = await listAppAccessEntries(TEST_APP_ID, makeDeps());
    expect(entries).toEqual([]);
  });

  test('entries include userId, role, grantedBy, grantedAt fields', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [makeAccessItem()],
    });

    const entries = await listAppAccessEntries(TEST_APP_ID, makeDeps());
    const entry = entries[0];

    expect(entry.userId).toBeDefined();
    expect(entry.role).toBeDefined();
    expect(entry.grantedBy).toBeDefined();
    expect(entry.grantedAt).toBeDefined();
  });
});

// ── Pure function tests ─────────────────────────────────────

describe('hasMinimumRole', () => {
  test('owner meets all role requirements', () => {
    expect(hasMinimumRole('owner', 'owner')).toBe(true);
    expect(hasMinimumRole('owner', 'editor')).toBe(true);
    expect(hasMinimumRole('owner', 'viewer')).toBe(true);
  });

  test('editor meets editor and viewer but not owner', () => {
    expect(hasMinimumRole('editor', 'owner')).toBe(false);
    expect(hasMinimumRole('editor', 'editor')).toBe(true);
    expect(hasMinimumRole('editor', 'viewer')).toBe(true);
  });

  test('viewer meets only viewer', () => {
    expect(hasMinimumRole('viewer', 'owner')).toBe(false);
    expect(hasMinimumRole('viewer', 'editor')).toBe(false);
    expect(hasMinimumRole('viewer', 'viewer')).toBe(true);
  });
});

describe('isAdmin', () => {
  test('returns true when caller has admin group', () => {
    expect(isAdmin({ userId: 'u1', groups: ['admin'] })).toBe(true);
    expect(isAdmin({ userId: 'u1', groups: ['users', 'admin'] })).toBe(true);
  });

  test('returns false when caller lacks admin group', () => {
    expect(isAdmin({ userId: 'u1', groups: ['users'] })).toBe(false);
    expect(isAdmin({ userId: 'u1', groups: [] })).toBe(false);
    expect(isAdmin({ userId: 'u1' })).toBe(false);
  });
});
