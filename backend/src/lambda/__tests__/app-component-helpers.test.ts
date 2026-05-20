/**
 * Unit tests for app component helper functions:
 * - deriveSortId(type, id)
 * - deriveGroupId(appId)
 * - getAppWithComponents(appId)
 *
 * Validates: Requirements 1.2, 1.3, 1.8
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);

import { deriveSortId, deriveGroupId, getAppWithComponents } from '../app-resolver';

describe('deriveSortId', () => {
  test('maps "agent" type to AGENT#{id}', () => {
    expect(deriveSortId('agent', 'agent-abc')).toBe('AGENT#agent-abc');
  });

  test('maps "permission" type to PERMISSION#{id}', () => {
    expect(deriveSortId('permission', 'perm-xyz')).toBe('PERMISSION#perm-xyz');
  });

  test('maps "config" type with "schema" id to CONFIG#schema', () => {
    expect(deriveSortId('config', 'schema')).toBe('CONFIG#schema');
  });

  test('maps "config" type with "values" id to CONFIG#values', () => {
    expect(deriveSortId('config', 'values')).toBe('CONFIG#values');
  });

  test('throws for unknown component type', () => {
    expect(() => deriveSortId('unknown', 'id-1')).toThrow(/Unknown component type/);
  });
});

describe('deriveGroupId', () => {
  test('returns APP#{appId} for any appId', () => {
    expect(deriveGroupId('app-123')).toBe('APP#app-123');
  });

  test('handles appId with special characters', () => {
    expect(deriveGroupId('abc-def-ghi')).toBe('APP#abc-def-ghi');
  });
});

describe('getAppWithComponents', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
  });

  beforeEach(() => {
    ddbMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
  });

  test('queries GroupIndex with groupId = APP#{appId}', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'METADATA',
          orgId: 'org-1', name: 'Test App', status: 'DRAFT', version: 1,
          workflowIds: [], createdBy: 'user-1', createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    });

    await getAppWithComponents('app-1');

    const queryCall = ddbMock.commandCalls(QueryCommand)[0];
    expect(queryCall.args[0].input.IndexName).toBe('GroupIndex');
    expect(queryCall.args[0].input.KeyConditionExpression).toBe('groupId = :gid');
    expect(queryCall.args[0].input.ExpressionAttributeValues).toEqual({
      ':gid': 'APP#app-1',
    });
  });

  test('assembles metadata with agent bindings, permissions, and config', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'METADATA',
          orgId: 'org-1', name: 'Full App', status: 'DRAFT', version: 1,
          workflowIds: [], createdBy: 'user-1',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'AGENT#agent-1',
          agentId: 'agent-1', status: 'DESIGN', addedAt: '2024-01-01T00:00:00Z',
        },
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'AGENT#agent-2',
          agentId: 'agent-2', status: 'READY', addedAt: '2024-01-02T00:00:00Z',
        },
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'PERMISSION#perm-1',
          permissionId: 'perm-1', actions: ['s3:GetObject'], resources: ['arn:aws:s3:::bucket/*'],
        },
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'CONFIG#schema',
          schema: { type: 'object', properties: { apiKey: { type: 'string' } } },
        },
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'CONFIG#values',
          values: { apiKey: 'secret-123' },
        },
      ],
    });

    const result = await getAppWithComponents('app-1');

    expect(result.name).toBe('Full App');
    expect(result.orgId).toBe('org-1');
    expect(result.agentBindings).toHaveLength(2);
    expect(result.agentBindings[0].agentId).toBe('agent-1');
    expect(result.agentBindings[1].agentId).toBe('agent-2');
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0].permissionId).toBe('perm-1');
    expect(result.configSchema).toEqual({ type: 'object', properties: { apiKey: { type: 'string' } } });
    expect(result.configValues).toEqual({ apiKey: 'secret-123' });
  });

  test('returns null configSchema and configValues when not present', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          appId: 'app-1', groupId: 'APP#app-1', sortId: 'METADATA',
          orgId: 'org-1', name: 'Minimal App', status: 'DRAFT', version: 1,
          workflowIds: [], createdBy: 'user-1',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    });

    const result = await getAppWithComponents('app-1');

    expect(result.agentBindings).toHaveLength(0);
    expect(result.permissions).toHaveLength(0);
    expect(result.configSchema).toBeNull();
    expect(result.configValues).toBeNull();
  });

  test('returns null when no metadata item found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await getAppWithComponents('nonexistent');

    expect(result).toBeNull();
  });
});
