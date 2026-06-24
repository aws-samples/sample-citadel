import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getUserId } from '../utils/appsync';
import { extractOrgFromEvent } from '../utils/auth-event';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;
const APPS_TABLE = process.env.APPS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('Workflow resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getWorkflow':
        return await getWorkflow(args.workflowId, userId, event);
      case 'listWorkflows':
        return await listWorkflows(args.orgId, args.status, userId, event);
      case 'listBlueprints':
        return await listBlueprints(args.category);
      case 'createWorkflow':
        return await createWorkflow(args.input, userId);
      case 'updateWorkflow':
        return await updateWorkflow(args.input, userId, event);
      case 'deleteWorkflow':
        return await deleteWorkflow(args.workflowId, userId, event);
      case 'publishWorkflow':
        return await publishWorkflow(args.workflowId, userId, event);
      case 'updateWorkflowConfiguration':
        return await updateWorkflowConfiguration(args.workflowId, args.configuration, args.version, userId, event);
      case 'importBlueprint':
        return await importBlueprint(args.blueprintId, args.appId, args.name, userId, event);
      case 'importWorkflow':
        return await importWorkflowFn(args.input, userId);
      case 'exportWorkflow':
        return await exportWorkflow(args.workflowId, userId, event);
      case 'getWorkflowVersion':
        return await getWorkflowVersion(args.workflowId, args.version, userId, event);
      case 'listAppWorkflows':
        return await listAppWorkflows(args.appId, userId, event);
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Workflow resolver error:', error);
    throw error;
  }
};

async function getWorkflow(workflowId: string, userId: string, event: any): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
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

async function listWorkflows(
  orgId: string,
  status: string | undefined,
  userId: string,
  event: any,
): Promise<{ items: any[]; nextToken?: string }> {
  const userOrg = await extractOrgFromEvent(event);
  const queryOrgId = userOrg || orgId;

  const params: any = {
    TableName: WORKFLOWS_TABLE,
    IndexName: 'OrgStatusIndex',
    KeyConditionExpression: status
      ? 'orgId = :orgId AND #status = :status'
      : 'orgId = :orgId',
    ExpressionAttributeValues: {
      ':orgId': queryOrgId,
      ':isBlueprintFalse': 'false',
      ...(status ? { ':status': status } : {}),
    },
    FilterExpression: 'isBlueprint = :isBlueprintFalse',
    ...(status ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
  };

  const result = await docClient.send(new QueryCommand(params));
  return {
    items: result.Items || [],
    nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
  };
}

async function listBlueprints(
  category?: string,
): Promise<{ items: any[]; nextToken?: string }> {
  const params: any = {
    TableName: WORKFLOWS_TABLE,
    IndexName: 'BlueprintIndex',
    KeyConditionExpression: 'isBlueprint = :isBlueprint',
    ExpressionAttributeValues: {
      ':isBlueprint': 'true',
    },
    ScanIndexForward: false,
  };

  const result = await docClient.send(new QueryCommand(params));
  let items = result.Items || [];

  if (category) {
    items = items.filter((item: any) => {
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        return meta?.category === category;
      } catch {
        return false;
      }
    });
  }

  return {
    items,
    nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
  };
}

async function createWorkflow(input: any, userId: string): Promise<any> {
  const now = new Date().toISOString();
  const workflowId = uuidv4();

  // Validate definition structure before persistence (WF-01 AC 12)
  if (input.definition) {
    const validation = validateDefinitionStructure(input.definition);
    if (!validation.valid) {
      throw new Error(`Invalid workflow definition: ${validation.errors.join('; ')}`);
    }
  }

  const workflow = {
    workflowId,
    orgId: input.orgId,
    name: input.name,
    description: input.description || '',
    status: 'DRAFT',
    isBlueprint: input.isBlueprint ? 'true' : 'false',
    definition: input.definition,
    configuration: input.configuration || null,
    version: 1,
    versionHistory: [],
    appId: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata || null,
  };

  await docClient.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: workflow,
  }));

  await emitEvent('workflow.created', {
    workflowId,
    orgId: input.orgId,
    userId,
  });

  return workflow;
}

