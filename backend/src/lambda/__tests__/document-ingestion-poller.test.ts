/**
 * Tests for document-ingestion-poller (scheduled status detection + trigger).
 */
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentClient,
  GetKnowledgeBaseDocumentsCommand,
  IngestKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockAgentClient);
const ssmMock = mockClient(SSMClient);
const eventBridgeMock = mockClient(EventBridgeClient);
const cloudwatchMock = mockClient(CloudWatchClient);

import { handler } from '../document-ingestion-poller';
import { _resetKbIdCache } from '../document-ingestion-shared';

const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago

const job = (overrides: Record<string, any> = {}) => ({
  projectId: 'proj-1',
  documentKey: 'proj-1/a.pdf',
  fileName: 'a.pdf',
  size: 100,
  fileType: 'application/pdf',
  status: 'IN_PROGRESS',
  triggered: false,
  attempts: 1,
  createdAt: NOW_ISO,
  ...overrides,
});

/** Mock the GSI: return `rows` for the IN_PROGRESS partition, empty otherwise. */
function mockJobs(rows: any[]) {
  ddbMock.on(QueryCommand, { ExpressionAttributeValues: { ':status': 'IN_PROGRESS' } }).resolves({ Items: rows });
  ddbMock.on(QueryCommand, { ExpressionAttributeValues: { ':status': 'STARTING' } }).resolves({ Items: [] });
  ddbMock.on(QueryCommand, { ExpressionAttributeValues: { ':status': 'PENDING' } }).resolves({ Items: [] });
}

