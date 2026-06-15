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

  const makeEvent = (fieldName: string, args: any, identity?: any) => ({
    info: { fieldName },
    arguments: args,
    identity,
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
      }, {
        sub: 'test-user-123',
        username: 'ignored-when-sub-present',
        'custom:organization': 'org-42',
      }));

      expect(result.success).toBe(true);
      expect(result.requestId).toBeDefined();

      const calls = sqsMock.commandCalls(SendMessageCommand);
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0].args[0].input.MessageBody!);
      expect(body.node).toBe('fabricator');
      expect(body.agent_input.taskDetails).toContain('TestAgent');
      expect(body.agent_input.taskDetails).toContain('tool1');
      expect(body.requested_by).toBe('test-user-123');
      expect(body.org_id).toBe('org-42');
    });

    test('works without optional fields', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      const result = await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'Simple', taskDescription: 'Simple agent' },
      }, { sub: 'test-user-123' }));

      expect(result.success).toBe(true);
    });

    test('falls back to username when identity has no sub (IAM auth mode)', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'IamAgent', taskDescription: 'Built via IAM' },
      }, { username: 'iam-caller' }));

      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
      );
      expect(body.requested_by).toBe('iam-caller');
    });

    test("falls back to 'unknown' when event.identity is undefined", async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'Anon', taskDescription: 'No identity' },
      })); // no identity supplied

      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
      );
      expect(body.requested_by).toBe('unknown');
    });

    test('sets org_id to null when identity has no org claim', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      // Identity carries a sub (so requested_by resolves) but no
      // custom:organization claim — org_id must serialize as null so the
      // Python side can fall back to '' rather than blocking fabrication.
      await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'NoOrgAgent', taskDescription: 'No org claim' },
      }, { sub: 'user-without-org' }));

      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
      );
      expect(body.org_id).toBeNull();
    });

    test('reads org_id from identity.claims fallback shape', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      // Some AppSync proxy/IAM modes nest claims under identity.claims.
      // auth-event's readClaim tolerates that shape.
      await handler(makeEvent('requestAgentCreation', {
        input: { agentName: 'ClaimsAgent', taskDescription: 'Claims nested' },
      }, {
        sub: 'user-1',
        claims: { 'custom:organization': 'org-from-claims' },
      }));

      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
      );
      expect(body.org_id).toBe('org-from-claims');
    });
  });

  describe('requestToolCreation', () => {
    test('sends tool creation message to SQS', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      const result = await handler(makeEvent('requestToolCreation', {
        input: { toolName: 'TestTool', toolDescription: 'A test tool' },
      }, { sub: 'tool-requester-42', 'custom:organization': 'org-tool' }));

      expect(result.success).toBe(true);
      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!
      );
      expect(body.agent_input.taskDetails).toContain('TestTool');
      expect(body.requested_by).toBe('tool-requester-42');
      expect(body.org_id).toBe('org-tool');
    });

    test('tool creation sets org_id to null when claim absent', async () => {
      sqsMock.on(SendMessageCommand).resolves({});

      await handler(makeEvent('requestToolCreation', {
        input: { toolName: 'NoOrgTool', toolDescription: 'No org claim' },
      }, { sub: 'tool-requester-99' }));

      const body = JSON.parse(
        sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody!,
      );
      expect(body.org_id).toBeNull();
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
