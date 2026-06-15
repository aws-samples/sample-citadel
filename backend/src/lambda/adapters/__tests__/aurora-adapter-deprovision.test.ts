/**
 * TDD Tests for AuroraAdapter.deprovision
 *
 * When an Aurora data store is deleted and was provisioned (CREATE_NEW mode),
 * the underlying Aurora cluster should be deleted.
 */
import { RDSClient, DeleteDBClusterCommand } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';

const rdsMock = mockClient(RDSClient);

import { AuroraAdapter } from '../aurora-adapter';

describe('AuroraAdapter.deprovision', () => {
  const adapter = new AuroraAdapter('postgres');

  beforeEach(() => {
    rdsMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteDBClusterCommand with the cluster identifier', async () => {
    rdsMock.on(DeleteDBClusterCommand).resolves({});

    await adapter.deprovision!({ dbClusterIdentifier: 'my-aurora-cluster' });

    const calls = rdsMock.commandCalls(DeleteDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.DBClusterIdentifier).toBe('my-aurora-cluster');
    expect(calls[0].args[0].input.SkipFinalSnapshot).toBe(true);
  });

  test('succeeds gracefully if cluster already deleted', async () => {
    const notFoundError = new Error('DB cluster not found');
    notFoundError.name = 'DBClusterNotFoundFault';
    rdsMock.on(DeleteDBClusterCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'gone-cluster' })
    ).resolves.toBeUndefined();
  });

  test('uses scoped credentials when provided', async () => {
    rdsMock.on(DeleteDBClusterCommand).resolves({});

    await adapter.deprovision!(
      { dbClusterIdentifier: 'my-aurora-cluster' },
      { accessKeyId: 'AKIA...', secretAccessKey: 'secret', sessionToken: 'token' }
    );

    const calls = rdsMock.commandCalls(DeleteDBClusterCommand);
    expect(calls).toHaveLength(1);
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    rdsMock.on(DeleteDBClusterCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ dbClusterIdentifier: 'my-aurora-cluster' })
    ).rejects.toThrow('Internal failure');
  });
});
