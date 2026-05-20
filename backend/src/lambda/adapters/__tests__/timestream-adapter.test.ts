import { TimestreamAdapter } from '../timestream-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-timestream-write', () => {
  return {
    TimestreamWriteClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateDatabaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateDatabase', input })),
    CreateTableCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateTable', input })),
    DescribeDatabaseCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeDatabase', input })),
  };
});

describe('TimestreamAdapter', () => {
  let adapter: TimestreamAdapter;
  const config = { databaseName: 'my-test-db' };

  beforeEach(() => {
    adapter = new TimestreamAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateDatabase, CreateTable, DescribeDatabase', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toContain('timestream:CreateDatabase');
      expect(policies.provision[0].actions).toContain('timestream:DescribeDatabase');
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for DescribeDatabase, DescribeTable, WriteRecords, Select', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual([
        'timestream:DescribeDatabase',
        'timestream:DescribeTable',
        'timestream:WriteRecords',
        'timestream:Select',
      ]);
    });

    it('uses wildcard resource for provision', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual(['*']);
    });
  });

  describe('provision', () => {
    it('creates a database and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db' },
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:timestream:us-east-1:123:database/my-test-db');
    });

    it('creates a table when tableName is in config', async () => {
      const { CreateTableCommand } = require('@aws-sdk/client-timestream-write');
      mockSend
        .mockResolvedValueOnce({ Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db' } })
        .mockResolvedValueOnce({ Table: { Arn: 'arn:aws:timestream:us-east-1:123:table/my-test-db/my-table' } });

      const configWithTable = { ...config, tableName: 'my-table', retentionProperties: { MemoryStoreRetentionPeriodInHours: '24' } };
      await adapter.provision(configWithTable);
      expect(CreateTableCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DatabaseName: 'my-test-db',
          TableName: 'my-table',
        })
      );
    });

    it('handles ConflictException on database creation as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'ConflictException';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-test-db');
    });

    it('handles ConflictException on table creation as idempotent success', async () => {
      const tableError = new Error('Table already exists');
      (tableError as any).name = 'ConflictException';
      mockSend
        .mockResolvedValueOnce({ Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db' } })
        .mockRejectedValueOnce(tableError);

      const configWithTable = { ...config, tableName: 'my-table' };
      const result = await adapter.provision(configWithTable);
      expect(result.resourceArn).toBe('arn:aws:timestream:us-east-1:123:database/my-test-db');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config);
        fail('Expected ProvisioningError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect(err.cause).toBe(sdkError);
      }
    });

    it('propagates non-ConflictException table errors as ProvisioningError', async () => {
      const tableError = new Error('Validation failed');
      (tableError as any).name = 'ValidationException';
      mockSend
        .mockResolvedValueOnce({ Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db' } })
        .mockRejectedValueOnce(tableError);

      const configWithTable = { ...config, tableName: 'my-table' };
      await expect(adapter.provision(configWithTable)).rejects.toThrow(ProvisioningError);
    });
  });

  describe('connect', () => {
    it('succeeds when database exists', async () => {
      mockSend.mockResolvedValueOnce({
        Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db', DatabaseName: 'my-test-db' },
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ResourceNotFoundError when database does not exist', async () => {
      const sdkError = new Error('Not found');
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

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      (sdkError as any).name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect(err.cause).toBe(sdkError);
      }
    });

    it('throws ResourceNotFoundError when Database is null', async () => {
      mockSend.mockResolvedValueOnce({ Database: null });
      await expect(adapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with database details', async () => {
      mockSend.mockResolvedValueOnce({
        Database: {
          Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db',
          TableCount: 5,
        },
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.arn).toBe('arn:aws:timestream:us-east-1:123:database/my-test-db');
      expect(result.details?.tableCount).toBe(5);
    });

    it('returns failure when DescribeDatabase fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns table count as records and placeholder size', async () => {
      mockSend.mockResolvedValueOnce({
        Database: { TableCount: 3 },
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('0 MB');
      expect(result.records).toBe(3);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      (sdkError as any).name = 'RequestTimeout';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      const { TimestreamWriteClient } = require('@aws-sdk/client-timestream-write');
      mockSend.mockResolvedValueOnce({
        Database: { Arn: 'arn:aws:timestream:us-east-1:123:database/my-test-db', DatabaseName: 'my-test-db' },
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(TimestreamWriteClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
