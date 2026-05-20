/**
 * Agent Credential Vender Lambda
 *
 * Invoked by the Python worker wrapper to obtain scoped IAM credentials
 * for an agent before executing its code. Uses PolicyManager to create
 * a per-agent IAM role with only the permissions the agent declares.
 *
 * Input:
 *   { agentId: string, requiredPermissions: { models?, dataStores?, integrations? } }
 *
 * Output:
 *   { credentials: { accessKeyId, secretAccessKey, sessionToken } | null, error?: string }
 */

import { PolicyManager } from '../utils/policy-manager';
import { computeAgentPolicies, AgentPermissions } from '../utils/policy-helpers';

const policyManager = new PolicyManager();

interface VendCredentialsEvent {
  agentId: string;
  requiredPermissions?: AgentPermissions;
}

interface VendCredentialsResult {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  } | null;
  error?: string;
}

export async function handler(event: VendCredentialsEvent): Promise<VendCredentialsResult> {
  const { agentId, requiredPermissions } = event;

  if (!requiredPermissions) {
    return { credentials: null };
  }

  // Quick check: any permissions declared at all?
  const hasPermissions =
    (requiredPermissions.models && requiredPermissions.models.length > 0) ||
    (requiredPermissions.dataStores && requiredPermissions.dataStores.length > 0) ||
    (requiredPermissions.integrations && requiredPermissions.integrations.length > 0);

  if (!hasPermissions) {
    return { credentials: null };
  }

  try {
    const { accountId, region } = await policyManager.getAccountContext();
    const policies = computeAgentPolicies(agentId, requiredPermissions, accountId, region);

    await policyManager.ensureRole(agentId, policies, accountId, 'agent');
    const credentials = await policyManager.assumeScopedRole(agentId, accountId, 'agent');

    return {
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    };
  } catch (error: any) {
    console.error('Failed to vend agent credentials:', { agentId, error: error.message });
    return {
      credentials: null,
      error: error.message,
    };
  }
}
