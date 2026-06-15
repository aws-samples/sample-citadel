/**
 * TDD: Redshift adapter should read masterUsername/masterPassword from config
 * when credentials don't contain them (wizard sends them in config).
 */
import { RedshiftClient, CreateClusterCommand } from '@aws-sdk/client-redshift';
import { mockClient } from 'aws-sdk-client-mock';

const rsMock = mockClient(RedshiftClient);

import { RedshiftAdapter } from '../redshift-adapter';

describe('RedshiftAdapter.provision - credential resolution', () => {
  const adapter = new RedshiftAdapter();

  beforeEach(() => {
    rsMock.reset();
    rsMock.on(CreateClusterCommand).resolves({
      Cluster: { ClusterIdentifier: 'test-cluster' },
    });
  });

  test('reads masterUsername/masterPassword from config when credentials are undefined', async () => {
    const result = await adapter.provision({
      clusterIdentifier: 'test-cluster',
      masterUsername: 'admin',
      masterPassword: 'Secret123!',
    });

    expect(result.resourceArn).toBeDefined();
    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('admin');
    expect(calls[0].args[0].input.MasterUserPassword).toBe('Secret123!');
  });

  test('reads from config when credentials lack masterUsername', async () => {
    const result = await adapter.provision(
      { clusterIdentifier: 'test-cluster', masterUsername: 'admin', masterPassword: 'Secret123!' },
      { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }
    );

    expect(result.resourceArn).toBeDefined();
    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe('admin');
  });

  test('throws when neither config nor credentials have masterUsername', async () => {
    await expect(
      adapter.provision({ clusterIdentifier: 'test-cluster' })
    ).rejects.toThrow(/masterUsername/);
  });
});
