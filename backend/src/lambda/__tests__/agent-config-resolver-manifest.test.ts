/**
 * Tests for publishAgentManifest mutation handler in agent-config-resolver
 *
 * Validates: Requirements 15.1, 15.6, 15.7, 15.8
 */
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../agent-config-resolver';

describe('publishAgentManifest', () => {
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

  const validManifest = {
    name: 'Test Agent',
    description: 'A test agent for unit testing',
    version: '1.0.0',
  };

  const fullManifest = {
    name: 'Full Agent',
    description: 'Agent with all fields',
    version: '2.0.0',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    tools: ['tool1', 'tool2'],
    resourceRequirements: { memoryMb: 1024, timeoutSeconds: 300, permissions: ['s3:GetObject'] },
  };

  describe('successful manifest publishing', () => {
    test('stores manifest with required fields only', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'agent-1', config: { name: 'Agent1' }, state: 'active' },
      });
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          agentId: 'agent-1',
          config: { name: 'Agent1' },
          state: 'active',
          manifest: validManifest,
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      });

      const result = await handler(makeEvent('publishAgentManifest', {
        agentId: 'agent-1',
        manifest: JSON.stringify(validManifest),
      }));

      expect(result.agentId).toBe('agent-1');
      expect(result.manifest).toEqual(validManifest);
    });

    test('stores manifest with all optional fields', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'agent-2', config: { name: 'Agent2' }, state: 'active' },
      });
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          agentId: 'agent-2',
          config: { name: 'Agent2' },
          state: 'active',
          manifest: fullManifest,
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      });

      const result = await handler(makeEvent('publishAgentManifest', {
        agentId: 'agent-2',
        manifest: JSON.stringify(fullManifest),
      }));

      expect(result.agentId).toBe('agent-2');
      expect(result.manifest).toEqual(fullManifest);
    });

    test('calls UpdateCommand with correct key and manifest', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'agent-1', config: { name: 'Agent1' }, state: 'active' },
      });
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          agentId: 'agent-1',
          config: { name: 'Agent1' },
          state: 'active',
          manifest: validManifest,
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      });

      await handler(makeEvent('publishAgentManifest', {
        agentId: 'agent-1',
        manifest: JSON.stringify(validManifest),
      }));

      const updateCalls = dynamoMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);

      const cmdInput = updateCalls[0].args[0].input;
      expect(cmdInput.Key).toEqual({ agentId: 'agent-1' });
      expect(cmdInput.ExpressionAttributeValues![':manifest']).toEqual(validManifest);
      expect(cmdInput.UpdateExpression).toContain('#manifest = :manifest');
    });
  });

  describe('manifest validation — missing required fields', () => {
    test('rejects manifest missing name', async () => {
      const manifest = { description: 'desc', version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/name/i);
    });

    test('rejects manifest missing description', async () => {
      const manifest = { name: 'Agent', version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/description/i);
    });

    test('rejects manifest missing version', async () => {
      const manifest = { name: 'Agent', description: 'desc' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/version/i);
    });

    test('rejects completely empty manifest', async () => {
      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify({}),
        }))
      ).rejects.toThrow();
    });
  });

  describe('manifest validation — wrong types', () => {
    test('rejects manifest with non-string name', async () => {
      const manifest = { name: 123, description: 'desc', version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/name/i);
    });

    test('rejects manifest with non-string description', async () => {
      const manifest = { name: 'Agent', description: true, version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/description/i);
    });

    test('rejects manifest with non-string version', async () => {
      const manifest = { name: 'Agent', description: 'desc', version: 42 };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/version/i);
    });

    test('rejects manifest with empty name', async () => {
      const manifest = { name: '', description: 'desc', version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/name/i);
    });

    test('rejects manifest with empty description', async () => {
      const manifest = { name: 'Agent', description: '', version: '1.0.0' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/description/i);
    });

    test('rejects manifest with empty version', async () => {
      const manifest = { name: 'Agent', description: 'desc', version: '' };

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: JSON.stringify(manifest),
        }))
      ).rejects.toThrow(/version/i);
    });
  });

  describe('manifest validation — invalid JSON', () => {
    test('rejects invalid JSON string', async () => {
      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'agent-1',
          manifest: 'not-json',
        }))
      ).rejects.toThrow();
    });
  });

  describe('agent not found', () => {
    test('throws when agent does not exist', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('publishAgentManifest', {
          agentId: 'nonexistent',
          manifest: JSON.stringify(validManifest),
        }))
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('return format', () => {
    test('returns config as stringified JSON', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'agent-1', config: { name: 'Agent1' }, state: 'active' },
      });
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          agentId: 'agent-1',
          config: { name: 'Agent1' },
          state: 'active',
          manifest: validManifest,
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      });

      const result = await handler(makeEvent('publishAgentManifest', {
        agentId: 'agent-1',
        manifest: JSON.stringify(validManifest),
      }));

      expect(typeof result.config).toBe('string');
      expect(JSON.parse(result.config)).toEqual({ name: 'Agent1' });
    });
  });
});