async function updateWorkflow(input: any, userId: string, event: any): Promise<any> {
  // Verify org access first
  const existing = await getWorkflow(input.workflowId, userId, event);
  if (!existing) {
    throw new Error('Workflow not found');
  }

  const now = new Date().toISOString();
  const updateExpression: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  // Push current state to versionHistory before updating
  const historyEntry = {
    version: existing.version,
    definition: existing.definition,
    updatedAt: existing.updatedAt,
    updatedBy: existing.createdBy || userId,
  };
  updateExpression.push('#versionHistory = list_append(if_not_exists(#versionHistory, :emptyList), :historyEntry)');
  expressionAttributeNames['#versionHistory'] = 'versionHistory';
  expressionAttributeValues[':historyEntry'] = [historyEntry];
  expressionAttributeValues[':emptyList'] = [];

  if (input.name !== undefined) {
    updateExpression.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = input.name;
  }
  if (input.description !== undefined) {
    updateExpression.push('#description = :description');
    expressionAttributeNames['#description'] = 'description';
    expressionAttributeValues[':description'] = input.description;
  }
  if (input.definition !== undefined) {
    // Validate definition structure before persistence (WF-01 AC 12)
    const validation = validateDefinitionStructure(input.definition);
    if (!validation.valid) {
      throw new Error(`Invalid workflow definition: ${validation.errors.join('; ')}`);
    }
    updateExpression.push('#definition = :definition');
    expressionAttributeNames['#definition'] = 'definition';
    expressionAttributeValues[':definition'] = input.definition;
  }
  if (input.configuration !== undefined) {
    updateExpression.push('#configuration = :configuration');
    expressionAttributeNames['#configuration'] = 'configuration';
    expressionAttributeValues[':configuration'] = input.configuration;
  }
  if (input.metadata !== undefined) {
    updateExpression.push('#metadata = :metadata');
    expressionAttributeNames['#metadata'] = 'metadata';
    expressionAttributeValues[':metadata'] = input.metadata;
  }

  updateExpression.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = now;

  updateExpression.push('#version = :nextVersion');
  expressionAttributeNames['#version'] = 'version';
  expressionAttributeValues[':nextVersion'] = input.version + 1;
  expressionAttributeValues[':currentVersion'] = input.version;

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: input.workflowId },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ConditionExpression: 'version = :currentVersion',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    }));

    await emitEvent('workflow.updated', {
      workflowId: input.workflowId,
      userId,
      changes: input,
    });

    return result.Attributes;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: workflow was modified concurrently. Please retry.');
    }
    throw error;
  }
}

async function deleteWorkflow(workflowId: string, userId: string, event: any): Promise<any> {
  const workflow = await getWorkflow(workflowId, userId, event);
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  if (workflow.status === 'PUBLISHED') {
    throw new Error('Cannot delete a published workflow. Unpublish it first.');
  }

  await docClient.send(new DeleteCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));

  await emitEvent('workflow.deleted', {
    workflowId,
    orgId: workflow.orgId,
    userId,
  });

  return { success: true, message: `Workflow ${workflowId} deleted` };
}

/**
 * Validates workflow definition structure before persistence (WF-01 AC 12).
 * Lightweight check: valid JSON, has nodes array and edges array.
 */
