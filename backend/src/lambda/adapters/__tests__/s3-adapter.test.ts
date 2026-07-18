import { S3Adapter } from '../s3-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { S3Client } from '@aws-sdk/client-s3';

// Mock the entire @aws-sdk/client-s3 module
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateBucketCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateBucket', input })),
    PutBucketVersioningCommand: jest.fn().mockImplementation((input) => ({ _type: 'PutBucketVersioning', input })),
    HeadBucketCommand: jest.fn().mockImplementation((input) => ({ _type: 'HeadBucket', input })),
    ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ _type: 'ListObjectsV2', input })),
  };
});

describe('S3Adapter', () => {
  let adapter: S3Adapter;
  const config = { bucketName: 'my-test-bucket' };

  beforeEach(() => {
    adapter = new S3Adapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies including create, delete, and list actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toContain('s3:CreateBucket');
      expect(policies.provision[0].actions).toContain('s3:DeleteBucket');
      expect(policies.provision[0].actions).toContain('s3:DeleteObject');
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for read/write operations on bucket and objects', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        's3:HeadBucket',
        's3:ListBucket',
        's3:ListObjectsV2',
        's3:GetObject',
        's3:PutObject',
      ]);
      expect(policies.connect[0].resources).toEqual([
        'arn:aws:s3:::my-test-bucket',
        'arn:aws:s3:::my-test-bucket/*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a bucket and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:s3:::my-test-bucket');
    });

    it('enables versioning when config.versioning is true', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockResolvedValueOnce({}); // PutBucketVersioning
      await adapter.provision({ ...config, versioning: true });
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('handles BucketAlreadyOwnedByYou as idempotent success', async () => {
      const sdkError = new Error('Bucket already owned by you');
      sdkError.name = 'BucketAlreadyOwnedByYou';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:s3:::my-test-bucket');
    });

    it('wraps AccessDenied in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(ProvisioningError);
    });

    it('preserves the original SDK error as cause', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err) {
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it('wraps versioning AccessDenied in PermissionError', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateBucket succeeds
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(
        adapter.provision({ ...config, versioning: true })
      ).rejects.toThrow(PermissionError);
    });
  });

  describe('connect', () => {
    it('succeeds when HeadBucket succeeds', async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ResourceNotFoundError when bucket does not exist', async () => {
      const sdkError = new Error('Not Found');
      sdkError.name = 'NotFound';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDenied', async () => {
      const sdkError = new Error('Forbidden');
      sdkError.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('throws ConnectionError on other errors', async () => {
      const sdkError = new Error('Network issue');
      sdkError.name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('preserves SDK error as cause in ConnectionError', async () => {
      const sdkError = new Error('Network issue');
      sdkError.name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err) {
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success when HeadBucket succeeds', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.message).toContain('my-test-bucket');
    });

    it('returns failure when HeadBucket fails', async () => {
      const sdkError = new Error('Not Found');
      sdkError.name = 'NotFound';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed');
    });
  });

  describe('getMetrics', () => {
    it('returns object count from ListObjectsV2', async () => {
      mockSend.mockResolvedValueOnce({
        KeyCount: 42,
        IsTruncated: false,
      });
      const result = await adapter.getMetrics(config);
      expect(result.records).toBe(42);
      expect(result.size).toBe('42 objects');
    });

    it('paginates through truncated results', async () => {
      mockSend.mockResolvedValueOnce({
        KeyCount: 1000,
        IsTruncated: true,
        NextContinuationToken: 'token1',
      });
      mockSend.mockResolvedValueOnce({
        KeyCount: 500,
        IsTruncated: false,
      });
      const result = await adapter.getMetrics(config);
      expect(result.records).toBe(1500);
    });

    it('wraps AccessDenied in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDenied';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      sdkError.name = 'TimeoutError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      mockSend.mockResolvedValueOnce({});
      const creds = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      };
      await adapter.connect(config, creds);
      expect(S3Client).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });

    it('constructs default client when no credentials provided', async () => {
      mockSend.mockResolvedValueOnce({});
      await adapter.connect(config);
      expect(S3Client).toHaveBeenCalledWith({});
    });
  });
});
