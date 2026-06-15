/**
 * Tests for agent-code-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'stream';
import { sdkStreamMixin } from '@smithy/util-stream';

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

import { handler } from '../agent-code-resolver';

describe('agent-code-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    process.env.AGENT_BUCKET_NAME = 'test-bucket';
    process.env.AGENT_CONFIG_TABLE = 'test-agent-config';
  });

  afterEach(() => {
    delete process.env.AGENT_BUCKET_NAME;
    delete process.env.AGENT_CONFIG_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('getAgentCode', () => {
    test('returns code from S3 using filename from config', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { filename: 'my_agent.py' } },
      });

      const stream = new Readable();
      stream.push('def handler(): pass');
      stream.push(null);
      const sdkStream = sdkStreamMixin(stream);

      s3Mock.on(GetObjectCommand).resolves({
        Body: sdkStream as any,
        VersionId: 'v1',
        LastModified: new Date('2025-01-01'),
      });

      const result = await handler(makeEvent('getAgentCode', { agentId: 'a1' }) as any);

      expect(result.agentId).toBe('a1');
      expect(result.code).toBe('def handler(): pass');
      expect(result.version).toBe('v1');
    });

    test('returns default code when S3 key not found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { filename: 'missing.py' } },
      });

      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

      const result = await handler(makeEvent('getAgentCode', { agentId: 'a1' }) as any);

      expect(result.agentId).toBe('a1');
      expect(result.code).toContain('def handler');
      expect(result.version).toBeNull();
    });

    test('throws when agent config not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('getAgentCode', { agentId: 'missing' }) as any)
      ).rejects.toThrow('Agent config not found');
    });
  });

  describe('updateAgentCode', () => {
    test('writes code to S3', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { filename: 'my_agent.py' } },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: 'v2' });

      const result = await handler(makeEvent('updateAgentCode', {
        input: { agentId: 'a1', code: 'print("hello")' },
      }) as any);

      expect(result.agentId).toBe('a1');
      expect(result.code).toBe('print("hello")');

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Key).toBe('agents/my_agent.py');
    });

    test('throws when agent config not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('updateAgentCode', {
          input: { agentId: 'missing', code: 'x' },
        }) as any)
      ).rejects.toThrow('Failed to update agent code');
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}) as any)).rejects.toThrow('Unknown field');
  });
});
