import { AuroraAdapter } from '../aurora-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds', () => {
  return {
    RDSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateDBClusterCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateDBCluster', input })),
    DescribeDBClustersCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeDBClusters', input })),
  };
});

describe('AuroraAdapter', () => {
  let postgresAdapter: AuroraAdapter;
  let mysqlAdapter: AuroraAdapter;
  const config = { dbClusterIdentifier: 'my-test-cluster' };
  const creds = { masterUsername: 'dbadmin', masterPassword: 'secret123' };

  beforeEach(() => {
    postgresAdapter = new AuroraAdapter('postgres');
    mysqlAdapter = new AuroraAdapter('mysql');
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateDBCluster, DescribeDBClusters, AddTagsToResource', () => {
      const policies = postgresAdapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'rds:CreateDBCluster',
        'rds:DeleteDBCluster',
        'rds:DescribeDBClusters',
        'rds:AddTagsToResource',
      ]);
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });

    it('returns connect policies for DescribeDBClusters', () => {
      const policies = postgresAdapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual(['rds:DescribeDBClusters']);
    });

    it('uses wildcard when dbClusterIdentifier is not in config', () => {
      const policies = postgresAdapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a cluster and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        DBCluster: { DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-test-cluster' },
      });
      const result = await postgresAdapter.provision(config, creds);
      expect(result.resourceArn).toBe('arn:aws:rds:us-east-1:123:cluster:my-test-cluster');
    });

    it('uses aurora-postgresql engine for postgres adapter', async () => {
      const { CreateDBClusterCommand } = require('@aws-sdk/client-rds');
      mockSend.mockResolvedValueOnce({ DBCluster: {} });
      await postgresAdapter.provision(config, creds);
      expect(CreateDBClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'aurora-postgresql' })
      );
    });

    it('uses aurora-mysql engine for mysql adapter', async () => {
      const { CreateDBClusterCommand } = require('@aws-sdk/client-rds');
      mockSend.mockResolvedValueOnce({ DBCluster: {} });
      await mysqlAdapter.provision(config, creds);
      expect(CreateDBClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'aurora-mysql' })
      );
    });

    it('throws ProvisioningError when credentials are missing', async () => {
      await expect(postgresAdapter.provision(config, {})).rejects.toThrow(ProvisioningError);
    });

    it('handles DBClusterAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'DBClusterAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await postgresAdapter.provision(config, creds);
      expect(result.resourceArn).toContain('my-test-cluster');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.provision(config, creds)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await postgresAdapter.provision(config, creds);
        fail('Expected ProvisioningError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProvisioningError);
        expect(err.cause).toBe(sdkError);
      }
    });
  });

  describe('connect', () => {
    it('succeeds when cluster status is available', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'available' }],
      });
      await expect(postgresAdapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when cluster is not available', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'creating' }],
      });
      await expect(postgresAdapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when cluster does not exist', async () => {
      const sdkError = new Error('Not found');
      (sdkError as any).name = 'DBClusterNotFoundFault';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.connect(config)).rejects.toThrow(ResourceNotFoundError);
    });

    it('throws PermissionError on AccessDeniedException', async () => {
      const sdkError = new Error('Forbidden');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.connect(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError with cause', async () => {
      const sdkError = new Error('Network issue');
      (sdkError as any).name = 'NetworkingError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await postgresAdapter.connect(config);
        fail('Expected ConnectionError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect(err.cause).toBe(sdkError);
      }
    });
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(postgresAdapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with cluster details', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{
          Status: 'available',
          Endpoint: 'my-cluster.cluster-abc.us-east-1.rds.amazonaws.com',
          Port: 5432,
          Engine: 'aurora-postgresql',
        }],
      });
      const result = await postgresAdapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.endpoint).toBe('my-cluster.cluster-abc.us-east-1.rds.amazonaws.com');
      expect(result.details?.port).toBe(5432);
      expect(result.details?.engine).toBe('aurora-postgresql');
    });

    it('returns failure when DescribeDBClusters fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await postgresAdapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns allocated storage and zero records', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ AllocatedStorage: 100 }],
      });
      const result = await postgresAdapter.getMetrics(config);
      expect(result.size).toBe('100 GB');
      expect(result.records).toBe(0);
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.getMetrics(config)).rejects.toThrow(PermissionError);
    });

    it('wraps other errors in ConnectionError', async () => {
      const sdkError = new Error('Timeout');
      (sdkError as any).name = 'RequestTimeout';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(postgresAdapter.getMetrics(config)).rejects.toThrow(ConnectionError);
    });
  });

  describe('scoped credentials', () => {
    it('constructs client with provided credentials', async () => {
      const { RDSClient } = require('@aws-sdk/client-rds');
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'available' }],
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
