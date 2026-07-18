/**
 * Tests for tool-config-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../tool-config-resolver';

describe('tool-config-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.TOOLS_CONFIG_TABLE = 'test-tools-config';
  });

  afterEach(() => {
    delete process.env.TOOLS_CONFIG_TABLE;
  });

  const makeEvent = (fieldName: string, args: Record<string, unknown>) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('listToolConfigs', () => {
    test('returns all tool configs', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { toolId: 't1', config: { name: 'Tool1' }, state: 'active' },
        ],
      });

      const result = await handler(makeEvent('listToolConfigs', {}));
      expect(result).toHaveLength(1);
      expect(result[0].toolId).toBe('t1');
      expect(typeof result[0].config).toBe('string');
    });

    test('returns empty array when no tools exist', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listToolConfigs', {}));
      expect(result).toEqual([]);
    });
  });

  describe('getToolConfig', () => {
    test('returns tool when found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: 't1', config: { name: 'Tool1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getToolConfig', { toolId: 't1' }));
      expect(result).toBeDefined();
      expect(result!.toolId).toBe('t1');
    });

    test('returns null when not found', async () => {
      dynamoMock.on(GetCommand).resolves({});
      const result = await handler(makeEvent('getToolConfig', { toolId: 'missing' }));
      expect(result).toBeNull();
    });
  });

  describe('createToolConfig', () => {
    test('creates tool config', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createToolConfig', {
        input: { toolId: 'new-tool', config: '{"name":"New"}' },
      }));

      expect(result.toolId).toBe('new-tool');
      expect(result.createdAt).toBeDefined();
    });
  });

  describe('updateToolConfig', () => {
    test('throws when tool not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('updateToolConfig', { input: { toolId: 'missing' } }))
      ).rejects.toThrow('Tool config not found');
    });

    test('updates existing tool config', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { toolId: 't1', config: '{"old":true}', state: 'active', createdAt: '2025-01-01' },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateToolConfig', {
        input: { toolId: 't1', config: '{"new":true}' },
      }));

      expect(JSON.parse(result.config)).toEqual({ new: true });
    });
  });

  describe('deleteToolConfig', () => {
    test('returns success on delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteToolConfig', { toolId: 't1' }));
      expect(result.success).toBe(true);
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
