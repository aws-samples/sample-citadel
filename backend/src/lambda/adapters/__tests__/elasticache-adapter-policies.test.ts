/**
 * TDD: ElastiCache adapter requiredPolicies must include
 * iam:CreateServiceLinkedRole for the ElastiCache service-linked role.
 */
import { ElastiCacheAdapter } from '../elasticache-adapter';

describe('ElastiCacheAdapter.requiredPolicies', () => {
  const adapter = new ElastiCacheAdapter();

  test('provision policies include iam:CreateServiceLinkedRole', () => {
    const policies = adapter.requiredPolicies({ cacheClusterId: 'test' }, '123456789012', 'us-west-2');
    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain('iam:CreateServiceLinkedRole');
  });
});
