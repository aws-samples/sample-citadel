/**
 * Tests for fabricator-request-resolver Lambda.
 *
 * The resolver enqueues a fabrication request onto SQS and then writes a
 * PENDING row to the durable fabrication-jobs table so the queue UI shows
 * real per-agent status instead of peeking SQS. The status write is
 * best-effort: a failure must NOT fail the enqueue (the caller already got a
 * queued request).
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.FABRICATOR_QUEUE_URL = 'https://sqs.test/queue';
process.env.FABRICATION_JOBS_TABLE = 'citadel-fabrication-jobs-test';

import { handler } from '../fabricator-request-resolver';

const makeEvent = (fieldName: string, input: Record<string, unknown>) => ({
  info: { fieldName },
  arguments: { input },
  identity: { sub: 'user-123' },
});

describe('fabricator-request-resolver', () => {
  beforeEach(() => {
    sqsMock.reset();
    ddbMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    ddbMock.on(PutCommand).resolves({});
    process.env.FABRICATION_JOBS_TABLE = 'citadel-fabrication-jobs-test';
  });

  test('writes a PENDING row after the SQS send for agent creation', async () => {
    const result = await handler(
      makeEvent('requestAgentCreation', {
        agentName: 'InvoiceParser',
        taskDescription: 'Parse invoices from PDFs',
      }),
    );

    expect(result.success).toBe(true);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item!;
    expect(puts[0].args[0].input.TableName).toBe('citadel-fabrication-jobs-test');
    expect(item.orchestrationId).toBe('0');
    expect(item.agentUseId).toBe(result.requestId);
    expect(item.status).toBe('PENDING');
    expect(item.agentName).toBe('InvoiceParser');
    expect(item.requestType).toBe('agent-creation');
    expect(item.requestedBy).toBe('user-123');
    expect(typeof item.submittedAt).toBe('string');
    expect(typeof item.updatedAt).toBe('string');
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('truncates taskDescription to ~500 chars', async () => {
    const longDesc = 'x'.repeat(2000);
    await handler(
      makeEvent('requestAgentCreation', {
        agentName: 'BigAgent',
        taskDescription: longDesc,
      }),
    );
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect((item.taskDescription as string).length).toBeLessThanOrEqual(500);
  });

  test('does NOT fail the enqueue when the status write throws', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ddb down'));

    const result = await handler(
      makeEvent('requestToolCreation', {
        toolName: 'CsvExporter',
        toolDescription: 'Export rows to CSV',
      }),
    );

    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  test('skips the status write when FABRICATION_JOBS_TABLE is unset', async () => {
    delete process.env.FABRICATION_JOBS_TABLE;

    const result = await handler(
      makeEvent('requestAgentCreation', {
        agentName: 'NoTableAgent',
        taskDescription: 'No table configured',
      }),
    );

    expect(result.success).toBe(true);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
