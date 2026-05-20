/**
 * TDD Tests for OpenSearchAdapter.deprovision
 */
import { OpenSearchServerlessClient, DeleteCollectionCommand } from '@aws-sdk/client-opensearchserverless';
import { mockClient } from 'aws-sdk-client-mock';

const ossMock = mockClient(OpenSearchServerlessClient);

import { OpenSearchAdapter } from '../opensearch-adapter';

describe('OpenSearchAdapter.deprovision', () => {
  const adapter = new OpenSearchAdapter();

  beforeEach(() => {
    ossMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteCollectionCommand with the collection id', async () => {
    ossMock.on(DeleteCollectionCommand).resolves({});

    await adapter.deprovision!({ collectionId: 'col-123' });

    const calls = ossMock.commandCalls(DeleteCollectionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.id).toBe('col-123');
  });

  test('succeeds gracefully if collection already deleted', async () => {
    const notFoundError = new Error('Not found');
    notFoundError.name = 'ResourceNotFoundException';
    ossMock.on(DeleteCollectionCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ collectionId: 'gone-col' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    ossMock.on(DeleteCollectionCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ collectionId: 'col-123' })
    ).rejects.toThrow('Internal failure');
  });
});
