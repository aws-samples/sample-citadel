import { DynamoDBAdapter } from '../dynamodb-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

// Mock the entire @aws-sdk/client-dynamodb module
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateTableCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateTable', input })),
    DescribeTableCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeTable', input })),
    KeyType: { HASH: 'HASH', RANGE: 'RANGE' },
    ScalarAttributeType: { S: 'S' },
    BillingMode: { PAY_PER_REQUEST: 'PAY_PER_REQUEST' },
  };
});

describe('DynamoDBAdapter', () => {
  let adapter: DynamoDBAdapter;
  const config = { tableName: 'my-test-table' };

  beforeEach(() => {
    adapter = new DynamoDBAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateTable and DescribeTable', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'dynamodb:CreateTable',
        'dynamodb:DeleteTable',
        'dynamodb:DescribeTable',
      ]);
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });

    it('returns connect policies for CRUD operations on table and indexes', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'dynamodb:DescribeTable',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ]);
      expect(policies.connect[0].resources).toEqual([
        'arn:aws:dynamodb:us-east-1:123456789012:table/my-test-table',
        'arn:aws:dynamodb:us-east-1:123456789012:table/my-test-table/index/*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a table and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await adapter.provision({
        ...config,
        region: 'us-east-1',
        accountId: '123456789012',
      });
      expect(result.resourceArn).toBe(
        'arn:aws:dynamodb:us-east-1:123456789012:table/my-test-table'
      );
    });

    it('uses default partition key "pk" and no sort key when sortKey not provided', async () => {
      const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
      mockSend.mockResolvedValueOnce({});
      await adapter.provision(config);
      expect(CreateTableCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'my-test-table',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        })
      );
    });

    it('uses custom partition and sort keys from config', async () => {
      const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
      mockSend.mockResolvedValueOnce({});
      await adapter.provision({
        ...config,
        partitionKey: 'userId',
        sortKey: 'timestamp',
      });
      expect(CreateTableCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
        })
      );
    });

    it('handles ResourceInUseException as idempotent success', async () => {
      const sdkError = new Error('Table already exists');
      (sdkError as any).name = 'ResourceInUseException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-test-table');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalServerError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(ProvisioningError);
    });

    it('preserves the original SDK error as cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalServerError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err: any) {
        expect(err.cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when table status is ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'ACTIVE' },
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when table is not ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'CREATING' },
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when table does not exist', async () => {
      const sdkError = new Error('Table not found');
      (sdkError as any).name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('throws ConnectionError on other errors', async () => {
      const sdkError = new Error('Network issue');
      (sdkError as any).name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('preserves SDK error as cause in ConnectionError', async () => {
      const sdkError = new Error('Network issue');
      (sdkError as any).name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err: any) {
        expect(err.cause).toBe(sdkError);
      }
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with table details when DescribeTable succeeds', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableStatus: 'ACTIVE',
          ItemCount: 100,
          TableSizeBytes: 2048,
        },
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.message).toContain('my-test-table');
      expect(result.details).toEqual({
        tableStatus: 'ACTIVE',
        itemCount: 100,
        tableSizeBytes: 2048,
      });
    });

    it('returns failure when DescribeTable fails', async () => {
      const sdkError = new Error('Not Found');
      (sdkError as any).name = 'ResourceNotFoundException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed');
    });

    it('defaults itemCount and tableSizeBytes to 0 when not present', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'ACTIVE' },
      });
      const result = await adapter.testConnection(config);
      expect(result.details?.itemCount).toBe(0);
      expect(result.details?.tableSizeBytes).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('returns size in MB and item count from DescribeTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableSizeBytes: 5242880, // 5 MB
          ItemCount: 1000,
        },
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('5.00 MB');
      expect(result.records).toBe(1000);
    });

    it('returns 0 when table has no data', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableSizeBytes: 0,
          ItemCount: 0,
        },
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0.00 MB');
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      (sdkError as any).name = 'TimeoutError';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'ACTIVE' },
      });
      const creds = {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      };
      await adapter.connect(config, creds);
      expect(DynamoDBClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });

    it('constructs default client when no credentials provided', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'ACTIVE' },
      });
      await adapter.connect(config);
      expect(DynamoDBClient).toHaveBeenCalledWith({});
    });
  });
});
