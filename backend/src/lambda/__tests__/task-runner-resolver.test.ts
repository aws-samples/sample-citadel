/**
 * Tests for task-runner-resolver Lambda
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const eventBridgeMock = mockClient(EventBridgeClient);

// Set env before import
process.env.AGENT_EVENT_BUS_NAME = 'test-event-bus';

import { handler } from '../task-runner-resolver';

describe('task-runner-resolver', () => {
  beforeEach(() => {
    eventBridgeMock.reset();
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('submitTask', () => {
    test('publishes event to EventBridge and returns orchestrationId', async () => {
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('submitTask', {
        input: { taskDetails: 'Build a new feature' },
      }));

      expect(result.success).toBe(true);
      expect(result.orchestrationId).toBeDefined();
      expect(result.message).toContain('successfully');

      const calls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(calls).toHaveLength(1);
      const entry = calls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe('task.request');
      expect(entry.EventBusName).toBe('test-event-bus');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.task).toBe('Build a new feature');
    });

    test('includes callback in event detail when provided', async () => {
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(makeEvent('submitTask', {
        input: {
          taskDetails: 'Task with callback',
          callback: { type: 'eventbridge', source: 'test' },
        },
      }));

      expect(result.success).toBe(true);
      const detail = JSON.parse(
        eventBridgeMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0].Detail!
      );
      expect(detail.callback).toEqual({ type: 'eventbridge', source: 'test' });
    });

    test('throws when EventBridge fails', async () => {
      eventBridgeMock.on(PutEventsCommand).rejects(new Error('EB down'));

      await expect(
        handler(makeEvent('submitTask', { input: { taskDetails: 'fail' } }))
      ).rejects.toThrow('Failed to submit task');
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
