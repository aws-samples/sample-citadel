/**
 * Tests for conversation-resolver Lambda
 */
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const eventBridgeMock = mockClient(EventBridgeClient);

jest.mock('uuid', () => ({ v4: jest.fn().mockReturnValue('msg-uuid-123') }));

import { handler } from '../conversation-resolver';

describe('conversation-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    process.env.CONVERSATIONS_TABLE = 'test-conversations';
    process.env.EVENT_BUS_NAME = 'test-event-bus';
  });

  afterEach(() => {
    delete process.env.CONVERSATIONS_TABLE;
    delete process.env.EVENT_BUS_NAME;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', username: 'testuser' },
  });

  describe('sendMessage', () => {
    test('stores message in DynamoDB and publishes USER_INPUT to EventBridge', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('sendMessage', {
        projectId: 'proj-1',
        message: {
          agentId: 'agent-1',
          message: 'Hello agent',
          messageType: 'USER_INPUT',
        },
      }) as any);

      expect(result.id).toBe('msg-uuid-123');
      expect(result.projectId).toBe('proj-1');
      expect(result.message).toBe('Hello agent');

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });

    test('does not publish to EventBridge for non-USER_INPUT messages', async () => {
      dynamoMock.on(PutCommand).resolves({});

      await handler(makeEvent('sendMessage', {
        projectId: 'proj-1',
        message: {
          agentId: 'agent-1',
          message: 'System notification',
          messageType: 'SYSTEM_NOTIFICATION',
        },
      }) as any);

      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('succeeds even if EventBridge publish fails', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).rejects(new Error('EB down'));

      const result = await handler(makeEvent('sendMessage', {
        projectId: 'proj-1',
        message: {
          agentId: 'agent-1',
          message: 'Hello',
          messageType: 'USER_INPUT',
        },
      }) as any);

      // Should still return the message (stored in DDB)
      expect(result.id).toBeDefined();
    });
  });

  describe('getConversationHistory', () => {
    test('returns messages sorted by timestamp', async () => {
      dynamoMock.on(QueryCommand).resolves({
        Items: [
          { id: 'm1', projectId: 'proj-1', message: 'First', timestamp: '2025-01-01T00:00:00Z' },
          { id: 'm2', projectId: 'proj-1', message: 'Second', timestamp: '2025-01-01T00:01:00Z' },
        ],
      });

      const result = await handler(makeEvent('getConversationHistory', {
        projectId: 'proj-1',
      }) as any);

      expect(result).toHaveLength(2);
    });

    test('returns empty array when no messages', async () => {
      dynamoMock.on(QueryCommand).resolves({ Items: [] });

      const result = await handler(makeEvent('getConversationHistory', {
        projectId: 'proj-1',
      }) as any);

      expect(result).toEqual([]);
    });
  });

  describe('sendMessageToAgent', () => {
    test('converts to sendMessage format and stores', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('sendMessageToAgent', {
        projectId: 'proj-1',
        agentId: 'agent-1',
        message: 'Direct message',
      }) as any);

      expect(result.id).toBeDefined();
      expect(result.message).toBe('Direct message');
    });
  });

  describe('publishConversationMessage', () => {
    test('returns the input as-is for subscription trigger', async () => {
      const input = {
        id: 'msg-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        message: 'Agent response',
        messageType: 'AGENT_RESPONSE',
        timestamp: '2025-01-01T00:00:00Z',
      };

      const result = await handler(makeEvent('publishConversationMessage', {
        input,
      }) as any);

      expect(result).toEqual(input);
    });
  });

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}) as any)
    ).rejects.toThrow('Unknown field');
  });
});
