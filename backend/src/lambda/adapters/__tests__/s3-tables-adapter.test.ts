import { S3TablesAdapter } from '../s3-tables-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { S3TablesClient } from '@aws-sdk/client-s3tables';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3tables', () => {
  return {
    S3TablesClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateTableBucketCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateTableBucket', input })),
    GetTableBucketCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetTableBucket', input })),
    ListTablesCommand: jest.fn().mockImplementation((input) => ({ _type: 'ListTables', input })),
  };
});

describe('S3TablesAdapter', () => {
  let adapter: S3TablesAdapter;
  const config = {
    tableBucketName: 'my-test-bucket',
    tableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-test-bucket',
  };

  beforeEach(() => {
    adapter = new S3TablesAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for s3tables actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        's3tables:CreateTableBucket',
        's3tables:CreateTable',
        's3tables:GetTableBucket',
      ]);
      expect(policies.provision[0].resources).toEqual([
        'arn:aws:s3tables:us-east-1:123456789012:bucket/*',
      ]);
    });

    it('returns connect policies for s3tables actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        's3tables:GetTableBucket',
        's3tables:GetTable',
        's3tables:ListTables',
      ]);
      expect(policies.connect[0].resources).toEqual([
        'arn:aws:s3tables:us-east-1:123456789012:bucket/*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a table bucket and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        arn: 'arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket',
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket');
    });

    it('handles ConflictException as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'ConflictException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-test-bucket');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when table bucket exists', async () => {
      mockSend.mockResolvedValueOnce({
        arn: 'arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket',
        name: 'my-test-bucket',
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ResourceNotFoundError when table bucket does not exist', async () => {
      const sdkError = new Error('Not found');
      sdkError.name = 'NotFoundException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      sdkError.name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it('throws ResourceNotFoundError when arn is null in response', async () => {
      mockSend.mockResolvedValueOnce({ arn: null });
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with table bucket details', async () => {
      mockSend.mockResolvedValueOnce({
        arn: 'arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket',
        name: 'my-test-bucket',
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.arn).toBe('arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket');
      expect(result.details?.name).toBe('my-test-bucket');
    });

    it('returns failure when GetTableBucket fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns table count from ListTables', async () => {
      mockSend.mockResolvedValueOnce({
        tables: [
          { name: 'table1', namespace: 'ns1' },
          { name: 'table2', namespace: 'ns1' },
        ],
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0 MB');
      expect(result.records).toBe(2);
    });

    it('returns zero when no tables exist', async () => {
      mockSend.mockResolvedValueOnce({ tables: [] });
      const result = await adapter.getMetrics(config);
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      sdkError.name = 'RequestTimeout';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      mockSend.mockResolvedValueOnce({
        arn: 'arn:aws:s3tables:us-east-1:123:bucket/my-test-bucket',
        name: 'my-test-bucket',
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(S3TablesClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