function validateDefinitionStructure(definitionJson: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  let definition: any;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    return { valid: false, errors: ['Invalid JSON in workflow definition'] };
  }
  if (typeof definition !== 'object' || definition === null) {
    errors.push('Workflow definition must be a JSON object');
  } else {
    if (!Array.isArray(definition.nodes)) {
      errors.push('Workflow definition must contain a nodes array');
    }
    if (!Array.isArray(definition.edges)) {
      errors.push('Workflow definition must contain an edges array');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a workflow definition for publishing.
 * Returns { valid: boolean, errors: string[] }
 */
function validateDefinition(definitionJson: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  let definition: any;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    return { valid: false, errors: ['Invalid JSON in workflow definition'] };
  }

  const nodes: any[] = definition.nodes || [];
  const edges: any[] = definition.edges || [];

  // Check all nodes have agentId (and reject placeholder template IDs)
  for (const node of nodes) {
    if (!node.agentId) {
      errors.push(`Node "${node.id}" is missing agentId`);
    } else if (typeof node.agentId === 'string' && node.agentId.startsWith('placeholder-')) {
      errors.push(
        `Workflow contains placeholder agentId '${node.agentId}' in node '${node.id}'. ` +
        `Replace with real agent IDs before publishing. ` +
        `(Blueprint templates contain placeholder agentIds for illustration; clone and re-map.)`
      );
    }
  }

  // Check no disconnected nodes
  if (nodes.length > 1) {
    const connectedNodeIds = new Set<string>();
    for (const edge of edges) {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    }
    for (const node of nodes) {
      if (!connectedNodeIds.has(node.id)) {
        errors.push(`Node "${node.id}" is disconnected`);
      }
    }
  }

  // Check no cycles (DFS-based)
  if (edges.length > 0) {
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      adjacency.get(edge.source)?.push(edge.target);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      inStack.add(nodeId);
      for (const neighbor of adjacency.get(nodeId) || []) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (inStack.has(neighbor)) {
          return true;
        }
      }
      inStack.delete(nodeId);
      return false;
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (hasCycle(node.id)) {
          errors.push('Workflow definition contains circular dependencies');
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

async function publishWorkflow(workflowId: string, userId: string, event: any): Promise<any> {
  const workflow = await getWorkflow(workflowId, userId, event);
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  const validation = validateDefinition(workflow.definition);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
  }

  const now = new Date().toISOString();
  const result = await docClient.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
    UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #version = :nextVersion',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
      '#version': 'version',
    },
    ExpressionAttributeValues: {
      ':status': 'PUBLISHED',
      ':updatedAt': now,
      ':nextVersion': workflow.version + 1,
    },
    ReturnValues: 'ALL_NEW',
  }));

  await emitEvent('workflow.published', {
    workflowId,
    orgId: workflow.orgId,
    userId,
  });

  return result.Attributes;
}

async function updateWorkflowConfiguration(
  workflowId: string,
  configurationJson: string,
  version: number,
  userId: string,
  event: any,
): Promise<any> {
  const existing = await getWorkflow(workflowId, userId, event);
  if (!existing) {
    throw new Error('Workflow not found');
  }

  const existingConfig = existing.configuration
    ? (typeof existing.configuration === 'string' ? JSON.parse(existing.configuration) : existing.configuration)
    : {};
  const newConfig = JSON.parse(configurationJson);

  // Shallow merge at top-level keys
  const merged = { ...existingConfig, ...newConfig };

  const now = new Date().toISOString();

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: 'SET #configuration = :configuration, #updatedAt = :updatedAt, #version = :nextVersion',
      ConditionExpression: 'version = :currentVersion',
      ExpressionAttributeNames: {
        '#configuration': 'configuration',
        '#updatedAt': 'updatedAt',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':configuration': JSON.stringify(merged),
        ':updatedAt': now,
        ':nextVersion': version + 1,
        ':currentVersion': version,
      },
      ReturnValues: 'ALL_NEW',
    }));

    await emitEvent('workflow.updated', {
      workflowId,
      userId,
      changes: { configuration: merged },
    });

    return result.Attributes;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: workflow was modified concurrently. Please retry.');
    }
    throw error;
  }
}

