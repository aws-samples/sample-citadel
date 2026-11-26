/**
 * Unit tests for app-component-registration-handler Lambda
 * Validates: Requirements 6.3, 6.4, 6.5, 6.6
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../app-component-registration-handler';

function makeEventBridgeEvent(
  detailType: string,
  detail: Record<string, unknown>,
) {
  return {
    version: '0',
    id: 'test-event-id',
    source: 'citadel.fabricator',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    'detail-type': detailType,
    detail,
  } as unknown as Parameters<typeof handler>[0];
}

describe('app-component-registration-handler', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
  });

  beforeEach(() => {
    ddbMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
  });

  // ─── agent.fabricated with appId ──────────────────────────────

  describe('agent.fabricated event with appId', () => {
    test('creates AGENT#{agentId} component with DESIGN status', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(
        makeEventBridgeEvent('agent.fabricated', {
          agentId: 'agent-abc',
          appId: 'app-1',
          orchestrationId: 'orch-1',
        }),
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const input = putCalls[0].args[0].input;
      expect(input.TableName).toBe('citadel-apps-test');
      expect(input.Item).toEqual(
        expect.objectContaining({
          appId: 'app-1#AGENT#agent-abc',
          groupId: 'APP#app-1',
          sortId: 'AGENT#agent-abc',
          agentId: 'agent-abc',
          status: 'DESIGN',
        }),
      );
      expect(input.Item!.addedAt).toBeDefined();
      expect(input.ConditionExpression).toBe('attribute_not_exists(groupId)');
    });
  });

  // ─── tool.fabricated with appId ───────────────────────────────

  describe('tool.fabricated event with appId', () => {
    test('creates TOOL#{toolId} component with DESIGN status', async () => {
      ddbMock.on(PutCommand).resolves({});

      await handler(
        makeEventBridgeEvent('tool.fabricated', {
          toolId: 'tool-xyz',
          appId: 'app-2',
          orchestrationId: 'orch-2',
        }),
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const input = putCalls[0].args[0].input;
      expect(input.Item).toEqual(
        expect.objectContaining({
          appId: 'app-2#TOOL#tool-xyz',
          groupId: 'APP#app-2',
          sortId: 'TOOL#tool-xyz',
          toolId: 'tool-xyz',
          status: 'DESIGN',
        }),
      );
      expect(input.Item!.addedAt).toBeDefined();
      expect(input.ConditionExpression).toBe('attribute_not_exists(groupId)');
    });
  });

  // ─── No appId — backward compatible skip ──────────────────────

  describe('backward compatibility', () => {
    test('skips registration when no appId in event', async () => {
      await handler(
        makeEventBridgeEvent('agent.fabricated', {
          agentId: 'agent-standalone',
          orchestrationId: 'orch-3',
        }),
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });

    test('skips registration when appId is empty string', async () => {
      await handler(
        makeEventBridgeEvent('agent.fabricated', {
          agentId: 'agent-standalone',
          appId: '',
          orchestrationId: 'orch-4',
        }),
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(0);
    });
  });

  // ─── Idempotency via ConditionalCheckFailedException ──────────

  describe('idempotency', () => {
    test('silently handles ConditionalCheckFailedException (item already exists)', async () => {
      const conditionalError = new Error('The conditional request failed');
      conditionalError.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(conditionalError);

      // Should not throw
      await expect(
        handler(
          makeEventBridgeEvent('agent.fabricated', {
            agentId: 'agent-dup',
            appId: 'app-1',
            orchestrationId: 'orch-5',
          }),
        ),
      ).resolves.toBeUndefined();
    });

    test('re-throws non-conditional DynamoDB errors', async () => {
      const otherError = new Error('Service unavailable');
      otherError.name = 'InternalServerError';
      ddbMock.on(PutCommand).rejects(otherError);

      await expect(
        handler(
          makeEventBridgeEvent('agent.fabricated', {
            agentId: 'agent-err',
            appId: 'app-1',
            orchestrationId: 'orch-6',
          }),
        ),
      ).rejects.toThrow('Service unavailable');
    });
  });
});
