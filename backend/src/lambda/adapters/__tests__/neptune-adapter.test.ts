import { NeptuneAdapter } from '../neptune-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { NeptuneClient, CreateDBClusterCommand } from '@aws-sdk/client-neptune';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-neptune', () => {
  return {
    NeptuneClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateDBClusterCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateDBCluster', input })),
    DescribeDBClustersCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeDBClusters', input })),
  };
});

describe('NeptuneAdapter', () => {
  let adapter: NeptuneAdapter;
  const config = { dbClusterIdentifier: 'my-neptune-cluster' };

  beforeEach(() => {
    adapter = new NeptuneAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies with neptune-db and rds actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(2);
      expect(policies.provision[0].actions).toEqual(['neptune-db:*']);
      expect(policies.provision[0].resources).toEqual([
        '*',
      ]);
      expect(policies.provision[1].actions).toEqual([
        'rds:CreateDBCluster',
        'rds:DeleteDBCluster',
        'rds:DescribeDBClusters',
      ]);
      expect(policies.provision[1].resources).toEqual([
        '*',
      ]);
    });

    it('returns connect policies with neptune-db and rds actions', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(2);
      expect(policies.connect[0].actions).toEqual(['neptune-db:*']);
      expect(policies.connect[1].actions).toEqual(['rds:DescribeDBClusters']);
    });

    it('uses wildcard when dbClusterIdentifier is not in config', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[1].resources).toEqual([
        '*',
      ]);
    });
  });

  describe('provision', () => {
    it('creates a cluster with neptune engine and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        DBCluster: { DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-neptune-cluster' },
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:rds:us-east-1:123:cluster:my-neptune-cluster');
    });

    it('uses neptune engine in CreateDBClusterCommand', async () => {
      mockSend.mockResolvedValueOnce({ DBCluster: {} });
      await adapter.provision(config);
      expect(CreateDBClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'neptune' })
      );
    });

    it('handles DBClusterAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'DBClusterAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-neptune-cluster');
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
    it('succeeds when cluster status is available', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'available' }],
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when cluster is not available', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'creating' }],
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when cluster does not exist', async () => {
      const sdkError = new Error('Not found');
      sdkError.name = 'DBClusterNotFoundFault';
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
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with cluster details', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{
          Status: 'available',
          Endpoint: 'my-neptune-cluster.cluster-abc.us-east-1.neptune.amazonaws.com',
          Port: 8182,
        }],
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.endpoint).toBe('my-neptune-cluster.cluster-abc.us-east-1.neptune.amazonaws.com');
      expect(result.details?.port).toBe(8182);
      expect(result.details?.status).toBe('available');
    });

    it('returns failure when DescribeDBClusters fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns allocated storage and zero records', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ AllocatedStorage: 50 }],
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('50 GB');
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
        DBClusters: [{ Status: 'available' }],
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(NeptuneClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
