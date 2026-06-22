/**
 * Tests for document-upload-resolver Lambda
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  BedrockAgentClient,
  GetKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const s3Mock = mockClient(S3Client);
const bedrockMock = mockClient(BedrockAgentClient);
const ssmMock = mockClient(SSMClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com/upload'),
}));

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../document-upload-resolver';

describe('document-upload-resolver', () => {
  beforeEach(() => {
    s3Mock.reset();
    bedrockMock.reset();
    ssmMock.reset();
    ddbMock.reset();
    process.env.DOCUMENT_BUCKET = 'test-docs-bucket';
    process.env.KB_ID_PARAM = '/citadel/kb/id';
    process.env.DS_ID_PARAM = '/citadel/ds/id';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    // INGESTION_TABLE is left unset by default so status reads fall back to the
    // KB query path; individual tests opt in to the jobs-table path.
    delete process.env.INGESTION_TABLE;
    // SSM resolves KB + DS ids (cached at module level after first call)
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'kb-or-ds-id' } });
  });

  afterEach(() => {
    delete process.env.DOCUMENT_BUCKET;
    delete process.env.KB_ID_PARAM;
    delete process.env.DS_ID_PARAM;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.INGESTION_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123' },
  });

  describe('generateDocumentUploadUrl', () => {
    test('returns signed URL for valid PDF upload', async () => {
      const result = await handler(makeEvent('generateDocumentUploadUrl', {
        input: {
          projectId: 'proj-1',
          fileName: 'report.pdf',
          fileType: 'application/pdf',
          fileSize: 1024,
        },
      }) as any);

      expect(result.uploadUrl).toBe('https://signed-url.example.com/upload');
      expect(result.documentKey).toContain('proj-1');
      expect(result.expiresIn).toBe(900);
    });

    test('rejects files exceeding 10MB', async () => {
      await expect(
        handler(makeEvent('generateDocumentUploadUrl', {
          input: {
            projectId: 'proj-1',
            fileName: 'huge.pdf',
            fileType: 'application/pdf',
            fileSize: 11 * 1024 * 1024,
          },
        }) as any)
      ).rejects.toThrow('exceeds maximum');
    });

    test('rejects unsupported file types', async () => {
      await expect(
        handler(makeEvent('generateDocumentUploadUrl', {
          input: {
            projectId: 'proj-1',
            fileName: 'image.png',
            fileType: 'image/png',
            fileSize: 1024,
          },
        }) as any)
      ).rejects.toThrow('not allowed');
    });

    test('accepts DOCX files', async () => {
      const result = await handler(makeEvent('generateDocumentUploadUrl', {
        input: {
          projectId: 'proj-1',
          fileName: 'doc.docx',
          fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileSize: 2048,
        },
      }) as any);

      expect(result.uploadUrl).toBeDefined();
    });

    test('accepts TXT files', async () => {
      const result = await handler(makeEvent('generateDocumentUploadUrl', {
        input: {
          projectId: 'proj-1',
          fileName: 'notes.txt',
          fileType: 'text/plain',
          fileSize: 512,
        },
      }) as any);

      expect(result.uploadUrl).toBeDefined();
    });

    test('accepts Markdown files', async () => {
      const result = await handler(makeEvent('generateDocumentUploadUrl', {
        input: {
          projectId: 'proj-1',
          fileName: 'readme.md',
          fileType: 'text/markdown',
          fileSize: 256,
        },
      }) as any);

      expect(result.uploadUrl).toBeDefined();
    });
  });

  describe('retired client-side ingestion fields', () => {
    test('ingestDocument is no longer a handled field', async () => {
      await expect(
        handler(makeEvent('ingestDocument', {
          projectId: 'proj-1',
          documentKey: 'proj-1/a.pdf',
        }) as any)
      ).rejects.toThrow('Unknown field');
    });

    test('notifyDocumentReady is no longer a handled field', async () => {
      await expect(
        handler(makeEvent('notifyDocumentReady', {
          projectId: 'proj-1',
          documentKey: 'proj-1/a.pdf',
          fileName: 'a.pdf',
          fileSize: 2048,
          fileType: 'application/pdf',
        }) as any)
      ).rejects.toThrow('Unknown field');
    });
  });

  describe('listProjectDocuments', () => {
    test('reads ingestion status from the jobs table when INGESTION_TABLE is set', async () => {
      process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: 'proj-1/a.pdf', Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') },
          { Key: 'proj-1/b.pdf', Size: 200, LastModified: new Date('2026-01-02T00:00:00Z') },
        ],
      });
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { projectId: 'proj-1', documentKey: 'proj-1/a.pdf', status: 'INDEXED' },
          { projectId: 'proj-1', documentKey: 'proj-1/b.pdf', status: 'FAILED', statusReason: 'oops' },
        ],
      });

      const result = await handler(makeEvent('listProjectDocuments', { projectId: 'proj-1' }) as any);

      expect(result).toHaveLength(2);
      const a = result.find((r: any) => r.documentKey === 'proj-1/a.pdf');
      const b = result.find((r: any) => r.documentKey === 'proj-1/b.pdf');
      expect(a.status).toBe('INDEXED');
      expect(b.status).toBe('FAILED');
      expect(b.statusReason).toBe('oops');
      // Source of truth is the table — no KB query needed.
      expect(bedrockMock.commandCalls(GetKnowledgeBaseDocumentsCommand)).toHaveLength(0);
    });

    test('falls back to the KB query when the jobs-table read fails', async () => {
      process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'proj-1/a.pdf', Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') }],
      });
      ddbMock.on(QueryCommand).rejects(new Error('table unavailable'));
      bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'INDEXED', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
      } as any);

      const result = await handler(makeEvent('listProjectDocuments', { projectId: 'proj-1' }) as any);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('INDEXED');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('degrades to UNKNOWN (does not throw) when both table and KB fail', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // INGESTION_TABLE unset -> straight to KB fallback, which also fails.
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'proj-1/a.pdf', Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') }],
      });
      bedrockMock.on(GetKnowledgeBaseDocumentsCommand).rejects(new Error('throttled'));

      const result = await handler(makeEvent('listProjectDocuments', { projectId: 'proj-1' }) as any);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('UNKNOWN');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('getDocumentIngestionStatus', () => {
    test('reads the jobs table as source of truth', async () => {
      process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
      ddbMock.on(GetCommand).resolves({
        Item: { projectId: 'proj-1', documentKey: 'proj-1/a.pdf', status: 'INDEXED', updatedAt: '2026-01-01T00:00:00Z' },
      });

      const result = await handler(makeEvent('getDocumentIngestionStatus', { documentKey: 'proj-1/a.pdf' }) as any);

      expect(result.status).toBe('INDEXED');
      expect(bedrockMock.commandCalls(GetKnowledgeBaseDocumentsCommand)).toHaveLength(0);
    });

    test('falls back to the KB query when the row is absent', async () => {
      process.env.INGESTION_TABLE = 'citadel-document-ingestion-test';
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      bedrockMock.on(GetKnowledgeBaseDocumentsCommand).resolves({
        documentDetails: [{ status: 'PARTIALLY_INDEXED', identifier: { custom: { id: 'proj-1/a.pdf' } } }],
      } as any);

      const result = await handler(makeEvent('getDocumentIngestionStatus', { documentKey: 'proj-1/a.pdf' }) as any);

      expect(result.status).toBe('PARTIALLY_INDEXED');
    });
  });

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}) as any)
    ).rejects.toThrow('Unknown field');
  });
});
