import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { getUserId } from '../utils/appsync';
import { extractOrgFromEvent } from '../utils/auth-event';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const AGENT_STATUS_TABLE = process.env.AGENT_STATUS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface AgentStatus {
  agentId: string;
  projectId: string;
  status: string;
  currentTask?: string;
  progress?: number;
  lastUpdate: string;
  metadata?: any;
  errorMessage?: string;
}

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('Agent resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getAgentStatus':
        return await getAgentStatus(args.projectId, args.agentId, userId, event);
      case 'updateAgentStatus':
        return await updateAgentStatus(args.projectId, args.agentId, args.status, userId, event);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Agent resolver error:', error);
    throw error;
  }
};

async function getAgentStatus(
  projectId: string,
  agentId: string,
  _userId: string,
  event: any,
): Promise<AgentStatus | null> {
  // Project-membership check (tenant isolation).
  //
  // AgentStatus rows have no orgId — the tenant boundary lives on the parent
  // Project (`project.organization`, set from the caller's `custom:organization`
  // claim at create time). Mirror the pattern used by workflow-resolver.getWorkflow,
  // execution-resolver.getExecution, and project-resolver.getProject:
  //   1. load the parent resource,
  //   2. compare its org to the caller's org,
  //   3. throw 'Access denied' on mismatch.
  //
  // Returning null when the project is missing closes the existence-oracle leak
  // the previous default-IDLE path created (a caller could probe arbitrary
  // projectIds and infer existence from the agent-status default).
  const projectResult = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { id: projectId },
    }),
  );

  if (!projectResult.Item) {
    return null;
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && projectResult.Item.organization !== userOrg) {
    throw new Error('Access denied');
  }

  const command = new GetCommand({
    TableName: AGENT_STATUS_TABLE,
    Key: {
      projectId,
      agentId,
    },
  });

  const result = await docClient.send(command);

  if (!result.Item) {
    // Return default status if not found
    return {
      agentId,
      projectId,
      status: 'IDLE',
      lastUpdate: new Date().toISOString(),
    };
  }

  return result.Item as AgentStatus;
}

async function updateAgentStatus(
  projectId: string,
  agentId: string,
  statusInput: any,
  _userId: string,
  event: any,
): Promise<AgentStatus | null> {
  // Project-membership check (tenant isolation) — write path.
  //
  // Mirrors getAgentStatus: load the parent Project, return null if missing
  // (closes the existence-oracle leak — a caller cannot probe arbitrary
  // projectIds via successful writes), then compare project.organization to
  // the caller's org and throw 'Access denied' on mismatch. The check MUST
  // precede PutItem to prevent cross-tenant writes into AGENT_STATUS_TABLE.
  const projectResult = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { id: projectId },
    }),
  );

  if (!projectResult.Item) {
    return null;
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && projectResult.Item.organization !== userOrg) {
    throw new Error('Access denied');
  }

  const now = new Date().toISOString();

  const agentStatus: AgentStatus = {
    agentId,
    projectId,
    status: statusInput.status,
    currentTask: statusInput.currentTask,
    progress: statusInput.progress,
    lastUpdate: now,
    metadata: statusInput.metadata,
    errorMessage: statusInput.errorMessage,
  };

  const command = new PutCommand({
    TableName: AGENT_STATUS_TABLE,
    Item: agentStatus,
  });

  await docClient.send(command);

  // Emit event for real-time subscriptions
  await emitEvent('agent.status_updated', {
    projectId,
    agentId,
    status: agentStatus,
    userId: _userId,
  });

  return agentStatus;
}

async function emitEvent(eventType: string, detail: any): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.backend',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: EVENT_BUS_NAME,
      },
    ],
  });

  await eventBridgeClient.send(command);
}