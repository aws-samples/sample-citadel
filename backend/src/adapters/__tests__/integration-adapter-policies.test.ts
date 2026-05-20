/**
 * TDD Tests for integration adapter requiredPolicies.
 *
 * Each integration adapter should return scoped policies
 * based on its connector type and configuration.
 */

import { UnifiedRegistry } from '../registry';

describe('Integration adapter requiredPolicies', () => {
  const registry = new UnifiedRegistry();
  const accountId = '123456789012';
  const region = 'us-west-2';

  describe('SaaS connectors (CONFLUENCE, JIRA, etc.)', () => {
    test('CONFLUENCE returns secret-read and SSM-read policies', () => {
      const adapter = registry.getAdapter('CONFLUENCE');
      const policies = adapter.requiredPolicies(
        {
          secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:conf-123',
          ssmParameterPrefix: '/citadel/integrations/org1/confluence-int-1',
        },
        accountId,
        region
      );

      expect(policies.connect.length).toBeGreaterThanOrEqual(1);
      const secretPolicy = policies.connect.find(p =>
        p.actions.includes('secretsmanager:GetSecretValue')
      );
      expect(secretPolicy).toBeDefined();
      expect(secretPolicy!.resources[0]).toContain('conf-123');
    });

    test('JIRA returns secret-read and SSM-read policies', () => {
      const adapter = registry.getAdapter('JIRA');
      const policies = adapter.requiredPolicies(
        {
          secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:jira-456',
          ssmParameterPrefix: '/citadel/integrations/org1/jira-int-2',
        },
        accountId,
        region
      );

      expect(policies.connect.length).toBeGreaterThanOrEqual(1);
      const ssmPolicy = policies.connect.find(p => p.actions.includes('ssm:GetParameter'));
      expect(ssmPolicy).toBeDefined();
    });
  });

  describe('AgentCore connectors (AWS_LAMBDA, AWS_SMITHY, MCP_SERVER)', () => {
    test('AWS_LAMBDA returns lambda:InvokeFunction and gateway policies', () => {
      const adapter = registry.getAdapter('AWS_LAMBDA');
      const policies = adapter.requiredPolicies(
        {
          secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lambda-sec',
          gatewayTargetId: 'target-abc',
          config: { lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:MyFunc' },
        },
        accountId,
        region
      );

      const lambdaPolicy = policies.connect.find(p =>
        p.actions.includes('lambda:InvokeFunction')
      );
      expect(lambdaPolicy).toBeDefined();
      expect(lambdaPolicy!.resources[0]).toContain('MyFunc');

      const gatewayPolicy = policies.connect.find(p =>
        p.actions.some(a => a.includes('bedrock-agentcore'))
      );
      expect(gatewayPolicy).toBeDefined();
    });

    test('MCP_SERVER returns gateway target policy', () => {
      const adapter = registry.getAdapter('MCP_SERVER');
      const policies = adapter.requiredPolicies(
        {
          secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:mcp-sec',
          gatewayTargetId: 'target-mcp',
        },
        accountId,
        region
      );

      const gatewayPolicy = policies.connect.find(p =>
        p.actions.some(a => a.includes('bedrock-agentcore'))
      );
      expect(gatewayPolicy).toBeDefined();
    });
  });

  describe('all integration adapters return provision: []', () => {
    const integrationTypes = [
      'CONFLUENCE', 'JIRA', 'SLACK', 'SERVICENOW', 'ZENDESK',
      'PAGERDUTY', 'MICROSOFT', 'GITHUB', 'SHAREPOINT', 'SALESFORCE',
      'AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER',
    ];

    test.each(integrationTypes)('%s has empty provision policies', (type) => {
      const adapter = registry.getAdapter(type);
      const policies = adapter.requiredPolicies({}, accountId, region);
      expect(policies.provision).toEqual([]);
    });
  });
});
