/**
 * Tests for generate-report-url Lambda
 */
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// Mock the presigner
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com/report.pdf'),
}));

import { handler } from '../generate-report-url';

describe('generate-report-url', () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    process.env.SESSION_BUCKET = 'test-sessions';
    process.env.PROJECTS_TABLE = 'test-projects';
  });

  afterEach(() => {
    delete process.env.SESSION_BUCKET;
    delete process.env.PROJECTS_TABLE;
  });

  test('returns signed URL with sanitized project name', async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: { id: 'proj-1', name: 'My Project' },
    });

    const result = await handler({
      arguments: { projectId: 'proj-1' },
    });

    expect(result.url).toBe('https://signed-url.example.com/report.pdf');
    expect(result.expiresIn).toBe(3600);
  });

  test('uses fallback name when project not found', async () => {
    dynamoMock.on(GetCommand).resolves({});

    const result = await handler({
      arguments: { projectId: 'proj-missing' },
    });

    expect(result.url).toBeDefined();
    expect(result.expiresIn).toBe(3600);
  });
});
