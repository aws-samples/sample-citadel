/**
 * Recent Activity Resolver
 *
 * Queries recent entity changes across projects, agents, workflows,
 * and integrations. Returns merged results sorted by timestamp descending.
 */

import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

export interface ActivityItem {
  entityType: "project" | "agent" | "workflow" | "integration";
  entityId: string;
  title: string;
  description: string;
  timestamp: string;
}

export interface RecentActivityResult {
  items: ActivityItem[];
}

export interface RecentActivityDeps {
  docClient: DynamoDBDocumentClient;
  projectsTable: string;
  agentConfigTable: string;
  workflowsTable: string;
  integrationsTable: string;
}

/** Maps a raw table item to the common ActivityItem shape. */
function toActivityItem(
  item: Record<string, unknown>,
  entityType: ActivityItem["entityType"],
  idField: string,
  nameField: string,
  statusField: string,
): ActivityItem {
  return {
    entityType,
    entityId: (item[idField] as string) || "unknown",
    title: (item[nameField] as string) || entityType,
    description: `Status: ${(item[statusField] as string) || "unknown"}`,
    timestamp:
      (item.updatedAt as string) ||
      (item.createdAt as string) ||
      new Date().toISOString(),
  };
}

/**
 * Fetches recent projects scoped to the caller's org via
 * ProjectsTable.OrganizationIndex (attribute `organization`) — same GSI
 * project-resolver.ts's listProjects queries for non-admin callers.
 */
async function fetchRecentProjects(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  orgId: string,
  limit: number,
): Promise<ActivityItem[]> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "OrganizationIndex",
        KeyConditionExpression: "organization = :org",
        ExpressionAttributeValues: { ":org": orgId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items || []).map((item) =>
      toActivityItem(item, "project", "id", "name", "status"),
    );
  } catch {
    return [];
  }
}

/**
 * Fetches recent workflows scoped to the caller's org via
 * WorkflowsTable.OrgStatusIndex (attribute `orgId`) — same GSI
 * workflow-resolver.ts's listWorkflows queries.
 */
async function fetchRecentWorkflows(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  orgId: string,
  limit: number,
): Promise<ActivityItem[]> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "OrgStatusIndex",
        KeyConditionExpression: "orgId = :orgId",
        ExpressionAttributeValues: { ":orgId": orgId },
        Limit: limit,
      }),
    );
    return (result.Items || []).map((item) =>
      toActivityItem(item, "workflow", "workflowId", "name", "status"),
    );
  } catch {
    return [];
  }
}

/**
 * Fetches recent integrations scoped to the caller's org via a direct
 * Query on PK=ORG#{orgId} — IntegrationsTable is already partition-keyed
 * by org (same key shape integration-resolver.ts's listIntegrations uses),
 * so no GSI is needed here.
 */
async function fetchRecentIntegrations(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  orgId: string,
  limit: number,
): Promise<ActivityItem[]> {
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": `ORG#${orgId}`,
          ":sk": "INTEGRATION#",
        },
        Limit: limit,
      }),
    );
    return (result.Items || []).map((item) =>
      toActivityItem(item, "integration", "integrationId", "name", "status"),
    );
  } catch {
    return [];
  }
}

export async function getRecentActivity(
  orgId: string,
  limit: number = 10,
  deps: RecentActivityDeps,
): Promise<RecentActivityResult> {
  const effectiveLimit = Math.min(Math.max(limit, 1), 50);
  const perTable = effectiveLimit;

  // Org scoping (finding 615aa5bb): projects/workflows/integrations are
  // each queried against their own org-scoped index/key — never a
  // table-wide ScanCommand. agentConfigTable (the legacy DynamoDB table
  // used by agent-config-resolver.ts's listAgentConfigs fallback) carries
  // no orgId attribute and has no org GSI (see AgentConfigTable in
  // backend/lib/backend-stack.ts) — adding one is a real data-model change
  // out of scope for this fix, so agent activity is deliberately excluded
  // (fail closed) rather than left as an unscoped, cross-tenant scan.
  const [projects, workflows, integrations] = await Promise.all([
    fetchRecentProjects(deps.docClient, deps.projectsTable, orgId, perTable),
    fetchRecentWorkflows(deps.docClient, deps.workflowsTable, orgId, perTable),
    fetchRecentIntegrations(
      deps.docClient,
      deps.integrationsTable,
      orgId,
      perTable,
    ),
  ]);

  const merged = [...projects, ...workflows, ...integrations]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, effectiveLimit);

  return { items: merged };
}
