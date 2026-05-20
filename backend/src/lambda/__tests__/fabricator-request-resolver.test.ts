/**
 * Tests for fabricator-request-resolver Lambda
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';

const sqsMock = mockClient(SQSClient);

import { handler } from '../fabricator-request-resolver';

describe('fabricator-request-resolver', () => {
  beforeEach(() => {
    sqsMock.reset();
    process.env.FABRICATOR_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/123/test-queue';
  });

  afterEach(() => {
    delete process.env.FABRICATOR_QUEUE_URL;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('requestAgentCreation', () => {
    test('sends message to SQS and returns success', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      const result = await handler(makeEvent('requestAgentCreation', {
        input: {
          agentName: 'TestAgent',
          taskDescription: 'Build a test agent',
          tools: ['tool1'],
          integrations: ['int1'],
          dataStores: ['ds1'],
        },
      }));

      expect(result.success).toBe(true);
      expect(result.requestId).toBeDefined();

      const calls = sqsMock.commandCalls(SendMessageCommand);
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0].args[0].input.MessageBody!);
      expect(body.node).toBe('fabricator');
      expect(body.agent_input.taskDetails).toContain('TestAgent');
      expect(body.agent_input.taskDetails).toContain('tool1');
    });

    test('works without optional fields', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      const result = await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'Simple', taskDescription: 'Simple agent' },
      }));

      expect(result.success).toBe(true);
    });
  });

  describe('requestToolCreation', () => {
    test('sends tool creation message to SQS', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      const result = await handler(makeEvent('requestToolCreation', {
        input: { toolName: 'TestTool', toolDescription: 'A test tool' },
      }));

      expect(result.success).toBe(true);
      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!
      );
      expect(body.agent_input.taskDetails).toContain('TestTool');
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
