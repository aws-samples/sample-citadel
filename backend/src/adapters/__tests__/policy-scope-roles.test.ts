/**
 * TDD Tests verifying PolicyManager role name patterns
 * match what the CDK stacks need to grant.
 *
 * These tests ensure the role naming convention is consistent
 * across all scopes so CDK IAM resource patterns work correctly.
 */

import { PolicyManager } from '../../utils/policy-manager';

describe('PolicyManager role naming for CDK IAM grants', () => {
  test('datastore roles match pattern citadel-ds-*', () => {
    const name = PolicyManager.getRoleName('any-id', 'datastore');
    expect(name).toMatch(/^citadel-ds-/);
  });

  test('integration roles match pattern citadel-int-*', () => {
    const name = PolicyManager.getRoleName('any-id', 'integration');
    expect(name).toMatch(/^citadel-int-/);
  });

  test('agent roles match pattern citadel-agent-*', () => {
    const name = PolicyManager.getRoleName('any-id', 'agent');
    expect(name).toMatch(/^citadel-agent-/);
  });

  test('all scopes produce distinct prefixes', () => {
    const ds = PolicyManager.getRoleName('x', 'datastore');
    const int = PolicyManager.getRoleName('x', 'integration');
    const agent = PolicyManager.getRoleName('x', 'agent');
    const prefixes = new Set([ds.split('x')[0], int.split('x')[0], agent.split('x')[0]]);
    expect(prefixes.size).toBe(3);
  });
});
