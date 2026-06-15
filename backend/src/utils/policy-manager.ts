/**
 * Generalized Policy Manager
 *
 * Manages scoped IAM roles for datastores, integrations, and agents.
 * The scope parameter controls the role name prefix.
 */

import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
} from '@aws-sdk/client-iam';
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from '@aws-sdk/client-sts';
import { PolicyStatement } from '../adapters/base';
import { PermissionError } from '../adapters/errors';

export type PolicyScope = 'datastore' | 'integration' | 'agent';

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const SCOPE_PREFIXES: Record<PolicyScope, string> = {
  datastore: 'citadel-ds-',
  integration: 'citadel-int-',
  agent: 'citadel-agent-',
};

const INLINE_POLICY_NAME = 'DataStoreAccess';

export class PolicyManager {
  private iamClient: IAMClient;
  private stsClient: STSClient;

  constructor(iamClient?: IAMClient, stsClient?: STSClient) {
    this.iamClient = iamClient ?? new IAMClient({});
    this.stsClient = stsClient ?? new STSClient({});
  }

  async getAccountContext(): Promise<{ accountId: string; region: string }> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account!;
    const region = await this.stsClient.config.region();
    return { accountId, region: typeof region === 'string' ? region : 'us-east-1' };
  }

  private static isScope(value: any): value is PolicyScope {
    return value === 'datastore' || value === 'integration' || value === 'agent';
  }

  async ensureRole(
    resourceId: string,
    policies: PolicyStatement[],
    accountId: string,
    scopeOrCrossAccountArn?: PolicyScope | string,
    crossAccountRoleArn?: string,
    additionalTrustedPrincipals?: string[]
  ): Promise<void> {
    // Backward compat: if 4th arg looks like an ARN, treat it as crossAccountRoleArn
    let scope: PolicyScope = 'datastore';
    let crossArn = crossAccountRoleArn;
    if (scopeOrCrossAccountArn) {
      if (PolicyManager.isScope(scopeOrCrossAccountArn)) {
        scope = scopeOrCrossAccountArn;
      } else {
        crossArn = scopeOrCrossAccountArn;
      }
    }

    const roleName = PolicyManager.getRoleName(resourceId, scope);

    const callerIdentity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    const callerArn = callerIdentity.Arn!;
    const lambdaRoleArn = this.getLambdaRoleArn(callerArn);

    const principals: string[] = [lambdaRoleArn];
    if (crossArn) {
      principals.push(crossArn);
    }
    // Add any additional trusted principals (e.g. health monitor role)
    if (additionalTrustedPrincipals) {
      for (const p of additionalTrustedPrincipals) {
        if (p && !principals.includes(p)) {
          principals.push(p);
        }
      }
    }

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: principals.length === 1 ? principals[0] : principals },
        Action: 'sts:AssumeRole',
      }],
    };

    try {
      await this.iamClient.send(new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Tags: [
          { Key: 'ManagedBy', Value: 'citadel' },
          { Key: 'ResourceId', Value: resourceId },
          { Key: 'Scope', Value: scope },
        ],
      }));
    } catch (error: any) {
      if (error.name !== 'EntityAlreadyExistsException') {
        throw new PermissionError(`Failed to create IAM role ${roleName}: ${error.message}`, error);
      }
    }

    const policyDocument = PolicyManager.buildPolicyDocument(policies);
    try {
      await this.iamClient.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: INLINE_POLICY_NAME,
        PolicyDocument: JSON.stringify(policyDocument),
      }));
    } catch (error: any) {
      throw new PermissionError(`Failed to attach policy to role ${roleName}: ${error.message}`, error);
    }
  }

  async assumeScopedRole(
    resourceId: string,
    accountId: string,
    scopeOrCrossAccountArn?: PolicyScope | string,
    crossAccountRoleArn?: string
  ): Promise<ScopedCredentials> {
    // Backward compat: if 3rd arg looks like an ARN, treat it as crossAccountRoleArn
    let scope: PolicyScope = 'datastore';
    let crossArn = crossAccountRoleArn;
    if (scopeOrCrossAccountArn) {
      if (PolicyManager.isScope(scopeOrCrossAccountArn)) {
        scope = scopeOrCrossAccountArn;
      } else {
        crossArn = scopeOrCrossAccountArn;
      }
    }

    const roleName = PolicyManager.getRoleName(resourceId, scope);
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;

    let stsClient = this.stsClient;

    if (crossArn) {
      const crossAccountCreds = await this.retryWithBackoff(async () => {
        const result = await this.stsClient.send(new AssumeRoleCommand({
          RoleArn: crossArn,
          RoleSessionName: `citadel-cross-${resourceId}`,
        }));
        return result.Credentials!;
      }, 3, 1000);

      stsClient = new STSClient({
        credentials: {
          accessKeyId: crossAccountCreds.AccessKeyId!,
          secretAccessKey: crossAccountCreds.SecretAccessKey!,
          sessionToken: crossAccountCreds.SessionToken!,
        },
      });
    }

    const credentials = await this.retryWithBackoff(async () => {
      const result = await stsClient.send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `citadel-${scope}-${resourceId}`,
      }));
      return result.Credentials!;
    }, 3, 2000);

    return {
      accessKeyId: credentials.AccessKeyId!,
      secretAccessKey: credentials.SecretAccessKey!,
      sessionToken: credentials.SessionToken!,
    };
  }

  async deleteRole(resourceId: string, scope: PolicyScope = 'datastore'): Promise<void> {
    const roleName = PolicyManager.getRoleName(resourceId, typeof scope === 'string' && PolicyManager.isScope(scope) ? scope : 'datastore');

    try {
      await this.iamClient.send(new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: INLINE_POLICY_NAME,
      }));
    } catch (error: any) {
      if (error.name !== 'NoSuchEntityException') {
        throw new PermissionError(`Failed to delete policy from role ${roleName}: ${error.message}`, error);
      }
    }

    try {
      await this.iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    } catch (error: any) {
      if (error.name !== 'NoSuchEntityException') {
        throw new PermissionError(`Failed to delete IAM role ${roleName}: ${error.message}`, error);
      }
    }
  }

  private getLambdaRoleArn(callerArn: string): string {
    const match = callerArn.match(/arn:aws:sts::(\d+):assumed-role\/([^/]+)/);
    if (match) {
      return `arn:aws:iam::${match[1]}:role/${match[2]}`;
    }
    return callerArn;
  }

  async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number, baseDelayMs: number): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  static buildPolicyDocument(policies: PolicyStatement[]): Record<string, any> {
    return {
      Version: '2012-10-17',
      Statement: policies.map((p) => ({
        Effect: 'Allow',
        Action: p.actions,
        Resource: p.resources,
      })),
    };
  }

  static getRoleName(resourceId: string, scope: PolicyScope = 'datastore'): string {
    return `${SCOPE_PREFIXES[scope]}${resourceId}`;
  }
}
