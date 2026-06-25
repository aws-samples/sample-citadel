/**
 * TDD Tests for PolicyManager in its promoted utils location.
 * Verifies it's importable from utils/ and that the new
 * computeAgentPolicies and computeIntegrationPolicies helpers work.
 */

import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';

// Import from the NEW promoted location
import { PolicyManager } from '../policy-manager';
import { computeIntegrationPolicies } from '../policy-helpers';
import { computeAgentPolicies } from '../policy-helpers';

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

describe('PolicyManager (promoted to utils)', () => {
  let manager: PolicyManager;

  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: '123456789012',
      Arn: 'arn:aws:sts::123456789012:assumed-role/LambdaRole/session',
    });
    manager = new PolicyManager();
  });

  test('is importable from utils/policy-manager', () => {
    expect(PolicyManager).toBeDefined();
    expect(typeof PolicyManager).toBe('function');
  });

  test('getRoleName works for all scopes', () => {
    expect(PolicyManager.getRoleName('abc', 'datastore')).toBe('citadel-ds-abc');
    expect(PolicyManager.getRoleName('abc', 'integration')).toBe('citadel-int-abc');
    expect(PolicyManager.getRoleName('abc', 'agent')).toBe('citadel-agent-abc');
  });

  test('ensureRole creates role with agent scope', async () => {
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});

    await manager.ensureRole(
      'agent-1',
      [{ actions: ['bedrock:InvokeModel'], resources: ['*'] }],
      '123456789012',
      'agent'
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0].input.RoleName).toBe('citadel-agent-agent-1');
  });
});

describe('computeIntegrationPolicies', () => {
  const accountId = '123456789012';
  const region = 'us-west-2';

  test('returns secret-read policy scoped to the integration secret ARN', () => {
    const policies = computeIntegrationPolicies(
      'int-abc',
      'CONFLUENCE',
      { secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:/citadel/integrations/org1/confluence-int-abc' },
      accountId,
      region
    );

    expect(policies.length).toBeGreaterThanOrEqual(1);
    const secretPolicy = policies.find(p => p.actions.includes('secretsmanager:GetSecretValue'));
    expect(secretPolicy).toBeDefined();
    expect(secretPolicy!.resources[0]).toContain('int-abc');
  });

  test('returns gateway target policy for AgentCore types', () => {
    const policies = computeIntegrationPolicies(
      'int-lambda',
      'AWS_LAMBDA',
      {
        secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',
        gatewayTargetId: 'target-123',
      },
      accountId,
      region
    );

    const gatewayPolicy = policies.find(p =>
      p.actions.some(a => a.includes('bedrock-agentcore'))
    );
    expect(gatewayPolicy).toBeDefined();
  });

  test('returns lambda:InvokeFunction for AWS_LAMBDA type with lambdaArn', () => {
    const policies = computeIntegrationPolicies(
      'int-lambda',
      'AWS_LAMBDA',
      {
        secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',
        config: { lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:MyFunc' },
      },
      accountId,
      region
    );

    const lambdaPolicy = policies.find(p => p.actions.includes('lambda:InvokeFunction'));
    expect(lambdaPolicy).toBeDefined();
    expect(lambdaPolicy!.resources[0]).toContain('MyFunc');
  });

  test('returns empty array for unknown types', () => {
    const policies = computeIntegrationPolicies('x', 'UNKNOWN_TYPE', {}, accountId, region);
    expect(policies).toEqual([]);
  });

  test('returns SSM read policy scoped to the integration prefix', () => {
    const policies = computeIntegrationPolicies(
      'int-jira',
      'JIRA',
      {
        secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',
        ssmParameterPrefix: '/citadel/integrations/org1/jira-int-jira',
      },
      accountId,
      region
    );

    const ssmPolicy = policies.find(p => p.actions.includes('ssm:GetParameter'));
    expect(ssmPolicy).toBeDefined();
    expect(ssmPolicy!.resources[0]).toContain('jira-int-jira');
  });
});

describe('computeAgentPolicies', () => {
  const accountId = '123456789012';
  const region = 'us-west-2';

  test('returns bedrock:InvokeModel scoped to declared models', () => {
    const policies = computeAgentPolicies(
      'agent-1',
      {
        models: ['anthropic.claude-sonnet-4-20250514'],
      },
      accountId,
      region
    );

    const bedrockPolicy = policies.find(p => p.actions.includes('bedrock:InvokeModel'));
    expect(bedrockPolicy).toBeDefined();
    expect(bedrockPolicy!.resources).toHaveLength(1);
    expect(bedrockPolicy!.resources[0]).toContain('anthropic.claude-sonnet-4-20250514');
  });

  test('returns multiple model ARNs when multiple models declared', () => {
    const policies = computeAgentPolicies(
      'agent-2',
      {
        models: ['anthropic.claude-sonnet-4-20250514', 'amazon.titan-text-express-v1'],
      },
      accountId,
      region
    );

    const bedrockPolicy = policies.find(p => p.actions.includes('bedrock:InvokeModel'));
    expect(bedrockPolicy).toBeDefined();
    expect(bedrockPolicy!.resources).toHaveLength(2);
  });

  test('returns empty array when no permissions declared', () => {
    const policies = computeAgentPolicies('agent-3', {}, accountId, region);
    expect(policies).toEqual([]);
  });

  test('returns datastore access policies when dataStores declared', () => {
    const policies = computeAgentPolicies(
      'agent-4',
      {
        dataStores: ['ds-abc'],
      },
      accountId,
      region
    );

    const stsPolicy = policies.find(p => p.actions.includes('sts:AssumeRole'));
    expect(stsPolicy).toBeDefined();
    expect(stsPolicy!.resources[0]).toContain('citadel-ds-ds-abc');
  });

  test('returns integration access policies when integrations declared', () => {
    const policies = computeAgentPolicies(
      'agent-5',
      {
        integrations: ['int-xyz'],
      },
      accountId,
      region
    );

    const stsPolicy = policies.find(p => p.actions.includes('sts:AssumeRole'));
    expect(stsPolicy).toBeDefined();
    expect(stsPolicy!.resources[0]).toContain('citadel-int-int-xyz');
  });

  test('combines model, datastore, and integration policies', () => {
    const policies = computeAgentPolicies(
      'agent-6',
      {
        models: ['anthropic.claude-sonnet-4-20250514'],
        dataStores: ['ds-1'],
        integrations: ['int-1'],
      },
      accountId,
      region
    );

    expect(policies.length).toBe(3);
    expect(policies.find(p => p.actions.includes('bedrock:InvokeModel'))).toBeDefined();
    expect(policies.filter(p => p.actions.includes('sts:AssumeRole'))).toHaveLength(2);
  });
});
