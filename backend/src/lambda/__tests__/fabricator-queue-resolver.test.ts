/**
 * Tests for fabricator-queue-resolver Lambda.
 *
 * The resolver reads the durable fabrication-jobs table (source of truth for
 * per-agent fabrication status) instead of peeking SQS. When a projectId is
 * supplied it Queries by PK=orchestrationId; otherwise it Scans with a bounded
 * Limit. Rows map to FabricationQueueItem, sorted by submittedAt descending.
 * On any error it returns [] to preserve the existing contract.
 */
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.FABRICATION_JOBS_TABLE = 'citadel-fabrication-jobs-test';

import { handler } from '../fabricator-queue-resolver';

const row = (over: Record<string, any>) => ({
  orchestrationId: '0',
  agentUseId: 'req-1',
  status: 'PENDING',
  agentName: 'AgentOne',
  taskDescription: 'do a thing',
  submittedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('fabricator-queue-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.FABRICATION_JOBS_TABLE = 'citadel-fabrication-jobs-test';
  });

  test('Scans (bounded) and maps rows when no projectId is given', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        row({ agentUseId: 'req-1', submittedAt: '2026-06-01T00:00:00.000Z' }),
        row({
          agentUseId: 'req-2',
          status: 'COMPLETED',
          agentName: 'AgentTwo',
          agentId: 'AgentTwo',
          submittedAt: '2026-06-02T00:00:00.000Z',
        }),
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(ScanCommand)[0].args[0].input.Limit).toBeDefined();
    // Sorted by submittedAt descending → req-2 first.
    expect(result.map((r) => r.requestId)).toEqual(['req-2', 'req-1']);
    expect(result[0]).toMatchObject({
      requestId: 'req-2',
      agentName: 'AgentTwo',
      status: 'COMPLETED',
      taskDescription: 'do a thing',
      submittedAt: '2026-06-02T00:00:00.000Z',
      metadata: { orchestrationId: '0', agentId: 'AgentTwo' },
    });
  });

  test('Queries by PK=orchestrationId when projectId is provided', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [row({ agentUseId: 'req-9', status: 'FAILED', errorMessage: 'boom' })],
    });

    const result = await handler({
      info: { fieldName: 'getFabricatorQueue' },
      arguments: { projectId: 'proj-42' },
    } as any);

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    const qInput = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(qInput.ExpressionAttributeValues).toMatchObject({ ':pk': 'proj-42' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      requestId: 'req-9',
      status: 'FAILED',
      errorMessage: 'boom',
    });
  });

  test('falls back agentName to agentId when agentName is absent', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          orchestrationId: '0',
          agentUseId: 'req-1',
          status: 'PROCESSING',
          agentId: 'FabricatedAgentX',
          updatedAt: '2026-06-10T00:00:00.000Z',
        },
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);

    expect(result[0].agentName).toBe('FabricatedAgentX');
  });

  test('falls back agentName to agentUseId when only agentUseId is present', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          orchestrationId: '0',
          agentUseId: 'agent-use-77',
          status: 'PROCESSING',
          updatedAt: '2026-06-10T00:00:00.000Z',
        },
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);

    expect(result[0].agentName).toBe('agent-use-77');
  });

  test('falls back submittedAt to updatedAt when submittedAt is absent', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          orchestrationId: '0',
          agentUseId: 'req-1',
          status: 'PROCESSING',
          agentId: 'FabricatedAgentX',
          updatedAt: '2026-06-10T12:34:56.000Z',
        },
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);

    expect(result[0].submittedAt).toBe('2026-06-10T12:34:56.000Z');
  });

  test('uses agentName and submittedAt as-is when both are present', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        row({
          agentName: 'RealName',
          agentId: 'OtherId',
          submittedAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z',
        }),
      ],
    });

    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);

    expect(result[0].agentName).toBe('RealName');
    expect(result[0].submittedAt).toBe('2026-06-05T00:00:00.000Z');
  });

  test('returns [] on a DynamoDB error', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('ddb down'));
    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);
    expect(result).toEqual([]);
  });

  test('returns [] when FABRICATION_JOBS_TABLE is unset', async () => {
    delete process.env.FABRICATION_JOBS_TABLE;
    const result = await handler({ info: { fieldName: 'getFabricatorQueue' }, arguments: {} } as any);
    expect(result).toEqual([]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});
