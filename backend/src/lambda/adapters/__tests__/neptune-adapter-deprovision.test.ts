/**
 * TDD Tests for NeptuneAdapter.deprovision
 */
import { NeptuneClient, DeleteDBClusterCommand } from '@aws-sdk/client-neptune';
import { mockClient } from 'aws-sdk-client-mock';

const neptuneMock = mockClient(NeptuneClient);

import { NeptuneAdapter } from '../neptune-adapter';

describe('NeptuneAdapter.deprovision', () => {
  const adapter = new NeptuneAdapter();

  beforeEach(() => {
    neptuneMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteDBClusterCommand with the cluster identifier', async () => {
    neptuneMock.on(DeleteDBClusterCommand).resolves({});

    await adapter.deprovision!({ dbClusterIdentifier: 'my-neptune' });

    const calls = neptuneMock.commandCalls(DeleteDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.DBClusterIdentifier).toBe('my-neptune');
    expect(calls[0].args[0].input.SkipFinalSnapshot).toBe(true);
  });

  test('succeeds gracefully if cluster already deleted', async () => {
    const notFoundError = new Error('Cluster not found');
    notFoundError.name = 'DBClusterNotFoundFault';
    neptuneMock.on(DeleteDBClusterCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'gone-cluster' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    neptuneMock.on(DeleteDBClusterCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'my-neptune' })
    ).rejects.toThrow('Internal failure');
  });
});
