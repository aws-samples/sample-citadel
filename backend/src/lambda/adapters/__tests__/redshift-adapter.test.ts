import { RedshiftAdapter } from '../redshift-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-redshift', () => {
  return {
    RedshiftClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateClusterCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateCluster', input })),
    DescribeClustersCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeClusters', input })),
  };
});

describe('RedshiftAdapter', () => {
  let adapter: RedshiftAdapter;
  const config = { clusterIdentifier: 'my-test-cluster' };
  const creds = { masterUsername: 'admin', masterPassword: 'Secret123' };

  beforeEach(() => {
    adapter = new RedshiftAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateCluster and DescribeClusters', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision.length).toBeGreaterThanOrEqual(1);
      const redshiftActions = policies.provision[0].actions;
      expect(redshiftActions).toContain('redshift:CreateCluster');
      expect(redshiftActions).toContain('redshift:DescribeClusters');
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for DescribeClusters', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual(['redshift:DescribeClusters']);
    });

    it('uses wildcard resource for provision', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual(['*']);
    });
  });

  describe('provision', () => {
    it('creates a cluster and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        Cluster: { ClusterNamespaceArn: 'arn:aws:redshift:us-east-1:123:cluster:my-test-cluster' },
      });
      const result = await adapter.provision(config, creds);
      expect(result.resourceArn).toBe('arn:aws:redshift:us-east-1:123:cluster:my-test-cluster');
    });

    it('sends CreateClusterCommand with ra3.xlplus node type', async () => {
      const { CreateClusterCommand } = require('@aws-sdk/client-redshift');
      mockSend.mockResolvedValueOnce({ Cluster: {} });
      await adapter.provision(config, creds);
      expect(CreateClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ClusterIdentifier: 'my-test-cluster',
          NodeType: 'ra3.xlplus',
          MasterUsername: 'admin',
          MasterUserPassword: 'Secret123',
        })
      );
    });

    it('throws ProvisioningError when credentials are missing', async () => {
      await expect(adapter.provision(config, {})).rejects.toThrow(ProvisioningError);
    });

    it('handles ClusterAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'ClusterAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config, creds);
      expect(result.resourceArn).toContain('my-test-cluster');
    });

    it('wraps AccessDeniedException in PermissionError', async () => {
      const sdkError = new Error('Access Denied');
      (sdkError as any).name = 'AccessDeniedException';
      mockSend.mockRejectedValueOnce(sdkError);
      await expect(adapter.provision(config, creds)).rejects.toThrow(PermissionError);
    });

    it('wraps unknown SDK errors in ProvisioningError with cause', async () => {
      const sdkError = new Error('Something broke');
      (sdkError as any).name = 'InternalError';
      mockSend.mockRejectedValueOnce(sdkError);
      try {
        await adapter.provision(config, creds);
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
        Clusters: [{ ClusterStatus: 'available' }],
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when cluster is not available', async () => {
      mockSend.mockResolvedValueOnce({
        Clusters: [{ ClusterStatus: 'creating' }],
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when cluster does not exist', async () => {
      const sdkError = new Error('Not found');
      (sdkError as any).name = 'ClusterNotFoundFault';
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
  });

  describe('disconnect', () => {
    it('is a no-op', async () => {
      await expect(adapter.disconnect(config)).resolves.toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('returns success with cluster details', async () => {
      mockSend.mockResolvedValueOnce({
        Clusters: [{
          ClusterStatus: 'available',
          Endpoint: { Address: 'my-cluster.abc.us-east-1.redshift.amazonaws.com', Port: 5439 },
          NumberOfNodes: 2,
        }],
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.endpoint).toBe('my-cluster.abc.us-east-1.redshift.amazonaws.com');
      expect(result.details?.port).toBe(5439);
      expect(result.details?.numberOfNodes).toBe(2);
    });

    it('returns failure when DescribeClusters fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns number of nodes and estimated storage', async () => {
      mockSend.mockResolvedValueOnce({
        Clusters: [{ NumberOfNodes: 3 }],
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('480 GB');
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
      const { RedshiftClient } = require('@aws-sdk/client-redshift');
      mockSend.mockResolvedValueOnce({
        Clusters: [{ ClusterStatus: 'available' }],
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(RedshiftClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
