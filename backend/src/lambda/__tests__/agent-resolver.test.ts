/**
 * Tests for agent-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const eventBridgeMock = mockClient(EventBridgeClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../agent-resolver';

describe('agent-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    eventBridgeMock.reset();
    process.env.AGENT_STATUS_TABLE = 'test-agent-status';
    process.env.EVENT_BUS_NAME = 'test-event-bus';
  });

  afterEach(() => {
    delete process.env.AGENT_STATUS_TABLE;
    delete process.env.EVENT_BUS_NAME;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123' },
  });

  describe('getAgentStatus', () => {
    test('returns agent status when found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: {
          agentId: 'agent-1',
          projectId: 'proj-1',
          status: 'PROCESSING',
          currentTask: 'Building',
          lastUpdate: '2025-01-01T00:00:00Z',
        },
      });

      const result = await handler(makeEvent('getAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-1',
      }) as any, {} as any, {} as any);

      expect(result.agentId).toBe('agent-1');
      expect(result.status).toBe('PROCESSING');
    });

    test('returns default IDLE status when not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      const result = await handler(makeEvent('getAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-new',
      }) as any, {} as any, {} as any);

      expect(result!.status).toBe('IDLE');
      expect(result!.agentId).toBe('agent-new');
    });
  });

  describe('updateAgentStatus', () => {
    test('stores status and emits EventBridge event', async () => {
      dynamoMock.on(PutCommand).resolves({});
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('updateAgentStatus', {
        projectId: 'proj-1',
        agentId: 'agent-1',
        status: { status: 'COMPLETED', progress: 100 },
      }) as any, {} as any, {} as any);

      expect(result.status).toBe('COMPLETED');
      expect(result.progress).toBe(100);

      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(1);
    });
  });

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}) as any, {} as any, {} as any)
    ).rejects.toThrow('Unknown field');
  });
});
