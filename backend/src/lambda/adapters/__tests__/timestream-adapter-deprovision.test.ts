/**
 * TDD Tests for TimestreamAdapter.deprovision
 */
import { TimestreamWriteClient, DeleteDatabaseCommand } from '@aws-sdk/client-timestream-write';
import { mockClient } from 'aws-sdk-client-mock';

const timestreamMock = mockClient(TimestreamWriteClient);

import { TimestreamAdapter } from '../timestream-adapter';

describe('TimestreamAdapter.deprovision', () => {
  const adapter = new TimestreamAdapter();

  beforeEach(() => {
    timestreamMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteDatabaseCommand with the database name', async () => {
    timestreamMock.on(DeleteDatabaseCommand).resolves({});

    await adapter.deprovision!({ databaseName: 'my-timestream-db' });

    const calls = timestreamMock.commandCalls(DeleteDatabaseCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.DatabaseName).toBe('my-timestream-db');
  });

  test('succeeds gracefully if database already deleted', async () => {
    const notFoundError = new Error('Database not found');
    notFoundError.name = 'ResourceNotFoundException';
    timestreamMock.on(DeleteDatabaseCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ databaseName: 'gone-db' })
    ).resolves.toBeUndefined();
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    timestreamMock.on(DeleteDatabaseCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ databaseName: 'my-timestream-db' })
    ).rejects.toThrow('Internal failure');
  });
});
