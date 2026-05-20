/**
 * TDD: RDS adapter should read masterUsername/masterPassword from config
 * when credentials don't contain them (wizard sends them in config).
 */
import { RDSClient, CreateDBInstanceCommand } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';

const rdsMock = mockClient(RDSClient);

import { RdsAdapter } from '../rds-adapter';

describe('RdsAdapter.provision - credential resolution', () => {
  const adapter = new RdsAdapter('postgres');

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBInstanceCommand).resolves({
      DBInstance: {
        DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:test-db',
        DBInstanceIdentifier: 'test-db',
      },
    });
  });

  test('reads masterUsername and masterPassword from config when credentials are undefined', async () => {
    const result = await adapter.provision({
      dbInstanceIdentifier: 'test-db',
      masterUsername: 'dbadmin',
      masterPassword: 'secret123',
    });

    expect(result.resourceArn).toContain('test-db');
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.MasterUsername).toBe('dbadmin');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('secret123');
  });

  test('reads masterUsername and masterPassword from config when credentials lack them', async () => {
    const result = await adapter.provision(
      {
        dbInstanceIdentifier: 'test-db',
        masterUsername: 'dbadmin',
        masterPassword: 'secret123',
      },
      { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
    );

    expect(result.resourceArn).toContain('test-db');
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('dbadmin');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('secret123');
  });

  test('prefers credentials over config for masterUsername/masterPassword', async () => {
    const result = await adapter.provision(
      {
        dbInstanceIdentifier: 'test-db',
        masterUsername: 'config-user',
        masterPassword: 'config-pass',
      },
      {
        accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST',
        masterUsername: 'cred-user',
        masterPassword: 'cred-pass',
      }
    );

    expect(result.resourceArn).toContain('test-db');
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('cred-user');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('cred-pass');
  });

  test('throws when neither config nor credentials have masterUsername', async () => {
    await expect(
      adapter.provision({ dbInstanceIdentifier: 'test-db' })
    ).rejects.toThrow(/masterUsername/);
  });
});
