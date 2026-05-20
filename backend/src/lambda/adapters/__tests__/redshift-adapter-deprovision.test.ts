/**
 * TDD Tests for RedshiftAdapter.deprovision
 */
import { RedshiftClient, DeleteClusterCommand } from '@aws-sdk/client-redshift';
import { mockClient } from 'aws-sdk-client-mock';

const redshiftMock = mockClient(RedshiftClient);

import { RedshiftAdapter } from '../redshift-adapter';

describe('RedshiftAdapter.deprovision', () => {
  const adapter = new RedshiftAdapter();

  beforeEach(() => {
    redshiftMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteClusterCommand with the cluster identifier', async () => {
    redshiftMock.on(DeleteClusterCommand).resolves({});

    await adapter.deprovision!({ clusterIdentifier: 'my-redshift' });

    const calls = redshiftMock.commandCalls(DeleteClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ClusterIdentifier).toBe('my-redshift');
    expect(calls[0].args[0].input.SkipFinalClusterSnapshot).toBe(true);
  });

  test('succeeds gracefully if cluster already deleted', async () => {
    const notFoundError = new Error('Cluster not found');
    notFoundError.name = 'ClusterNotFoundFault';
    redshiftMock.on(DeleteClusterCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ clusterIdentifier: 'gone-cluster' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    redshiftMock.on(DeleteClusterCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ clusterIdentifier: 'my-redshift' })
    ).rejects.toThrow('Internal failure');
  });
});
