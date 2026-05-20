/**
 * Recent Activity Resolver
 *
 * Queries recent entity changes across projects, agents, workflows,
 * and integrations. Returns merged results sorted by timestamp descending.
 */

import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

export interface ActivityItem {
  entityType: 'project' | 'agent' | 'workflow' | 'integration';
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

async function fetchRecent(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  entityType: ActivityItem['entityType'],
  idField: string,
  nameField: string,
  statusField: string,
  limit: number,
): Promise<ActivityItem[]> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: tableName,
      Limit: limit,
    }));
    return (result.Items || []).map(item => ({
      entityType,
      entityId: (item[idField] as string) || 'unknown',
      title: (item[nameField] as string) || entityType,
      description: `Status: ${(item[statusField] as string) || 'unknown'}`,
      timestamp: (item.updatedAt as string) || (item.createdAt as string) || new Date().toISOString(),
    }));
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

  const [projects, agents, workflows, integrations] = await Promise.all([
    fetchRecent(deps.docClient, deps.projectsTable, 'project', 'id', 'name', 'status', perTable),
    fetchRecent(deps.docClient, deps.agentConfigTable, 'agent', 'agentId', 'agentId', 'state', perTable),
    fetchRecent(deps.docClient, deps.workflowsTable, 'workflow', 'workflowId', 'name', 'status', perTable),
    fetchRecent(deps.docClient, deps.integrationsTable, 'integration', 'integrationId', 'name', 'status', perTable),
  ]);

  const merged = [...projects, ...agents, ...workflows, ...integrations]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, effectiveLimit);

  return { items: merged };
}
