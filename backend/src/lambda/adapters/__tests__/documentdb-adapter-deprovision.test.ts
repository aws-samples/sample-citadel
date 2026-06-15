/**
 * TDD Tests for DocumentDBAdapter.deprovision
 */
import { DocDBClient, DeleteDBClusterCommand } from '@aws-sdk/client-docdb';
import { mockClient } from 'aws-sdk-client-mock';

const docdbMock = mockClient(DocDBClient);

import { DocumentDBAdapter } from '../documentdb-adapter';

describe('DocumentDBAdapter.deprovision', () => {
  const adapter = new DocumentDBAdapter();

  beforeEach(() => {
    docdbMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteDBClusterCommand with the cluster identifier', async () => {
    docdbMock.on(DeleteDBClusterCommand).resolves({});

    await adapter.deprovision!({ dbClusterIdentifier: 'my-docdb' });

    const calls = docdbMock.commandCalls(DeleteDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.DBClusterIdentifier).toBe('my-docdb');
    expect(calls[0].args[0].input.SkipFinalSnapshot).toBe(true);
  });

  test('succeeds gracefully if cluster already deleted', async () => {
    const notFoundError = new Error('Cluster not found');
    notFoundError.name = 'DBClusterNotFoundFault';
    docdbMock.on(DeleteDBClusterCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'gone-cluster' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    docdbMock.on(DeleteDBClusterCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'my-docdb' })
    ).rejects.toThrow('Internal failure');
  });
});
