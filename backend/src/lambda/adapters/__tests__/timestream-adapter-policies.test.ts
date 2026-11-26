/**
 * TDD: Timestream adapter requiredPolicies must include DescribeEndpoints
 * (needed for SDK endpoint discovery) and use wildcard resource for
 * CreateDatabase (database doesn't exist yet).
 */
import { TimestreamAdapter } from '../timestream-adapter';

describe('TimestreamAdapter.requiredPolicies', () => {
  const adapter = new TimestreamAdapter();

  test('provision policies include timestream:DescribeEndpoints', () => {
    const policies = adapter.requiredPolicies({ databaseName: 'mydb' }, '123456789012', 'us-west-2');
    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain('timestream:DescribeEndpoints');
  });

  test('provision policies use wildcard resource for CreateDatabase', () => {
    const policies = adapter.requiredPolicies({ databaseName: 'mydb' }, '123456789012', 'us-west-2');
    const createPolicy = policies.provision.find((p) =>
      p.actions.includes('timestream:CreateDatabase')
    );
    expect(createPolicy).toBeDefined();
    expect(createPolicy!.resources).toContain('*');
  });
});
