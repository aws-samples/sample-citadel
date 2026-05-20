import { ElastiCacheAdapter } from '../elasticache-adapter';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from '../errors';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-elasticache', () => {
  return {
    ElastiCacheClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
    CreateCacheClusterCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateCacheCluster', input })),
    DescribeCacheClustersCommand: jest.fn().mockImplementation((input) => ({ _type: 'DescribeCacheClusters', input })),
  };
});

describe('ElastiCacheAdapter', () => {
  let adapter: ElastiCacheAdapter;
  const config = { cacheClusterId: 'my-test-cluster' };

  beforeEach(() => {
    adapter = new ElastiCacheAdapter();
    mockSend.mockReset();
  });

  describe('requiredPolicies', () => {
    it('returns provision policies for CreateCacheCluster and DescribeCacheClusters', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.provision.length).toBeGreaterThanOrEqual(1);
      expect(policies.provision[0].actions).toContain('elasticache:CreateCacheCluster');
      expect(policies.provision[0].resources).toEqual(['*']);
    });

    it('returns connect policies for DescribeCacheClusters', () => {
      const policies = adapter.requiredPolicies(config, '123456789012', 'us-east-1');
      expect(policies.connect).toHaveLength(1);
      expect(policies.connect[0].actions).toEqual(['elasticache:DescribeCacheClusters']);
    });

    it('uses wildcard resource for provision', () => {
      const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
      expect(policies.provision[0].resources).toEqual(['*']);
    });
  });

  describe('provision', () => {
    it('creates a cluster and returns the ARN', async () => {
      mockSend.mockResolvedValueOnce({
        CacheCluster: { ARN: 'arn:aws:elasticache:us-east-1:123:cluster:my-test-cluster' },
      });
      const result = await adapter.provision(config);
      expect(result.resourceArn).toBe('arn:aws:elasticache:us-east-1:123:cluster:my-test-cluster');
    });

    it('sends CreateCacheClusterCommand with redis engine and cache.t3.micro', async () => {
      const { CreateCacheClusterCommand } = require('@aws-sdk/client-elasticache');
      mockSend.mockResolvedValueOnce({ CacheCluster: {} });
      await adapter.provision(config);
      expect(CreateCacheClusterCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          CacheClusterId: 'my-test-cluster',
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 1,
        })
      );
    });

    it('handles CacheClusterAlreadyExistsFault as idempotent success', async () => {
      const sdkError = new Error('Already exists');
      (sdkError as any).name = 'CacheClusterAlreadyExistsFault';
      mockSend.mockRejectedValueOnce(sdkError);
      const result = await adapter.provision(config);
      expect(result.resourceArn).toContain('my-test-cluster');
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
  });

  describe('connect', () => {
    it('succeeds when cluster status is available', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [{ CacheClusterStatus: 'available' }],
      });
      await expect(adapter.connect(config)).resolves.toBeUndefined();
    });

    it('throws ConnectionError when cluster is not available', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [{ CacheClusterStatus: 'creating' }],
      });
      await expect(adapter.connect(config)).rejects.toThrow(ConnectionError);
    });

    it('throws ResourceNotFoundError when cluster does not exist', async () => {
      const sdkError = new Error('Not found');
      (sdkError as any).name = 'CacheClusterNotFoundFault';
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
        CacheClusters: [{
          CacheClusterStatus: 'available',
          ConfigurationEndpoint: { Address: 'my-cluster.abc.cache.amazonaws.com', Port: 6379 },
          EngineVersion: '7.0.7',
        }],
      });
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(true);
      expect(result.details?.endpoint).toBe('my-cluster.abc.cache.amazonaws.com');
      expect(result.details?.port).toBe(6379);
      expect(result.details?.engineVersion).toBe('7.0.7');
    });

    it('returns failure when DescribeCacheClusters fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Not Found'));
      const result = await adapter.testConnection(config);
      expect(result.success).toBe(false);
    });
  });

  describe('getMetrics', () => {
    it('returns number of cache nodes', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [{ NumCacheNodes: 3 }],
      });
      const result = await adapter.getMetrics(config);
      expect(result.size).toBe('3 node(s)');
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
      const { ElastiCacheClient } = require('@aws-sdk/client-elasticache');
      mockSend.mockResolvedValueOnce({
        CacheClusters: [{ CacheClusterStatus: 'available' }],
      });
      await adapter.connect(config, {
        accessKeyId: 'AKIA...',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      });
      expect(ElastiCacheClient).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
          sessionToken: 'token',
        },
      });
    });
  });
});