async function importBlueprint(
  blueprintId: string,
  appId: string,
  name: string | undefined,
  userId: string,
  event: any,
): Promise<any> {
  // Get the blueprint
  const blueprintResult = await docClient.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: blueprintId },
  }));

  const blueprint = blueprintResult.Item;
  if (!blueprint) {
    throw new Error('Blueprint not found');
  }

  if (blueprint.status !== 'PUBLISHED') {
    throw new Error('Only published blueprints can be imported');
  }

  // Get the target app
  const appResult = await docClient.send(new GetCommand({
    TableName: APPS_TABLE,
    Key: { appId },
  }));

  const app = appResult.Item;
  if (!app) {
    throw new Error('App not found');
  }

  // Verify org access
  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && app.orgId !== userOrg) {
    throw new Error('Access denied');
  }

  const now = new Date().toISOString();
  const workflowId = uuidv4();

  // Deep-copy the definition (stored as JSON string in DynamoDB)
  const definitionStr = typeof blueprint.definition === 'string'
    ? blueprint.definition
    : JSON.stringify(blueprint.definition);
  const definition = JSON.stringify(JSON.parse(definitionStr));

  const workflow = {
    workflowId,
    orgId: app.orgId,
    name: name || `${blueprint.name} (Copy)`,
    description: blueprint.description || '',
    status: 'DRAFT',
    isBlueprint: 'false',
    definition,
    configuration: blueprint.configuration || null,
    version: 1,
    versionHistory: [],
    appId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    metadata: blueprint.metadata || null,
  };

  // Put the new workflow
  await docClient.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: workflow,
  }));

  // Append workflowId to app's workflowIds
  await docClient.send(new UpdateCommand({
    TableName: APPS_TABLE,
    Key: { appId },
    UpdateExpression: 'SET #workflowIds = list_append(if_not_exists(#workflowIds, :emptyList), :newWorkflowId)',
    ExpressionAttributeNames: {
      '#workflowIds': 'workflowIds',
    },
    ExpressionAttributeValues: {
      ':newWorkflowId': [workflowId],
      ':emptyList': [],
    },
  }));

  await emitEvent('workflow.imported', {
    blueprintId,
    workflowId,
    appId,
    userId,
  });

  return workflow;
}

async function importWorkflowFn(input: any, userId: string): Promise<any> {
  const { orgId, workflowJson, name } = input;

  let parsed: any;
  try {
    parsed = JSON.parse(workflowJson);
  } catch {
    throw new Error('Invalid JSON in workflow import');
  }

  // Validate the definition exists
  if (!parsed.definition) {
    throw new Error('Imported workflow must contain a definition');
  }

  const now = new Date().toISOString();
  const workflowId = uuidv4();

  const workflow = {
    workflowId,
    orgId,
    name: name || parsed.name || 'Imported Workflow',
    description: parsed.description || '',
    status: 'DRAFT',
    isBlueprint: 'false',
    definition: parsed.definition,
    configuration: parsed.configuration || null,
    version: 1,
    versionHistory: [],
    appId: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    metadata: parsed.metadata || null,
  };

  await docClient.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: workflow,
  }));

  return workflow;
}

async function exportWorkflow(workflowId: string, userId: string, event: any): Promise<any> {
  const workflow = await getWorkflow(workflowId, userId, event);
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  return JSON.stringify({
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
    configuration: workflow.configuration,
    metadata: workflow.metadata,
    status: workflow.status,
    version: workflow.version,
  });
}

async function getWorkflowVersion(
  workflowId: string,
  version: number,
  userId: string,
  event: any,
): Promise<any> {
  const workflow = await getWorkflow(workflowId, userId, event);
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  // If requesting current version, return as-is
  if (workflow.version === version) {
    return workflow;
  }

  // Look in versionHistory
  const history = workflow.versionHistory || [];
  const entry = history.find((h: any) => h.version === version);
  if (!entry) {
    throw new Error(`Version ${version} not found`);
  }

  return {
    ...workflow,
    definition: entry.definition,
    version: entry.version,
  };
}

async function listAppWorkflows(appId: string, userId: string, event: any): Promise<any[]> {
  // Get the app first
  const appResult = await docClient.send(new GetCommand({
    TableName: APPS_TABLE,
    Key: { appId },
  }));

  const app = appResult.Item;
  if (!app) {
    throw new Error('App not found');
  }

  // Verify org access
  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && app.orgId !== userOrg) {
    throw new Error('Access denied');
  }

  const workflowIds: string[] = app.workflowIds || [];
  if (workflowIds.length === 0) {
    return [];
  }

  // BatchGetItem for workflows
  const keys = workflowIds.map((id) => ({ workflowId: id }));
  const tableName = process.env.WORKFLOWS_TABLE!;
  const result = await docClient.send(new BatchGetCommand({
    RequestItems: {
      [tableName]: {
        Keys: keys,
      },
    },
  }));

  return result.Responses?.[tableName] || [];
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
