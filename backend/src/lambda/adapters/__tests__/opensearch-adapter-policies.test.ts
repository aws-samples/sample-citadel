/**
 * TDD: OpenSearch adapter requiredPolicies must include aoss:CreateSecurityPolicy
 * and aoss:CreateAccessPolicy so the scoped IAM role can create security policies.
 */
import { OpenSearchAdapter } from '../opensearch-adapter';

describe('OpenSearchAdapter.requiredPolicies - includes security policy actions', () => {
  const adapter = new OpenSearchAdapter();

  test('provision policies include aoss:CreateSecurityPolicy with wildcard resource', () => {
    const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
    const secPolicyStatement = policies.provision.find((p) =>
      p.actions.includes('aoss:CreateSecurityPolicy')
    );
    expect(secPolicyStatement).toBeDefined();
    expect(secPolicyStatement!.resources).toEqual(['*']);
  });

  test('provision policies include aoss:CreateAccessPolicy with wildcard resource', () => {
    const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
    const secPolicyStatement = policies.provision.find((p) =>
      p.actions.includes('aoss:CreateAccessPolicy')
    );
    expect(secPolicyStatement).toBeDefined();
    expect(secPolicyStatement!.resources).toEqual(['*']);
  });

  test('provision policies still include aoss:CreateCollection', () => {
    const policies = adapter.requiredPolicies({}, '123456789012', 'us-west-2');
    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain('aoss:CreateCollection');
  });
});
