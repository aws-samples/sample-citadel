/**
 * Tests for document-ingestion-start (S3 ObjectCreated -> jobs row + ingest).
 */
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentClient,
  IngestKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockAgentClient);
const ssmMock = mockClient(SSMClient);

import { handler, shouldProcessKey, parseKey, decodeS3Key } from '../document-ingestion-start';
import { _resetKbIdCache } from '../document-ingestion-shared';

const makeS3Event = (records: { key: string; size?: number }[]) => ({
  Records: records.map((r) => ({
    s3: { object: { key: r.key, size: r.size ?? 123 }, bucket: { name: 'docs' } },
  })),
}) as any;

function condFailed(): Error {
  const e = new Error('conditional');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

describe('document-ingestion-start', () => {
  beforeEach(() => {
    ddbMock.reset();
    bedrockMock.reset();
    ssmMock.reset();
    _resetKbIdCache();
    process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
    process.env.DOCUMENT_BUCKET = 'citadel-docs-test';
    process.env.KB_ID_PARAM = '/citadel/kb/id';
    process.env.DS_ID_PARAM = '/citadel/ds/id';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'kb-or-ds' } });
  });

  describe('key helpers', () => {
    test('shouldProcessKey accepts a flat project upload', () => {
      expect(shouldProcessKey('proj-1/report.pdf')).toBe(true);
    });
    test('shouldProcessKey rejects design/ and planning/ artifacts', () => {
      expect(shouldProcessKey('proj-1/design/high_level_design.pdf')).toBe(false);
      expect(shouldProcessKey('proj-1/planning/roadmap.md')).toBe(false);
    });
    test('shouldProcessKey rejects keys without a project prefix', () => {
      expect(shouldProcessKey('report.pdf')).toBe(false);
      expect(shouldProcessKey('proj-1/')).toBe(false);
    });
    test('parseKey splits projectId and fileName', () => {
      expect(parseKey('proj-1/report.pdf')).toEqual({ projectId: 'proj-1', fileName: 'report.pdf' });
    });
    test('decodeS3Key decodes + and percent escapes', () => {
      expect(decodeS3Key('proj-1/my+report%202.pdf')).toBe('proj-1/my report 2.pdf');
    });
  });

  test('creates a STARTING jobs row then records the returned status', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'IN_PROGRESS', identifier: { custom: { id: 'proj-1/report.pdf' } } }],
    } as any);

    await handler(makeS3Event([{ key: 'proj-1/report.pdf', size: 500 }]));

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item as any;
    expect(item.status).toBe('STARTING');
    expect(item.triggered).toBe(false);
    expect(item.projectId).toBe('proj-1');
    expect(item.documentKey).toBe('proj-1/report.pdf');
    expect(item.size).toBe(500);

    expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(1);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe('IN_PROGRESS');
  });

  test('is idempotent on a duplicate S3 delivery (conditional create fails -> no second ingest)', async () => {
    ddbMock.on(PutCommand).resolvesOnce({}).rejects(condFailed());
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'IN_PROGRESS' }],
    } as any);

    await handler(makeS3Event([
      { key: 'proj-1/report.pdf' },
      { key: 'proj-1/report.pdf' },
    ]));

    // Two create attempts, but only the first proceeds to ingestion.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
    expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(1);
  });

  test('ignores excluded design/planning artifacts (no DB write, no ingest)', async () => {
    ddbMock.on(PutCommand).resolves({});
    await handler(makeS3Event([
      { key: 'proj-1/design/high_level_design.pdf' },
      { key: 'proj-1/planning/roadmap.md' },
    ]));
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(0);
  });

  test('persists statusReason when ingestion returns FAILED immediately', async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
      documentDetails: [{ status: 'FAILED', statusReason: 'parse error', identifier: { custom: { id: 'proj-1/bad.pdf' } } }],
    } as any);

    await handler(makeS3Event([{ key: 'proj-1/bad.pdf' }]));

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    const values = updates[0].args[0].input.ExpressionAttributeValues!;
    expect(values[':status']).toBe('FAILED');
    expect(values[':reason']).toBe('parse error');
  });

  describe('synchronous status is never written as a non-pollable terminal status', () => {
    // The poller is the single authority for SUCCESS/FAILED + the trigger and
    // only re-polls pollable rows. IngestKnowledgeBaseDocuments can synchronously
    // return IGNORED (dedup) or even INDEXED; neither may be persisted terminally.
    test('IGNORED (Bedrock dedup) is persisted as a POLLABLE status, no statusReason', async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{
          status: 'IGNORED',
          statusReason: 'You submitted multiple requests for the same document',
          identifier: { custom: { id: 'proj-1/dup.pdf' } },
        }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/dup.pdf' }]));

      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      const input = updates[0].args[0].input;
      const values = input.ExpressionAttributeValues!;
      expect(values[':status']).toBe('IN_PROGRESS');
      expect(values[':status']).not.toBe('IGNORED');
      // No statusReason is written for a non-failure synchronous status.
      expect(values[':reason']).toBeUndefined();
      expect(input.UpdateExpression).not.toMatch(/statusReason = :reason/);
    });

    test('synchronous INDEXED is persisted as a pollable status (poller owns INDEXED)', async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'INDEXED', identifier: { custom: { id: 'proj-1/fast.pdf' } } }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/fast.pdf' }]));

      const values = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues!;
      expect(values[':status']).toBe('IN_PROGRESS');
      expect(values[':reason']).toBeUndefined();
    });

    test('STARTING is persisted as-is (already pollable)', async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'STARTING', identifier: { custom: { id: 'proj-1/s.pdf' } } }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/s.pdf' }]));

      const values = ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues!;
      expect(values[':status']).toBe('STARTING');
    });
  });

  describe('retry of an existing row (conditional create fails)', () => {
    const resetCall = () =>
      ddbMock
        .commandCalls(UpdateCommand)
        .find((u) => (u.args[0].input.UpdateExpression as string).includes('REMOVE statusReason'));

    test('existing FAILED row is reset to STARTING (statusReason removed) and re-ingested', async () => {
      ddbMock.on(PutCommand).rejects(condFailed());
      ddbMock.on(GetCommand).resolves({
        Item: { projectId: 'proj-1', documentKey: 'proj-1/report.pdf', status: 'FAILED', statusReason: 'old parse error' },
      });
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'IN_PROGRESS' }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/report.pdf', size: 999 }]));

      const reset = resetCall();
      expect(reset).toBeDefined();
      const input = reset!.args[0].input;
      const values = input.ExpressionAttributeValues!;
      expect(values[':starting']).toBe('STARTING');
      expect(values[':false']).toBe(false);
      expect(values[':zero']).toBe(0);
      expect(values[':size']).toBe(999);
      expect(values[':expected']).toBe('FAILED');
      expect(input.UpdateExpression).toMatch(/REMOVE statusReason/);
      expect(input.ConditionExpression).toBe('#status = :expected');
      // startIngestion ran, and the post-start status was recorded.
      expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(1);
    });

    test('existing in-flight STARTING row is skipped (no reset, no re-ingest)', async () => {
      ddbMock.on(PutCommand).rejects(condFailed());
      ddbMock.on(GetCommand).resolves({
        Item: { projectId: 'proj-1', documentKey: 'proj-1/report.pdf', status: 'STARTING' },
      });
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'IN_PROGRESS' }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/report.pdf' }]));

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(0);
    });

    test('existing INDEXED row is reset and re-ingested (retry of a succeeded doc)', async () => {
      ddbMock.on(PutCommand).rejects(condFailed());
      ddbMock.on(GetCommand).resolves({
        Item: { projectId: 'proj-1', documentKey: 'proj-1/report.pdf', status: 'INDEXED' },
      });
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'IN_PROGRESS' }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/report.pdf' }]));

      const reset = resetCall();
      expect(reset).toBeDefined();
      expect(reset!.args[0].input.ExpressionAttributeValues![':expected']).toBe('INDEXED');
      expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(1);
    });

    test('brand-new key takes the create path without a GetItem', async () => {
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'IN_PROGRESS' }],
      } as any);

      await handler(makeS3Event([{ key: 'proj-1/fresh.pdf' }]));

      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
      expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(1);
    });

    test('concurrent reset race: guarded UpdateItem ConditionalCheckFailed -> no re-ingest, no throw', async () => {
      ddbMock.on(PutCommand).rejects(condFailed());
      ddbMock.on(GetCommand).resolves({
        Item: { projectId: 'proj-1', documentKey: 'proj-1/report.pdf', status: 'FAILED' },
      });
      // The guarded reset loses the race.
      ddbMock.on(UpdateCommand).rejects(condFailed());
      bedrockMock.on(IngestKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'IN_PROGRESS' }],
      } as any);

      await expect(handler(makeS3Event([{ key: 'proj-1/report.pdf' }]))).resolves.toBeUndefined();

      expect(bedrockMock.commandCalls(IngestKnowledgeBaseDocumentsCommand)).toHaveLength(0);
    });
  });
});
