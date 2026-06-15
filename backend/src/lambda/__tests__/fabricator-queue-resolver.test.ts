/**
 * Tests for fabricator-queue-resolver Lambda
 */
import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';

const sqsMock = mockClient(SQSClient);

import { handler } from '../fabricator-queue-resolver';

describe('fabricator-queue-resolver', () => {
  beforeEach(() => {
    sqsMock.reset();
    process.env.FABRICATOR_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/123/test-queue';
  });

  afterEach(() => {
    delete process.env.FABRICATOR_QUEUE_URL;
  });

  test('returns parsed queue items from SQS messages', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          MessageId: 'msg-1',
          Body: JSON.stringify({
            orchestration_id: 'orch-1',
            agent_input: { taskDetails: 'Build something' },
          }),
          Attributes: {
            SentTimestamp: '1700000000000',
            ApproximateReceiveCount: '0',
          },
        },
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' } } as any);

    expect(result).toHaveLength(1);
    expect(result[0].requestId).toBe('orch-1');
    expect(result[0].status).toBe('PENDING');
    expect(result[0].taskDescription).toBe('Build something');
  });

  test('marks items as PROCESSING when receive count > 0', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        {
          MessageId: 'msg-2',
          Body: JSON.stringify({ orchestration_id: 'orch-2', agent_input: {} }),
          Attributes: { SentTimestamp: '1700000000000', ApproximateReceiveCount: '2' },
        },
      ],
    });

    const result = await handler({} as any);
    expect(result[0].status).toBe('PROCESSING');
  });

  test('returns empty array when queue is empty', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
    const result = await handler({} as any);
    expect(result).toEqual([]);
  });

  test('returns empty array on SQS error', async () => {
    sqsMock.on(ReceiveMessageCommand).rejects(new Error('SQS down'));
    const result = await handler({} as any);
    expect(result).toEqual([]);
  });
});
