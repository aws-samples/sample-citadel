import { RdsAdapter } from '../rds-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { RDSClient, CreateDBInstanceCommand } from '@aws-sdk/client-rds';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds', () => {
  return {
    RDSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateDBInstanceCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateDBInstance', input })),
    DescribeDBInstancesCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeDBInstances', input })),
    AddTagsToResourceCommand: jest.fn().mockImplementation((input) => ({ _type: 'AddTags', input })),
  };
});

describe('RdsAdapter', () => {
  let postgresAdapter: RdsAdapter;
  let mysqlAdapter: RdsAdapter;
  const config = { dbInstanceIdentifier: 'my-test-db' };
  const creds = { masterUsername: 'dbadmin', masterPassword: 'secret123' };

  beforeEach(() => {
    postgresAdapter = new RdsAdapter('postgres');
    mysqlAdapter = new RdsAdapter('mysql');
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateDBInstance, DescribeDBInstances, AddTagsToResource', () => {
      const policies = postgresAdapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'rds:CreateDBInstance',
        'rds:DeleteDBInstance',
        'rds:DescribeDBInstances',
        'rds:AddTagsToResource',
      ]);
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });

    it('returns connect policies for DescribeDBInstances', () => {
      const policies = postgresAdapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual(['rds:DescribeDBInstances']);
    });
  });

  describe('provision', () => {
    it('creates an instance and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstance: { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-test-db' },
      });
      const result = await postgresAdapter.provision(config, creds);
      expect(result.resourceArn).toBe('arn:aws:rds:us-east-1:123:db:my-test-db');
    });

    it('uses postgres engine for postgres adapter', async () => {
      mockSend.mockResolvedValueOnce({ DBInstance: {} });
      await postgresAdapter.provision(config, creds);
      expect(CreateDBInstanceCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'postgres' })
      );
    });

    it('uses mysql engine for mysql adapter', async () => {
      mockSend.mockResolvedValueOnce({ DBInstance: {} });
      await mysqlAdapter.provision(config, creds);
      expect(CreateDBInstanceCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'mysql' })
      );
    });

    it('throws ProvisioningError when credentials are missing', async () => {
      await expect(postgresAdapter.provision(config, {})).rejects.toThrow(ProvisioningError);
    });

    it('handles DBInstanceAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'DBInstanceAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await postgresAdapter.provision(config, creds);
      expect(result.resourceArn).toContain('my-test-db');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.provision(config, creds)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await postgresAdapter.provision(config, creds);
        fail('Expected ProvisioningError');
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when instance status is available', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });
      await expect(postgresAdapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when instance is not available', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceStatus: 'creating' }],
      });
      await expect(postgresAdapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when instance does not exist', async () => {
      const sdkError = new Error('Not found');
      sdkError.name = 'DBInstanceNotFoundFault';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      sdkError.name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await postgresAdapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(postgresAdapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with instance details', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstances: [{
          DBInstanceStatus: 'available',
          Endpoint: { Address: 'mydb.abc.us-east-1.rds.amazonaws.com', Port: 5432 },
          Engine: 'postgres',
          AllocatedStorage: 20,
        }],
      });
      const result = await postgresAdapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.endpoint).toBe('mydb.abc.us-east-1.rds.amazonaws.com');
      expect(result.details?.port).toBe(5432);
    });

    it('returns failure when DescribeDBInstances fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await postgresAdapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns allocated storage and zero records', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstances: [{ AllocatedStorage: 100 }],
      });
      const result = await postgresAdapter.getMetrics(config);
      expect(result.size).toBe('100 GB');
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      mockSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });
      await postgresAdapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(RDSClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
