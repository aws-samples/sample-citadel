/**
 * Tests for document-upload-resolver Lambda
 */
import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

const s3Mock = mockClient(S3Client);

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
    process.env.DOCUMENT_BUCKET = 'test-docs-bucket';
  });

  afterEach(() => {
    delete process.env.DOCUMENT_BUCKET;
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

  test('throws on unknown field', async () => {
    await expect(
      handler(makeEvent('unknownField', {}) as any)
    ).rejects.toThrow('Unknown field');
  });
});
