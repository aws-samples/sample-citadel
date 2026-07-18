import { DocumentDBAdapter } from '../documentdb-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
  DataStoreError,
} from '../errors';
import { DocDBClient, CreateDBClusterCommand } from '@aws-sdk/client-docdb';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-docdb', () => {
  return {
    DocDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateDBClusterCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateDBCluster', input })),
    DescribeDBClustersCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeDBClusters', input })),
  };
});

describe('DocumentDBAdapter', () => {
  let adapter: DocumentDBAdapter;
  const config = { dbClusterIdentifier: 'my-docdb-cluster' };
  const creds = { masterUsername: 'admin', masterPassword: 'secret123' };

  beforeEach(() => {
    adapter = new DocumentDBAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateDBCluster, DescribeDBClusters, AddTagsToResource', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision).toHaveLength(1);
      expect(policies.provision[0].actions).toEqual([
        'rds:CreateDBCluster',
        'rds:DeleteDBCluster',
        'rds:DescribeDBClusters',
        'rds:AddTagsToResource',
      ]);
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for DescribeDBClusters', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual(['rds:DescribeDBClusters']);
    });

    it('uses wildcard resource for provision', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual(['*']);
    });
  });

  describe('provision', () => {
    it('creates a cluster with docdb engine and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        DBCluster: { DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-docdb-cluster' },
      });
      const result = await adapter.provision(config, creds);
      expect(result.resourceArn).toBe('arn:aws:rds:us-east-1:123:cluster:my-docdb-cluster');
    });

    it('uses docdb engine', async () => {
      mockSend.mockResolvedValueOnce({ DBCluster: {} });
      await adapter.provision(config, creds);
      expect(CreateDBClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Engine: 'docdb' })
      );
    });

    it('generates identifier with citadel-docdb prefix when not provided', async () => {
      mockSend.mockResolvedValueOnce({ DBCluster: {} });
      await adapter.provision({}, creds);
      expect(CreateDBClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DBClusterIdentifier: expect.stringMatching(/^citadel-docdb-\d+$/),
        })
      );
    });

    it('throws ProvisioningError when credentials are missing', async () => {
      await expect(adapter.provision(config, {})).rejects.toThrow(ProvisioningError);
    });

    it('handles DBClusterAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      sdkError.name = 'DBClusterAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config, creds);
      expect(result.resourceArn).toContain('my-docdb-cluster');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      sdkError.name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config, creds)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      sdkError.name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config, creds);
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
    it('returns success with cluster status, endpoint, and port', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{
          Status: 'available',
          Endpoint: 'my-docdb.cluster-abc.us-east-1.docdb.amazonaws.com',
          Port: 27017,
        }],
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.status).toBe('available');
      expect(result.details?.endpoint).toBe('my-docdb.cluster-abc.us-east-1.docdb.amazonaws.com');
      expect(result.details?.port).toBe(27017);
    });

    it('does not include engine in details (unlike Aurora)', async () => {
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'available', Endpoint: 'ep', Port: 27017 }],
      });
      const result = await adapter.testConnection(config);
      expect(result.details).not.toHaveProperty('engine');
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
      expect(DocDBClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
