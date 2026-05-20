/**
 * TDD Tests for KeyspacesAdapter.deprovision
 */
import { KeyspacesClient, DeleteKeyspaceCommand } from '@aws-sdk/client-keyspaces';
import { mockClient } from 'aws-sdk-client-mock';

const keyspacesMock = mockClient(KeyspacesClient);

import { KeyspacesAdapter } from '../keyspaces-adapter';

describe('KeyspacesAdapter.deprovision', () => {
  const adapter = new KeyspacesAdapter();

  beforeEach(() => {
    keyspacesMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteKeyspaceCommand with the keyspace name', async () => {
    keyspacesMock.on(DeleteKeyspaceCommand).resolves({});

    await adapter.deprovision!({ keyspaceName: 'my-keyspace' });

    const calls = keyspacesMock.commandCalls(DeleteKeyspaceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.keyspaceName).toBe('my-keyspace');
  });

  test('succeeds gracefully if keyspace already deleted', async () => {
    const notFoundError = new Error('Not found');
    notFoundError.name = 'ResourceNotFoundException';
    keyspacesMock.on(DeleteKeyspaceCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ keyspaceName: 'gone-keyspace' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    keyspacesMock.on(DeleteKeyspaceCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ keyspaceName: 'my-keyspace' })
    ).rejects.toThrow('Internal failure');
  });
});