function condFailed(): Error {
  const e = new Error('conditional');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

const triggerCalls = () =>
  eventBridgeMock.commandCalls(PutEventsCommand).filter((c) =>
    (c.args[0].input.Entries![0].DetailType) === 'message.sent_to_agent'
  );
const failureCalls = () =>
  eventBridgeMock.commandCalls(PutEventsCommand).filter((c) =>
    (c.args[0].input.Entries![0].DetailType) === 'document.ingestion.failed'
  );

describe('document-ingestion-poller', () => {
  beforeEach(() => {
    ddbMock.reset();
    bedrockMock.reset();
    ssmMock.reset();
    eventBridgeMock.reset();
    cloudwatchMock.reset();
    _resetKbIdCache();
    process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
    process.env.DOCUMENT_BUCKET = 'citadel-docs-test';
    process.env.KB_ID_PARAM = '/citadel/kb/id';
    process.env.DS_ID_PARAM = '/citadel/ds/id';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.ENVIRONMENT = 'test';
    process.env.MAX_AGE_MS = String(10 * 60 * 1000);
    process.env.START_GRACE_MS = String(2 * 60 * 1000);
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'kb-or-ds' } });
    ddbMock.on(UpdateCommand).resolves({});
    eventBridgeMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    cloudwatchMock.on(PutMetricDataCommand).resolves({});
  });

  test('INDEXED -> emits exactly one assessment trigger and sets triggered=true', async () => {
    mockJobs([job()]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'INDEXED', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
    } as any);

    await handler();

    expect(triggerCalls()).toHaveLength(1);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input.ConditionExpression).toBe('triggered = :false');
    expect(updates[0].args[0].input.ExpressionAttributeValues![':true']).toBe(true);
  });

  test('re-poll after triggered=true emits nothing', async () => {
    mockJobs([job({ triggered: true })]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'INDEXED', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
    } as any);

    await handler();

    expect(triggerCalls()).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test('FAILED -> no trigger, failure event emitted, reason persisted, metric emitted', async () => {
    mockJobs([job()]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'FAILED', statusReason: 'bad doc', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
    } as any);

    await handler();

    expect(triggerCalls()).toHaveLength(0);
    expect(failureCalls()).toHaveLength(1);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('FAILED');
    expect(updates[0].args[0].input.ExpressionAttributeValues![':reason']).toBe('bad doc');
    expect(cloudwatchMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('IGNORED (Bedrock dedup) is transient: keeps polling, no failure, no trigger', async () => {
    mockJobs([job()]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{
        status: 'IGNORED',
        statusReason: 'You submitted multiple requests for the same document',
        identifier: { custom: { id: 'proj-1/a.pdf' } },
      }],
    } as any);

    await handler();

    expect(triggerCalls()).toHaveLength(0);
    expect(failureCalls()).toHaveLength(0);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    // Transient bookkeeping: IGNORED normalizes to a pollable status.
    expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('IN_PROGRESS');
  });

  test('marks TIMEOUT when a transient job is older than MAX_AGE_MS', async () => {
    mockJobs([job({ createdAt: OLD_ISO, status: 'IN_PROGRESS' })]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'IN_PROGRESS', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
    } as any);

    await handler();

    expect(triggerCalls()).toHaveLength(0);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('TIMEOUT');
  });

  test('chunks GetKnowledgeBaseDocuments in groups of <=10', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => job({ documentKey: `proj-1/doc-${i}.pdf`, fileName: `doc-${i}.pdf` }));
    mockJobs(rows);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: rows.map((r) => ({ status: 'IN_PROGRESS', identifier: { custom: { id: r.documentKey } } })),
    } as any);

    await handler();

    expect(bedrockMock.commandCalls(GetKnowledgeBaseDocumentsCommand)).toHaveLength(2);
  });

  test('conditional-write race is swallowed -> still a single trigger emission', async () => {
    mockJobs([job()]);
    bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'INDEXED', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
    } as any);
    ddbMock.on(UpdateCommand).rejects(condFailed());

    const result = await handler();

    expect(triggerCalls()).toHaveLength(1);
    expect(result.processed).toBe(1);
  });

  test('no non-terminal jobs -> no polling', async () => {
    mockJobs([]);
    const result = await handler();
    expect(result.processed).toBe(0);
    expect(bedrockMock.commandCalls(GetKnowledgeBaseDocumentsCommand)).toHaveLength(0);
  });

  describe('stale STARTING re-kick (Finding #2)', () => {
    const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // > grace, < maxAge

    /** Put `rows` in the given status GSI partition, empty for the others. */
    function mockJobsIn(status: string, rows: any[]) {
      for (const s of ['IN_PROGRESS', 'STARTING', 'PENDING']) {
        ddbMock
          .on(QueryCommand, { ExpressionAttributeValues: { ':status': s } })
          .resolves({ Items: s === status ? rows : [] });
      }
    }

    const ingestCalls = () => bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand);

    beforeEach(() => {
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'STARTING', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
      } as any);
      // Document not present yet in the KB.
      bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'NOT_FOUND', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
      } as any);
    });

    test('STARTING older than START_GRACE_MS with absent doc re-invokes startIngestion', async () => {
      mockJobsIn('STARTING', [job({ status: 'STARTING', createdAt: FIVE_MIN_AGO, attempts: 1 })]);

      await handler();

      expect(ingestCalls()).toHaveLength(1);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      // Re-kick keeps the row STARTING (still re-pollable) and bumps attempts.
      expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('STARTING');
      expect(updates[0].args[0].input.UpdateExpression).toContain('attempts');
      expect(triggerCalls()).toHaveLength(0);
    });

    test('fresh STARTING row within grace does NOT re-invoke startIngestion', async () => {
      mockJobsIn('STARTING', [job({ status: 'STARTING', createdAt: NOW_ISO, attempts: 1 })]);

      await handler();

      expect(ingestCalls()).toHaveLength(0);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      // Plain transient bookkeeping (NOT_FOUND normalizes to IN_PROGRESS).
      expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('IN_PROGRESS');
    });

    test('re-kick stops after the attempts cap (attempts >= 3)', async () => {
      mockJobsIn('STARTING', [job({ status: 'STARTING', createdAt: FIVE_MIN_AGO, attempts: 3 })]);

      await handler();

      expect(ingestCalls()).toHaveLength(0);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('IN_PROGRESS');
    });

    test('STARTING row older than MAX_AGE_MS still rides to TIMEOUT (no re-kick)', async () => {
      mockJobsIn('STARTING', [job({ status: 'STARTING', createdAt: OLD_ISO, attempts: 1 })]);

      await handler();

      expect(ingestCalls()).toHaveLength(0);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('TIMEOUT');
    });
  });
});
