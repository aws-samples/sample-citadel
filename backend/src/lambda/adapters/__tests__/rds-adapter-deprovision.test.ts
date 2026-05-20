/**
 * TDD Tests for RdsAdapter.deprovision
 *
 * When an RDS data store is deleted and was provisioned (CREATE_NEW mode),
 * the underlying RDS instance should be deleted.
 */
import { RDSClient, DeleteDBInstanceCommand } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';

const rdsMock = mockClient(RDSClient);

import { RdsAdapter } from '../rds-adapter';

describe('RdsAdapter.deprovision', () => {
  const adapter = new RdsAdapter('postgres');

  beforeEach(() => {
    rdsMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteDBInstanceCommand with the instance identifier', async () => {
    rdsMock.on(DeleteDBInstanceCommand).resolves({});

    await adapter.deprovision!({ dbInstanceIdentifier: 'my-rds-instance' });

    const calls = rdsMock.commandCalls(DeleteDBInstanceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.DBInstanceIdentifier).toBe('my-rds-instance');
    expect(calls[0].args[0].input.SkipFinalSnapshot).toBe(true);
  });

  test('succeeds gracefully if instance already deleted', async () => {
    const notFoundError = new Error('DB instance not found');
    notFoundError.name = 'DBInstanceNotFoundFault';
    rdsMock.on(DeleteDBInstanceCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ dbInstanceIdentifier: 'gone-instance' })
    ).resolves.toBeUndefined();
  });

  test('uses scoped credentials when provided', async () => {
    rdsMock.on(DeleteDBInstanceCommand).resolves({});

    await adapter.deprovision!(
      { dbInstanceIdentifier: 'my-rds-instance' },
      { accessKeyId: 'AKIA...', secretAccessKey: 'secret', sessionToken: 'token' }
    );

    const calls = rdsMock.commandCalls(DeleteDBInstanceCommand);
    expect(calls).toHaveLength(1);
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    rdsMock.on(DeleteDBInstanceCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ dbInstanceIdentifier: 'my-rds-instance' })
    ).rejects.toThrow('Internal failure');
  });
});
