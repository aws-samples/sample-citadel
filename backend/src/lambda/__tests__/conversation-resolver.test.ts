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

type HandlerEvent = Parameters<typeof handler>[0];

/** Invoke the one-parameter handler and cast the result to the expected field shape. */
async function invoke<T>(event: HandlerEvent): Promise<T> {
  return (await handler(event)) as T;
}

/** Result shape of sendMessage / sendMessageToAgent. */
interface MessageResult {
  id: string;
  projectId: string;
  message: string;
}

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

  const makeEvent = (fieldName: string, args: Record<string, unknown>): HandlerEvent =>
    ({
      info: { fieldName },
      arguments: args,
      identity: { sub: 'user-123', username: 'testuser' },
    }) as unknown as HandlerEvent;

  describe('sendMessage', () => {
    test('stores message in DynamoDB and publishes USER_INPUT to EventBridge', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await invoke<MessageResult>(makeEvent('sendMessage', {
        projectId: 'proj-1',
        message: {
          agentId: 'agent-1',
          message: 'Hello agent',
          messageType: 'USER_INPUT',
        },
      }));

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
      }));

      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test('succeeds even if EventBridge publish fails', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).rejects(new Error('EB down'));

      const result = await invoke<MessageResult>(makeEvent('sendMessage', {
        projectId: 'proj-1',
        message: {
          agentId: 'agent-1',
          message: 'Hello',
          messageType: 'USER_INPUT',
        },
      }));

      // Should still return the message (stored in DDB)
      expect(result.id).toBeDefined();
    });
  });

  describe('getConversationHistory', () => {
    test('returns paginated messages sorted by timestamp', async () => {
          dynamoMock.on(QueryCommand).resolves({
            Items: [
              { id: 'm1', projectId: 'proj-1', message: 'First', timestamp: '2025-01-01T00:00:00Z' },
              { id: 'm2', projectId: 'proj-1', message: 'Second', timestamp: '2025-01-01T00:01:00Z' },
            ],
            // No LastEvaluatedKey -> nextToken should be null.
          });
    
          const result = await invoke<{ items: unknown[]; nextToken: string | null }>(
            makeEvent('getConversationHistory', {
              projectId: 'proj-1',
            }),
          );
    
          // Resolver now returns {items, nextToken} for cursor pagination.
          expect(result.items).toHaveLength(2);
          expect(result.nextToken).toBeNull();
        });
    
        test('returns a nextToken when DynamoDB paginates', async () => {
          dynamoMock.on(QueryCommand).resolves({
            Items: [
              { id: 'm1', projectId: 'proj-1', message: 'First', timestamp: '2025-01-01T00:00:00Z' },
            ],
            LastEvaluatedKey: { projectId: 'proj-1', timestamp: '2025-01-01T00:00:00Z' },
          });
    
          const result = await invoke<{ items: unknown[]; nextToken: string }>(
            makeEvent('getConversationHistory', {
              projectId: 'proj-1',
            }),
          );
    
          expect(result.items).toHaveLength(1);
          expect(typeof result.nextToken).toBe('string');
          // nextToken is a base64-encoded JSON blob of the LastEvaluatedKey.
          expect(JSON.parse(Buffer.from(result.nextToken, 'base64').toString())).toEqual({
            projectId: 'proj-1',
            timestamp: '2025-01-01T00:00:00Z',
          });
        });

    test('returns empty items list when no messages', async () => {
          dynamoMock.on(QueryCommand).resolves({ Items: [] });
    
          const result = await invoke<{ items: unknown[]; nextToken: string | null }>(
            makeEvent('getConversationHistory', {
              projectId: 'proj-1',
            }),
          );
    
          expect(result.items).toEqual([]);
          expect(result.nextToken).toBeNull();
        });
  });

  describe('sendMessageToAgent', () => {
    test('converts to sendMessage format and stores', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await invoke<MessageResult>(makeEvent('sendMessageToAgent', {
        projectId: 'proj-1',
        agentId: 'agent-1',
        message: 'Direct message',
      }));

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
      }));

      expect(result).toEqual(input);
    });
  });

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}))
    ).rejects.toThrow('Unknown field');
  });
});
