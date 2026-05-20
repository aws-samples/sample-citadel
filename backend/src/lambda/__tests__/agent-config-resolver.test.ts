/**
 * Tests for agent-config-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../agent-config-resolver';

describe('agent-config-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.AGENT_CONFIG_TABLE = 'test-agent-config';
  });

  afterEach(() => {
    delete process.env.AGENT_CONFIG_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('listAgentConfigs', () => {
    test('returns all configs with stringified config field', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { agentId: 'a1', config: { name: 'Agent1' }, state: 'active', categories: ['cat1'] },
          { agentId: 'a2', config: '{"name":"Agent2"}', state: 'inactive' },
        ],
      });

      const result = await handler(makeEvent('listAgentConfigs', {}));

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('a1');
      expect(typeof result[0].config).toBe('string');
      expect(JSON.parse(result[0].config)).toEqual({ name: 'Agent1' });
      expect(result[1].state).toBe('inactive');
    });

    test('returns empty array when no configs exist', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listAgentConfigs', {}));
      expect(result).toEqual([]);
    });
  });

  describe('getAgentConfig', () => {
    test('returns config when found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { name: 'Agent1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'a1' }));
      expect(result).toBeDefined();
      expect(result!.agentId).toBe('a1');
    });

    test('returns null when not found', async () => {
      dynamoMock.on(GetCommand).resolves({});
      const result = await handler(makeEvent('getAgentConfig', { agentId: 'missing' }));
      expect(result).toBeNull();
    });
  });

  describe('createAgentConfig', () => {
    test('creates config and returns stringified config', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createAgentConfig', {
        input: { agentId: 'new-agent', config: '{"name":"New"}', state: 'active' },
      }));

      expect(result.agentId).toBe('new-agent');
      expect(typeof result.config).toBe('string');
      expect(result.createdAt).toBeDefined();
    });
  });

  describe('updateAgentConfig', () => {
    test('throws when config not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('updateAgentConfig', { input: { agentId: 'missing' } }))
      ).rejects.toThrow('Agent config not found');
    });

    test('updates existing config', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: '{"old":true}', state: 'active', createdAt: '2025-01-01' },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateAgentConfig', {
        input: { agentId: 'a1', config: '{"new":true}' },
      }));

      expect(result.agentId).toBe('a1');
      expect(JSON.parse(result.config)).toEqual({ new: true });
    });
  });

  describe('deleteAgentConfig', () => {
    test('returns success on delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteAgentConfig', { agentId: 'a1' }));
      expect(result.success).toBe(true);
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
