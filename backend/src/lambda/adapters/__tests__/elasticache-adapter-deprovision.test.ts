/**
 * TDD Tests for ElastiCacheAdapter.deprovision
 */
import { ElastiCacheClient, DeleteCacheClusterCommand } from '@aws-sdk/client-elasticache';
import { mockClient } from 'aws-sdk-client-mock';

const elasticacheMock = mockClient(ElastiCacheClient);

import { ElastiCacheAdapter } from '../elasticache-adapter';

describe('ElastiCacheAdapter.deprovision', () => {
  const adapter = new ElastiCacheAdapter();

  beforeEach(() => {
    elasticacheMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteCacheClusterCommand with the cluster id', async () => {
    elasticacheMock.on(DeleteCacheClusterCommand).resolves({});

    await adapter.deprovision!({ cacheClusterId: 'my-redis' });

    const calls = elasticacheMock.commandCalls(DeleteCacheClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.CacheClusterId).toBe('my-redis');
  });

  test('succeeds gracefully if cluster already deleted', async () => {
    const notFoundError = new Error('Cluster not found');
    notFoundError.name = 'CacheClusterNotFoundFault';
    elasticacheMock.on(DeleteCacheClusterCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ cacheClusterId: 'gone-cluster' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    elasticacheMock.on(DeleteCacheClusterCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ cacheClusterId: 'my-redis' })
    ).rejects.toThrow('Internal failure');
  });
});
