/**
 * Unit tests for `apps-table-meta` — the eventually-consistent metadata-row
 * helpers for the AppsTable apps-index pattern.
 *
 * Mocks the DynamoDB DocumentClient via aws-sdk-client-mock, matching the
 * pattern used elsewhere in the codebase (see app-publish-handler.test.ts).
 */
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import {
  upsertAppMeta,
  updateAppMetaFields,
  deleteAppMeta,
  APP_META_SORT_VALUE,
  AppMetaRow,
} from '../apps-table-meta';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'AppsTable-test';

function makeMeta(overrides: Partial<AppMetaRow> = {}): AppMetaRow {
  return {
    appId: 'app-1',
    orgId: 'org-1',
    name: 'My App',
    description: 'desc',
    status: 'ACTIVE',
    workflowIds: ['wf-1', 'wf-2'],
    routingConfig: '{"strategy":"first"}',
    createdBy: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

describe('apps-table-meta helpers', () => {
  beforeEach(() => {
    ddbMock.reset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── upsertAppMeta ────────────────────────────────────────────────────

  describe('upsertAppMeta', () => {
    it('issues an UpdateCommand keyed on appId only with every projection field SET', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const meta = makeMeta();
      const ok = await upsertAppMeta(TABLE, meta);

      expect(ok).toBe(true);
      // Switched from PutCommand to UpdateCommand to preserve any
      // attributes legacy writers (app-publish-handler etc.) may have set.
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.TableName).toBe(TABLE);
      // Key must be appId only — AppsTable has no sort key.
      expect(input.Key).toEqual({ appId: 'app-1' });
      expect(input.UpdateExpression).toMatch(/^SET /);

      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values).toEqual({
        ':v_orgId': 'org-1',
        ':v_name': 'My App',
        ':v_description': 'desc',
        ':v_status': 'ACTIVE',
        ':v_workflowIds': ['wf-1', 'wf-2'],
        ':v_routingConfig': '{"strategy":"first"}',
        ':v_createdBy': 'user-1',
        ':v_createdAt': '2024-01-01T00:00:00.000Z',
        ':v_updatedAt': '2024-01-02T00:00:00.000Z',
        ':v_version': 3,
        ':v_sortId': APP_META_SORT_VALUE,
        ':v_groupId': 'APP#app-1',
      });
      // sortId is set as a data attribute (not part of the key) so the
      // legacy app-publish-handler reader (`metadata.sortId === 'METADATA'`)
      // keeps working.
      expect(values[':v_sortId']).toBe('METADATA');

      const names = input.ExpressionAttributeNames as Record<string, string>;
      expect(names['#k_sortId']).toBe('sortId');
      expect(names['#k_orgId']).toBe('orgId');
    });

    it('falls back to defaults for optional fields', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const meta = makeMeta({
        description: undefined,
        workflowIds: undefined,
        routingConfig: undefined,
      });
      const ok = await upsertAppMeta(TABLE, meta);

      expect(ok).toBe(true);
      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const values = calls[0].args[0].input.ExpressionAttributeValues as Record<
        string,
        unknown
      >;
      expect(values[':v_description']).toBe('');
      expect(values[':v_workflowIds']).toEqual([]);
      expect(values[':v_routingConfig']).toBe('');
    });

    it('returns false and logs a warning when the SDK throws', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      ddbMock.on(UpdateCommand).rejects(new Error('boom'));

      const ok = await upsertAppMeta(TABLE, makeMeta());

      expect(ok).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it('returns false immediately when tableName is empty (no SDK call)', async () => {
      const ok = await upsertAppMeta('', makeMeta());

      expect(ok).toBe(false);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  // ── updateAppMetaFields ─────────────────────────────────────────────

  describe('updateAppMetaFields', () => {
    it('builds an UpdateExpression with only the fields actually present in partial', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const ok = await updateAppMetaFields(TABLE, 'app-1', {
        name: 'New Name',
        status: 'INACTIVE',
        updatedAt: '2024-02-01T00:00:00.000Z',
      });

      expect(ok).toBe(true);
      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.TableName).toBe(TABLE);
      // Key must be appId only — AppsTable has no sort key.
      expect(input.Key).toEqual({ appId: 'app-1' });
      // Only the three supplied fields appear in expression / values / names.
      expect(input.ExpressionAttributeValues).toEqual({
        ':v_name': 'New Name',
        ':v_status': 'INACTIVE',
        ':v_updatedAt': '2024-02-01T00:00:00.000Z',
      });
      expect(input.ExpressionAttributeNames).toEqual({
        '#k_name': 'name',
        '#k_status': 'status',
        '#k_updatedAt': 'updatedAt',
      });
      expect(input.UpdateExpression).toMatch(/^SET /);
      // Each set clause must be present, regardless of order.
      const expr = input.UpdateExpression as string;
      expect(expr).toContain('#k_name = :v_name');
      expect(expr).toContain('#k_status = :v_status');
      expect(expr).toContain('#k_updatedAt = :v_updatedAt');
    });

    it('refuses to set appId/createdAt/createdBy even if supplied', async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const ok = await updateAppMetaFields(TABLE, 'app-1', {
        // @ts-expect-error — forcibly pass disallowed keys at runtime
        appId: 'OTHER',
        // @ts-expect-error — createdAt is a disallowed immutable field; passed at runtime to assert it is stripped
        createdAt: '1999-01-01T00:00:00.000Z',
        // @ts-expect-error — createdBy is a disallowed immutable field; passed at runtime to assert it is stripped
        createdBy: 'attacker',
        name: 'Allowed',
      } as Parameters<typeof updateAppMetaFields>[2]);

      expect(ok).toBe(true);
      const calls = ddbMock.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.ExpressionAttributeValues).toEqual({ ':v_name': 'Allowed' });
      expect(input.ExpressionAttributeNames).toEqual({ '#k_name': 'name' });
      expect(input.UpdateExpression).toBe('SET #k_name = :v_name');
    });

    it('returns true with no SDK call when partial is empty', async () => {
      const ok = await updateAppMetaFields(TABLE, 'app-1', {});

      expect(ok).toBe(true);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('returns true with no SDK call when partial contains only disallowed keys', async () => {
      const ok = await updateAppMetaFields(TABLE, 'app-1', {
        // @ts-expect-error — appId is a disallowed immutable field; passed at runtime to assert it is ignored
        appId: 'X',
        // @ts-expect-error — createdBy is a disallowed immutable field; passed at runtime to assert it is ignored
        createdBy: 'Y',
      } as Parameters<typeof updateAppMetaFields>[2]);

      expect(ok).toBe(true);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('returns false on SDK error', async () => {
      ddbMock.on(UpdateCommand).rejects(new Error('boom'));

      const ok = await updateAppMetaFields(TABLE, 'app-1', { name: 'X' });

      expect(ok).toBe(false);
    });

    it('returns false when tableName is missing (no SDK call)', async () => {
      const ok = await updateAppMetaFields('', 'app-1', { name: 'X' });

      expect(ok).toBe(false);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('returns false when appId is missing (no SDK call)', async () => {
      const ok = await updateAppMetaFields(TABLE, '', { name: 'X' });

      expect(ok).toBe(false);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ── deleteAppMeta ───────────────────────────────────────────────────

  describe('deleteAppMeta', () => {
    it('sends DeleteCommand keyed on appId only', async () => {
      ddbMock.on(DeleteCommand).resolves({});

      const ok = await deleteAppMeta(TABLE, 'app-1');

      expect(ok).toBe(true);
      const calls = ddbMock.commandCalls(DeleteCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({
        TableName: TABLE,
        Key: { appId: 'app-1' },
      });
    });

    it('returns false on SDK error', async () => {
      ddbMock.on(DeleteCommand).rejects(new Error('boom'));

      const ok = await deleteAppMeta(TABLE, 'app-1');

      expect(ok).toBe(false);
    });

    it('returns false when tableName is missing (no SDK call)', async () => {
      const ok = await deleteAppMeta('', 'app-1');

      expect(ok).toBe(false);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it('returns false when appId is missing (no SDK call)', async () => {
      const ok = await deleteAppMeta(TABLE, '');

      expect(ok).toBe(false);
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });
  });

  // ── sortId data-attribute sentinel ──────────────────────────────────

  describe('APP_META_SORT_VALUE', () => {
    it('matches the legacy reader value (METADATA)', () => {
      // The legacy app-publish-handler reads `metadata.sortId === 'METADATA'`
      // — keeping the constant aligned guarantees that contract.
      expect(APP_META_SORT_VALUE).toBe('METADATA');
    });
  });
});
