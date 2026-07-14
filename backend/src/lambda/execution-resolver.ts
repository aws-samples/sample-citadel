import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getUserId } from '../utils/appsync';
import { extractOrgFromEvent } from '../utils/auth-event';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const EXECUTIONS_TABLE = process.env.EXECUTIONS_TABLE!;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('Execution resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getExecution':
        return await getExecution(args.executionId, userId, event);
      case 'listExecutions':
        return await listExecutions(args.workflowId);
      case 'startExecution':
        return await startExecution(args.workflowId, args.input, userId, event);
      case 'cancelExecution':
        return await cancelExecution(args.executionId, userId, event);
      case 'publishWorkflowProgress':
        // IAM-signed fan-out mutation: echo the input so AppSync delivers it
        // to onWorkflowProgress subscribers.
        return args.input;
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Execution resolver error:', error);
    throw error;
  }
};

async function getExecution(executionId: string, userId: string, event: any): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: EXECUTIONS_TABLE,
    Key: { executionId },
  }));

  if (!result.Item) {
    return null;
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && result.Item.orgId !== userOrg) {
    throw new Error('Access denied');
  }

  return result.Item;
}

async function listExecutions(workflowId: string): Promise<{ items: any[]; nextToken?: string }> {
  const result = await docClient.send(new QueryCommand({
    TableName: EXECUTIONS_TABLE,
    IndexName: 'WorkflowIndex',
    KeyConditionExpression: 'workflowId = :workflowId',
    ExpressionAttributeValues: {
      ':workflowId': workflowId,
    },
    ScanIndexForward: false,
  }));

  return {
    items: result.Items || [],
    nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
  };
}

async function startExecution(workflowId: string, input: string | undefined, userId: string, event: any): Promise<any> {
  // 1. Get workflow, verify PUBLISHED + org access
  const workflowResult = await docClient.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));

  const workflow = workflowResult.Item;
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && workflow.orgId !== userOrg) {
    throw new Error('Access denied');
  }

  if (workflow.status !== 'PUBLISHED') {
    throw new Error('Only published workflows can be executed');
  }

  // 2. Parse definition, initialize nodeResults
  const definition = JSON.parse(workflow.definition);
  const nodes: any[] = definition.nodes || [];
  const nodeResults: Record<string, any> = {};
  for (const node of nodes) {
    nodeResults[node.id] = {
      nodeId: node.id,
      agentId: node.agentId,
      status: 'pending',
      retryCount: 0,
    };
  }

  // 3. Create execution item
  const now = new Date().toISOString();
  const executionId = uuidv4();

  const execution = {
    executionId,
    workflowId,
    appId: workflow.appId || null,
    orgId: workflow.orgId,
    status: 'pending',
    workflowVersion: workflow.version,
    currentNode: null,
    nodeResults,
    input: input || null,
    output: null,
    startedAt: now,
    completedAt: null,
    triggeredBy: userId,
    error: null,
  };

  await docClient.send(new PutCommand({
    TableName: EXECUTIONS_TABLE,
    Item: execution,
  }));

  // 4. Publish execution.start.requested event
  await emitEvent('execution.start.requested', {
    executionId,
    workflowId,
  });

  return execution;
}

async function cancelExecution(executionId: string, userId: string, event: any): Promise<any> {
  // 1. Get execution, verify org access
  const existing = await getExecution(executionId, userId, event);
  if (!existing) {
    throw new Error('Execution not found');
  }

  // 2. Update status to cancelled
  const now = new Date().toISOString();
  const result = await docClient.send(new UpdateCommand({
    TableName: EXECUTIONS_TABLE,
    Key: { executionId },
    UpdateExpression: 'SET #status = :status, #completedAt = :completedAt',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#completedAt': 'completedAt',
    },
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':completedAt': now,
    },
    ReturnValues: 'ALL_NEW',
  }));

  // 3. Publish execution.cancel.requested event
  await emitEvent('execution.cancel.requested', {
    executionId,
    workflowId: existing.workflowId,
  });

  return result.Attributes;
}

async function emitEvent(eventType: string, detail: any): Promise<void> {
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.workflows',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: EVENT_BUS_NAME,
      },
    ],
  }));
}
