/**
 * TDD: Aurora adapter should read masterUsername/masterPassword from config
 * when credentials don't contain them (wizard sends them in config).
 */
import { RDSClient, CreateDBClusterCommand } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';

const rdsMock = mockClient(RDSClient);

import { AuroraAdapter } from '../aurora-adapter';

describe('AuroraAdapter.provision - credential resolution', () => {
  const adapter = new AuroraAdapter('postgres');

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBClusterCommand).resolves({
      DBCluster: {
        DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:test-cluster',
        DBClusterIdentifier: 'test-cluster',
      },
    });
  });

  test('reads masterUsername and masterPassword from config when credentials are undefined', async () => {
    const result = await adapter.provision({
      dbClusterIdentifier: 'test-cluster',
      masterUsername: 'dbadmin',
      masterPassword: 'secret123',
    });

    expect(result.resourceArn).toContain('test-cluster');
    const calls = rdsMock.commandCalls(CreateDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.MasterUsername).toBe('dbadmin');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('secret123');
  });

  test('reads masterUsername and masterPassword from config when credentials lack them', async () => {
    const result = await adapter.provision(
      {
        dbClusterIdentifier: 'test-cluster',
        masterUsername: 'dbadmin',
        masterPassword: 'secret123',
      },
      { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
    );

    expect(result.resourceArn).toContain('test-cluster');
    const calls = rdsMock.commandCalls(CreateDBClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('dbadmin');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('secret123');
  });

  test('prefers credentials over config for masterUsername/masterPassword', async () => {
    const result = await adapter.provision(
      {
        dbClusterIdentifier: 'test-cluster',
        masterUsername: 'config-user',
        masterPassword: 'config-pass',
      },
      {
        accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST',
        masterUsername: 'cred-user',
        masterPassword: 'cred-pass',
      }
    );

    expect(result.resourceArn).toContain('test-cluster');
    const calls = rdsMock.commandCalls(CreateDBClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('cred-user');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('cred-pass');
  });

  test('throws when neither config nor credentials have masterUsername', async () => {
    await expect(
      adapter.provision({ dbClusterIdentifier: 'test-cluster' })
    ).rejects.toThrow(/masterUsername/);
  });
});
