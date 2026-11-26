/**
 * TDD: Redshift CreateCluster requires resource '*' since the cluster
 * doesn't exist yet at provisioning time.
 */
import { RedshiftAdapter } from '../redshift-adapter';

describe('RedshiftAdapter.requiredPolicies - CreateCluster resource', () => {
  const adapter = new RedshiftAdapter();

  test('provision policies use wildcard resource for CreateCluster', () => {
    const policies = adapter.requiredPolicies(
      { clusterIdentifier: 'my-cluster' },
      '123456789012',
      'us-west-2'
    );
    const createPolicy = policies.provision.find((p) =>
      p.actions.includes('redshift:CreateCluster')
    );
    expect(createPolicy).toBeDefined();
    expect(createPolicy!.resources).toContain('*');
  });
});
