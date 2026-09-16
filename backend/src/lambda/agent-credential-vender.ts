/**
 * Agent Credential Vender Lambda
 *
 * Invoked by the Python worker wrapper to obtain scoped IAM credentials
 * for an agent before executing its code. Uses PolicyManager to create
 * a per-agent IAM role with only the permissions the agent declares.
 *
 * Input:
 *   { agentId: string, org: string, requiredPermissions: { models?, dataStores?, integrations? } }
 *
 * Output:
 *   { credentials: { accessKeyId, secretAccessKey, sessionToken } | null, error?: string }
 *
 * Wave 2b (branch fix/vender-org-scoping): `org` is REQUIRED and never
 * defaulted — fail closed with a clear error when absent. Before computing
 * any policy or creating/assuming any role, every declared dataStore/
 * integration id is resolved to its OWNING org and the agent's own record
 * org is checked against the request org. Any mismatch or unresolvable id
 * REJECTS the whole request (never silently dropped) — this is the only
 * gate that prevents a cross-org agent from being granted AssumeRole on
 * another org's citadel-ds-{id} / citadel-int-{id} role.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { PolicyManager } from "../utils/policy-manager";
import {
  computeAgentPolicies,
  AgentPermissions,
} from "../utils/policy-helpers";

const policyManager = new PolicyManager();
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE || "";
const DATASTORES_TABLE = process.env.DATASTORES_TABLE || "";
const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE || "";

interface VendCredentialsEvent {
  agentId: string;
  org?: string;
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

/** Thrown internally to short-circuit to the fail-closed error response. */
class OrgScopeError extends Error {}

async function getAgentOrgId(agentId: string): Promise<string | null> {
  if (!AGENT_CONFIG_TABLE) return null;
  const result = await dynamodb.send(
    new GetCommand({ TableName: AGENT_CONFIG_TABLE, Key: { agentId } }),
  );
  const orgId = result.Item?.orgId;
  return typeof orgId === "string" && orgId ? orgId : null;
}

async function getDataStoreOrgId(dataStoreId: string): Promise<string | null> {
  if (!DATASTORES_TABLE) return null;
  const result = await dynamodb.send(
    new GetCommand({ TableName: DATASTORES_TABLE, Key: { dataStoreId } }),
  );
  const orgId = result.Item?.orgId;
  return typeof orgId === "string" && orgId ? orgId : null;
}

async function getIntegrationOrgId(
  integrationId: string,
): Promise<string | null> {
  if (!INTEGRATIONS_TABLE) return null;
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: INTEGRATIONS_TABLE,
      IndexName: "IntegrationIdIndex",
      KeyConditionExpression: "integrationId = :id",
      ExpressionAttributeValues: { ":id": integrationId },
    }),
  );
  const orgId = result.Items?.[0]?.orgId;
  return typeof orgId === "string" && orgId ? orgId : null;
}

/**
 * Resolves every declared dataStore/integration id to its owning orgId and
 * verifies the agent's own record org, all against `requestOrg`. Throws
 * `OrgScopeError` (fail closed, whole request rejected) on the first
 * unresolvable id or org mismatch — never silently drops an id and never
 * proceeds partially scoped.
 */
async function assertSameOrgOrThrow(
  agentId: string,
  requestOrg: string,
  permissions: AgentPermissions,
): Promise<void> {
  const agentOrgId = await getAgentOrgId(agentId);
  if (!agentOrgId || agentOrgId !== requestOrg) {
    throw new OrgScopeError(
      `Agent ${agentId} org (${agentOrgId ?? "unresolved"}) does not match request org ${requestOrg}`,
    );
  }

  for (const dsId of permissions.dataStores ?? []) {
    const dsOrgId = await getDataStoreOrgId(dsId);
    if (!dsOrgId || dsOrgId !== requestOrg) {
      throw new OrgScopeError(
        `DataStore ${dsId} could not be resolved to request org ${requestOrg}`,
      );
    }
  }

  for (const intId of permissions.integrations ?? []) {
    const intOrgId = await getIntegrationOrgId(intId);
    if (!intOrgId || intOrgId !== requestOrg) {
      throw new OrgScopeError(
        `Integration ${intId} could not be resolved to request org ${requestOrg}`,
      );
    }
  }
}

export async function handler(
  event: VendCredentialsEvent,
): Promise<VendCredentialsResult> {
  const { agentId, org, requiredPermissions } = event;

  if (!org || typeof org !== "string") {
    console.error("Failed to vend agent credentials: missing org on request", {
      agentId,
    });
    return {
      credentials: null,
      error:
        'Vend refused: request is missing a required "org" — never defaults to a fallback organization.',
    };
  }

  if (!requiredPermissions) {
    return { credentials: null };
  }

  // Quick check: any permissions declared at all?
  const hasPermissions =
    (requiredPermissions.models && requiredPermissions.models.length > 0) ||
    (requiredPermissions.dataStores &&
      requiredPermissions.dataStores.length > 0) ||
    (requiredPermissions.integrations &&
      requiredPermissions.integrations.length > 0);

  if (!hasPermissions) {
    return { credentials: null };
  }

  try {
    await assertSameOrgOrThrow(agentId, org, requiredPermissions);

    const { accountId, region } = await policyManager.getAccountContext();
    const policies = computeAgentPolicies(
      agentId,
      requiredPermissions,
      accountId,
      region,
    );

    await policyManager.ensureRole(agentId, policies, accountId, "agent");
    const credentials = await policyManager.assumeScopedRole(
      agentId,
      accountId,
      "agent",
    );

    return {
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    };
  } catch (error: unknown) {
    console.error("Failed to vend agent credentials:", {
      agentId,
      org,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      credentials: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
