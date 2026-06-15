/**
 * TDD: RDS PostgreSQL adapter should reject reserved usernames like 'admin'
 * before calling the AWS API, providing a clear error message.
 */
import { RDSClient, CreateDBInstanceCommand } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';

const rdsMock = mockClient(RDSClient);

import { RdsAdapter } from '../rds-adapter';

describe('RdsAdapter.provision - PostgreSQL reserved username validation', () => {
  const adapter = new RdsAdapter('postgres');

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:test' },
    });
  });

  test('rejects "admin" as masterUsername for postgres engine', async () => {
    await expect(
      adapter.provision({ masterUsername: 'admin', masterPassword: 'pass123' })
    ).rejects.toThrow(/reserved/i);
  });

  test('allows "dbadmin" as masterUsername for postgres engine', async () => {
    const result = await adapter.provision({
      masterUsername: 'dbadmin',
      masterPassword: 'pass123',
    });
    expect(result.resourceArn).toBeDefined();
  });
});

describe('RdsAdapter.provision - MySQL allows admin username', () => {
  const adapter = new RdsAdapter('mysql');

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:test' },
    });
  });

  test('allows "admin" as masterUsername for mysql engine', async () => {
    const result = await adapter.provision({
      masterUsername: 'admin',
      masterPassword: 'pass123',
    });
    expect(result.resourceArn).toBeDefined();
  });
});
