/**
 * Policy Helpers
 *
 * Computes dynamic PolicyStatement arrays for integrations and agents.
 * Used with PolicyManager to vend scoped IAM roles at runtime.
 */

import { PolicyStatement } from '../adapters/base';
import { PolicyManager } from './policy-manager';

const AGENTCORE_TYPES = ['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER'];

/**
 * Compute scoped IAM policies for an integration connector.
 *
 * @param integrationId - Unique integration ID
 * @param integrationType - Connector type (CONFLUENCE, AWS_LAMBDA, etc.)
 * @param context - Object containing secretArn, ssmParameterPrefix, gatewayTargetId, config
 * @param accountId - AWS account ID
 * @param region - AWS region
 */
export function computeIntegrationPolicies(
  integrationId: string,
  integrationType: string,
  context: {
    secretArn?: string;
    ssmParameterPrefix?: string;
    gatewayTargetId?: string;
    config?: Record<string, any>;
  },
  accountId: string,
  region: string
): PolicyStatement[] {
  const policies: PolicyStatement[] = [];

  if (!integrationType) return policies;

  // 1. Scoped secret read access
  if (context.secretArn) {
    policies.push({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [context.secretArn],
    });
  }

  // 2. Scoped SSM parameter read access
  if (context.ssmParameterPrefix) {
    policies.push({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${region}:${accountId}:parameter${context.ssmParameterPrefix}/*`,
      ],
    });
  }

  // 3. AgentCore gateway target invocation
  if (AGENTCORE_TYPES.includes(integrationType) && context.gatewayTargetId) {
    policies.push({
      actions: ['bedrock-agentcore:InvokeGatewayTarget'],
      resources: [
        `arn:aws:bedrock-agentcore:${region}:${accountId}:gateway/*/target/${context.gatewayTargetId}`,
      ],
    });
  }

  // 4. Lambda invocation for AWS_LAMBDA type
  if (integrationType === 'AWS_LAMBDA' && context.config?.lambdaArn) {
    policies.push({
      actions: ['lambda:InvokeFunction'],
      resources: [context.config.lambdaArn],
    });
  }

  return policies;
}

export interface AgentPermissions {
  /** Bedrock model IDs the agent is allowed to invoke */
  models?: string[];
  /** DataStore IDs the agent can access (will get sts:AssumeRole on the ds role) */
  dataStores?: string[];
  /** Integration IDs the agent can access (will get sts:AssumeRole on the int role) */
  integrations?: string[];
}

/**
 * Compute scoped IAM policies for an agent based on its declared permissions.
 *
 * @param agentId - Unique agent ID
 * @param permissions - Declared permission requirements
 * @param accountId - AWS account ID
 * @param region - AWS region
 */
export function computeAgentPolicies(
  agentId: string,
  permissions: AgentPermissions,
  accountId: string,
  region: string
): PolicyStatement[] {
  const policies: PolicyStatement[] = [];

  // 1. Bedrock model invocation scoped to declared models
  if (permissions.models && permissions.models.length > 0) {
    policies.push({
      actions: ['bedrock:InvokeModel'],
      resources: permissions.models.map(
        (modelId) => `arn:aws:bedrock:${region}::foundation-model/${modelId}`
      ),
    });
  }

  // 2. AssumeRole on datastore scoped roles
  if (permissions.dataStores && permissions.dataStores.length > 0) {
    policies.push({
      actions: ['sts:AssumeRole'],
      resources: permissions.dataStores.map(
        (dsId) => `arn:aws:iam::${accountId}:role/${PolicyManager.getRoleName(dsId, 'datastore')}`
      ),
    });
  }

  // 3. AssumeRole on integration scoped roles
  if (permissions.integrations && permissions.integrations.length > 0) {
    policies.push({
      actions: ['sts:AssumeRole'],
      resources: permissions.integrations.map(
        (intId) => `arn:aws:iam::${accountId}:role/${PolicyManager.getRoleName(intId, 'integration')}`
      ),
    });
  }

  return policies;
}
