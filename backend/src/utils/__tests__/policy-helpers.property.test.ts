// Feature: tool-integration-binding, Property 4: Agent Policies Include All Binding Scoped Roles
import * as fc from 'fast-check';
import { computeAgentPolicies, AgentPermissions } from '../policy-helpers';
import { PolicyManager } from '../policy-manager';

/**
 * Property 4: Agent Policies Include All Binding Scoped Roles
 *
 * For any AgentPermissions object containing `integrations` and `dataStores` arrays,
 * `computeAgentPolicies` should produce policy statements that include `sts:AssumeRole`
 * for every `citadel-int-{integrationId}` and `citadel-ds-{dataStoreId}` role,
 * with no missing or extra role ARNs.
 *
 * Validates: Requirements 2.2, 2.3, 2.4
 */

describe('Policy Helpers - Property-Based Tests', () => {
  const accountId = '123456789012';
  const region = 'us-west-2';

  // Generator for non-empty alphanumeric IDs (realistic resource IDs)
  const resourceIdArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,19}$/);

  describe('Property 4: Agent Policies Include All Binding Scoped Roles', () => {
    test('produces sts:AssumeRole for every integration and dataStore ID with no missing or extra ARNs', () => {
      fc.assert(
        fc.property(
          fc.array(resourceIdArb, { minLength: 0, maxLength: 10 }),
          fc.array(resourceIdArb, { minLength: 0, maxLength: 10 }),
          (integrationIds, dataStoreIds) => {
            const permissions: AgentPermissions = {
              integrations: integrationIds,
              dataStores: dataStoreIds,
            };

            const policies = computeAgentPolicies('test-agent', permissions, accountId, region);

            // Collect all sts:AssumeRole resource ARNs from the output
            const assumeRoleArns: string[] = [];
            for (const policy of policies) {
              if (policy.actions.includes('sts:AssumeRole')) {
                assumeRoleArns.push(...policy.resources);
              }
            }

            // Build expected ARNs for integrations
            const expectedIntegrationArns = integrationIds.map(
              (id) => `arn:aws:iam::${accountId}:role/${PolicyManager.getRoleName(id, 'integration')}`,
            );

            // Build expected ARNs for data stores
            const expectedDataStoreArns = dataStoreIds.map(
              (id) => `arn:aws:iam::${accountId}:role/${PolicyManager.getRoleName(id, 'datastore')}`,
            );

            const allExpectedArns = [...expectedIntegrationArns, ...expectedDataStoreArns];

            // Every expected ARN must be present (no missing)
            for (const expectedArn of allExpectedArns) {
              expect(assumeRoleArns).toContain(expectedArn);
            }

            // No extra ARNs beyond what's expected (no extra)
            expect(assumeRoleArns.sort()).toEqual(allExpectedArns.sort());
          },
        ),
        { numRuns: 100 },
      );
    });

    test('produces sts:AssumeRole for integrations only when dataStores is empty', () => {
      fc.assert(
        fc.property(
          fc.array(resourceIdArb, { minLength: 1, maxLength: 10 }),
          (integrationIds) => {
            const permissions: AgentPermissions = {
              integrations: integrationIds,
              dataStores: [],
            };

            const policies = computeAgentPolicies('test-agent', permissions, accountId, region);

            const assumeRoleArns: string[] = [];
            for (const policy of policies) {
              if (policy.actions.includes('sts:AssumeRole')) {
                assumeRoleArns.push(...policy.resources);
              }
            }

            // All ARNs should be integration roles only
            for (const arn of assumeRoleArns) {
              expect(arn).toContain('citadel-int-');
            }

            // Count must match
            expect(assumeRoleArns).toHaveLength(integrationIds.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('produces sts:AssumeRole for dataStores only when integrations is empty', () => {
      fc.assert(
        fc.property(
          fc.array(resourceIdArb, { minLength: 1, maxLength: 10 }),
          (dataStoreIds) => {
            const permissions: AgentPermissions = {
              integrations: [],
              dataStores: dataStoreIds,
            };

            const policies = computeAgentPolicies('test-agent', permissions, accountId, region);

            const assumeRoleArns: string[] = [];
            for (const policy of policies) {
              if (policy.actions.includes('sts:AssumeRole')) {
                assumeRoleArns.push(...policy.resources);
              }
            }

            // All ARNs should be datastore roles only
            for (const arn of assumeRoleArns) {
              expect(arn).toContain('citadel-ds-');
            }

            // Count must match
            expect(assumeRoleArns).toHaveLength(dataStoreIds.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('combines both integration and dataStore roles in a single policy set', () => {
      fc.assert(
        fc.property(
          fc.array(resourceIdArb, { minLength: 1, maxLength: 5 }),
          fc.array(resourceIdArb, { minLength: 1, maxLength: 5 }),
          (integrationIds, dataStoreIds) => {
            const permissions: AgentPermissions = {
              integrations: integrationIds,
              dataStores: dataStoreIds,
            };

            const policies = computeAgentPolicies('test-agent', permissions, accountId, region);

            // Collect all sts:AssumeRole resource ARNs
            const assumeRoleArns: string[] = [];
            for (const policy of policies) {
              if (policy.actions.includes('sts:AssumeRole')) {
                assumeRoleArns.push(...policy.resources);
              }
            }

            // Must have both integration and datastore ARNs
            const integrationArns = assumeRoleArns.filter((arn) => arn.includes('citadel-int-'));
            const dataStoreArns = assumeRoleArns.filter((arn) => arn.includes('citadel-ds-'));

            expect(integrationArns).toHaveLength(integrationIds.length);
            expect(dataStoreArns).toHaveLength(dataStoreIds.length);

            // Total must be the sum
            expect(assumeRoleArns).toHaveLength(integrationIds.length + dataStoreIds.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('produces no sts:AssumeRole statements when both arrays are empty', () => {
      const permissions: AgentPermissions = {
        integrations: [],
        dataStores: [],
      };

      const policies = computeAgentPolicies('test-agent', permissions, accountId, region);

      const assumeRolePolicies = policies.filter((p) => p.actions.includes('sts:AssumeRole'));
      expect(assumeRolePolicies).toHaveLength(0);
    });
  });
});
