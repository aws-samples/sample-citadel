import { AppSyncResolverHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import Ajv from 'ajv';
import { getUserId } from '../utils/appsync';
import { publishAppStatusEvent } from '../utils/appsync-publish';
import { PolicyManager } from '../utils/policy-manager';
import { createAppApiKey, revokeAppApiKey, rotateAppApiKey, listAppApiKeys, ApiKeyDeps } from './app-api-key-management';
import { grantAppAccess, revokeAppAccess, listAppAccessEntries, AccessControlDeps } from './app-access-control';
import { setAppAuthConfig, AuthConfigDeps } from './app-auth-config';
import { getAppMetrics, getDashboardMetrics } from './app-metrics-handler';
import { getRecentActivity } from './recent-activity-resolver';
import { PolicyStatement } from '../adapters/base';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});
const cognitoClient = new CognitoIdentityProviderClient({});
const policyManager = new PolicyManager();

const APPS_TABLE = process.env.APPS_TABLE!;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || 'citadel-projects-dev';
const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE || 'citadel-integrations-dev';
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const USER_POOL_ID = process.env.USER_POOL_ID!;

export const handler: AppSyncResolverHandler<any, any> = async (event) => {
  console.log('App resolver event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case 'getApp': {
        // Access check via getApp, then return full app with components
        const app = await getApp(args.appId, userId);
        if (!app) return null;
        const fullApp = await getAppWithComponents(args.appId);
        return fullApp || app;
      }
      case 'listApps':
        return await listApps(args.orgId, userId);
      case 'createApp':
        return await createApp(args.input, userId);
      case 'updateApp':
        return await updateApp(args.input, userId);
      case 'deleteApp':
        return await deleteApp(args.appId, userId);
      case 'bindWorkflowToApp':
        return await bindWorkflowToApp(args.appId, args.workflowId, userId);
      case 'unbindWorkflowFromApp':
        return await unbindWorkflowFromApp(args.appId, args.workflowId, userId);
      case 'addAppComponent':
        return await addAppComponent(args.appId, args.component, userId);
      case 'removeAppComponent':
        return await removeAppComponent(args.appId, args.componentType, args.componentId, userId);
      case 'updateAgentBinding':
        return await updateAgentBinding(args.input, userId);
      case 'setAppConfigSchema':
        return await setAppConfigSchema(args.appId, args.schema, args.version, userId);
      case 'setAppConfigValues':
        return await setAppConfigValues(args.appId, args.values, args.version, userId);
      // API Key Management
      case 'createAppApiKey': {
        const result = await createAppApiKey(args.appId, args.name, userId, { docClient, appsTable: APPS_TABLE, eventBridgeClient, eventBusName: EVENT_BUS_NAME }, args.expiresIn);
        // Shape to AppApiKeyWithPlaintext GraphQL type — plaintext is returned
        // exactly once here at creation and is never persisted in retrievable form.
        return {
          keyId: result.keyId,
          name: result.name,
          prefix: result.prefix,
          status: result.status,
          createdAt: result.createdAt,
          expiresAt: result.expiresAt ?? null,
          lastUsedAt: null,
          apiKey: result.plaintext,
        };
      }
      case 'revokeAppApiKey':
        return await revokeAppApiKey(args.appId, args.keyId, userId, { docClient, appsTable: APPS_TABLE, eventBridgeClient, eventBusName: EVENT_BUS_NAME });
      case 'rotateAppApiKey': {
        const result = await rotateAppApiKey(args.appId, args.keyId, userId, { docClient, appsTable: APPS_TABLE, eventBridgeClient, eventBusName: EVENT_BUS_NAME });
        // Shape to AppApiKeyWithPlaintext GraphQL type — flatten result.newKey to
        // the top level and drop revokedKeyId. The plaintext is returned exactly
        // once here at rotation and is never persisted in retrievable form.
        return {
          keyId: result.newKey.keyId,
          name: result.newKey.name,
          prefix: result.newKey.prefix,
          status: result.newKey.status,
          createdAt: result.newKey.createdAt,
          expiresAt: null,
          lastUsedAt: null,
          apiKey: result.newKey.plaintext,
        };
      }
      case 'listAppApiKeys':
        return await listAppApiKeys(args.appId, { docClient, appsTable: APPS_TABLE, eventBridgeClient, eventBusName: EVENT_BUS_NAME });
      // Auth Config
      case 'setAppAuthConfig':
        return await setAppAuthConfig(args.appId, args.authConfig, { docClient, appsTable: APPS_TABLE });
      // Access Control
      case 'grantAppAccess':
        return await grantAppAccess(args.appId, args.userId, args.role, userId, { docClient, appsTable: APPS_TABLE });
      case 'revokeAppAccess':
        return await revokeAppAccess(args.appId, args.userId, { docClient, appsTable: APPS_TABLE });
      case 'listAppAccessEntries':
        return await listAppAccessEntries(args.appId, { docClient, appsTable: APPS_TABLE });
      // Metrics
      case 'getAppMetrics':
        return await getAppMetrics(args.appId, args.startTime, args.endTime, { docClient, appsTable: APPS_TABLE });
      case 'getDashboardMetrics':
        return await getDashboardMetrics(args.orgId, args.startTime, args.endTime, { docClient, appsTable: APPS_TABLE });
      case 'getRecentActivity':
        return await getRecentActivity(args.orgId, args.limit, { docClient, projectsTable: PROJECTS_TABLE, agentConfigTable: AGENT_CONFIG_TABLE, workflowsTable: WORKFLOWS_TABLE, integrationsTable: INTEGRATIONS_TABLE });
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('App resolver error:', error);
    throw error;
  }
};

async function getUserOrganization(userId: string): Promise<string | null> {
  try {
    const command = new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    });
    const response = await cognitoClient.send(command);
    const orgAttribute = response.UserAttributes?.find(attr => attr.Name === 'custom:organization');
    return orgAttribute?.Value || null;
  } catch (error) {
    console.error('Error getting user organization:', error);
    return null;
  }
}

async function getApp(appId: string, userId: string): Promise<any> {
  const result = await docClient.send(new GetCommand({
    TableName: APPS_TABLE,
    Key: { appId },
  }));

  if (!result.Item) {
    return null;
  }

  const userOrg = await getUserOrganization(userId);
  if (userOrg && userOrg !== 'All Organizations' && result.Item.orgId !== userOrg) {
    throw new Error('Access denied');
  }

  return result.Item;
}

async function listApps(
  orgId: string,
  userId: string,
): Promise<{ items: any[]; nextToken?: string }> {
  const userOrg = await getUserOrganization(userId);
  const queryOrgId = userOrg || orgId;

  const componentFilterExpression =
    '(sortId = :metadata OR attribute_not_exists(sortId)) AND (NOT begins_with(sortId, :agentPrefix)) AND (NOT begins_with(sortId, :permPrefix)) AND (NOT begins_with(sortId, :cfgPrefix))';
  const filterValues = {
    ':metadata': 'METADATA',
    ':agentPrefix': 'AGENT#',
    ':permPrefix': 'PERMISSION#',
    ':cfgPrefix': 'CONFIG#',
  };

  if (queryOrgId === 'All Organizations') {
    const result = await docClient.send(new ScanCommand({
      TableName: APPS_TABLE,
      FilterExpression: componentFilterExpression,
      ExpressionAttributeValues: filterValues,
    }));

    return {
      items: result.Items || [],
      nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
    };
  }

  const result = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'OrgIndex',
    KeyConditionExpression: 'orgId = :orgId',
    FilterExpression: componentFilterExpression,
    ExpressionAttributeValues: {
      ':orgId': queryOrgId,
      ...filterValues,
    },
  }));

  return {
    items: result.Items || [],
    nextToken: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : undefined,
  };
}

async function createApp(input: any, userId: string): Promise<any> {
  const now = new Date().toISOString();
  const appId = uuidv4();

  const app = {
    appId,
    groupId: deriveGroupId(appId),
    sortId: 'METADATA',
    orgId: input.orgId,
    name: input.name,
    description: input.description || '',
    status: 'DRAFT',
    workflowIds: [],
    routingConfig: null,
    version: 1,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: APPS_TABLE,
    Item: app,
  }));

  await emitEvent('app.created', {
    appId,
    orgId: input.orgId,
    userId,
  });

  return app;
}

async function validatePublishPreconditions(appId: string): Promise<{ errors: string[]; permissionItems: Array<{ actions: string[]; resources: string[] }> }> {
  const errors: string[] = [];

  // Query GroupIndex for all components
  const result = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': `APP#${appId}` },
  }));

  const items = result.Items || [];
  const agentBindings = items.filter(i => i.sortId?.startsWith('AGENT#'));
  const permissions = items.filter(i => i.sortId?.startsWith('PERMISSION#'));
  const configSchema = items.find(i => i.sortId === 'CONFIG#schema');
  const configValues = items.find(i => i.sortId === 'CONFIG#values');

  // Check 1: All agent bindings must have status=READY
  const designAgents = agentBindings.filter(b => b.status !== 'READY');
  if (designAgents.length > 0) {
    const agentIds = designAgents.map(b => b.agentId).join(', ');
    errors.push(`Agents not ready: ${agentIds}`);
  }

  // Check 2: If configSchema exists, configValues must exist and validate
  if (configSchema?.schema) {
    if (!configValues?.values) {
      errors.push('Configuration values are required when a config schema is defined');
    } else {
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(configSchema.schema);
      const valid = validate(configValues.values);
      if (!valid) {
        const validationErrors = (validate.errors || []).map((e: any) => {
          const path = e.instancePath || (e.params?.missingProperty ? e.params.missingProperty : '');
          return `${path ? path + ': ' : ''}${e.message}`;
        }).join('; ');
        errors.push(`Config validation failed: ${validationErrors}`);
      }
    }
  }

  const permissionItems = permissions.map(i => ({
    actions: i.actions || [],
    resources: i.resources || [],
  }));

  return { errors, permissionItems };
}

async function ensurePublishRole(appId: string, permissionItems: Array<{ actions: string[]; resources: string[] }>): Promise<void> {
  const aggregated = aggregatePermissions(permissionItems);

  // Skip role creation if no permissions are declared
  if (aggregated.actions.length === 0) {
    console.log(`No permissions declared for app ${appId}, skipping scoped role creation`);
    return;
  }

  const policies: PolicyStatement[] = [{ actions: aggregated.actions, resources: aggregated.resources }];

  const { accountId } = await policyManager.getAccountContext();
  await policyManager.ensureRole(appId, policies, accountId, 'agent');
}

async function handleArchiveTransition(appId: string): Promise<void> {
  // 1. Delete the scoped IAM role
  await policyManager.deleteRole(appId, 'agent');

  // 2. Query GroupIndex for all AGENT# bindings and reset to DESIGN
  const result = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': `APP#${appId}` },
  }));

  const items = result.Items || [];
  const agentBindings = items.filter(i => i.sortId?.startsWith('AGENT#'));

  for (const binding of agentBindings) {
    await docClient.send(new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId: binding.appId || `${appId}#${binding.sortId}` },
      UpdateExpression: 'SET #status = :designStatus',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':designStatus': 'DESIGN',
      },
    }));
  }
}

async function updateApp(input: any, userId: string): Promise<any> {
  const existing = await getApp(input.appId, userId);
  if (!existing) {
    throw new Error('App not found');
  }

  // DRAFT → ACTIVE: run publish precondition checks
  if (input.status === 'ACTIVE' && existing.status === 'DRAFT') {
    const { errors: preconditionErrors, permissionItems } = await validatePublishPreconditions(input.appId);
    if (preconditionErrors.length > 0) {
      throw new Error(`Publish preconditions not met: ${preconditionErrors.join('; ')}`);
    }

    try {
      await ensurePublishRole(input.appId, permissionItems);
    } catch (error: any) {
      throw new Error(`PolicyManager failed to create scoped role: ${error.message}`);
    }
  }

  // ACTIVE → ARCHIVED: clean up scoped role and reset agent bindings
  if (input.status === 'ARCHIVED' && existing.status === 'ACTIVE') {
    await handleArchiveTransition(input.appId);
  }

  const now = new Date().toISOString();
  const updateExpression: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

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
  if (input.status !== undefined) {
    updateExpression.push('#status = :status');
    expressionAttributeNames['#status'] = 'status';
    expressionAttributeValues[':status'] = input.status;
  }
  if (input.routingConfig !== undefined) {
    updateExpression.push('#routingConfig = :routingConfig');
    expressionAttributeNames['#routingConfig'] = 'routingConfig';
    expressionAttributeValues[':routingConfig'] = input.routingConfig;
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
      TableName: APPS_TABLE,
      Key: { appId: input.appId },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ConditionExpression: 'version = :currentVersion',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    }));

    await emitEvent('app.updated', {
      appId: input.appId,
      userId,
      changes: input,
    });

    // Emit status-specific EventBridge event and AppSync subscription when status changes
    if (input.status !== undefined && input.status !== existing.status) {
      const previousStatus = existing.status.toLowerCase();
      const newStatus = input.status.toLowerCase();
      const timestamp = new Date().toISOString();
      const correlationId = uuidv4();

      await emitEvent(`app.status.${previousStatus}_to_${newStatus}`, {
        appId: input.appId,
        orgId: existing.orgId,
        previousStatus: existing.status,
        newStatus: input.status,
        userId,
        timestamp,
        correlationId,
      });

      // Best-effort AppSync subscription publish — failure is non-fatal
      try {
        await publishAppStatusEvent({
          appId: input.appId,
          previousStatus: existing.status,
          newStatus: input.status,
          timestamp,
        });
      } catch (err) {
        console.error('Failed to publish AppSync status event (non-fatal):', err);
      }
    }

    return result.Attributes;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: app was modified concurrently. Please retry.');
    }
    throw error;
  }
}

async function deleteApp(appId: string, userId: string): Promise<any> {
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Unbind all workflows first
  const workflowIds: string[] = app.workflowIds || [];
  for (const workflowId of workflowIds) {
    await docClient.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: 'SET #appId = :null',
      ExpressionAttributeNames: { '#appId': 'appId' },
      ExpressionAttributeValues: { ':null': null },
    }));
  }

  await docClient.send(new DeleteCommand({
    TableName: APPS_TABLE,
    Key: { appId },
  }));

  await emitEvent('app.deleted', {
    appId,
    orgId: app.orgId,
    userId,
  });

  return { success: true, message: `App ${appId} deleted` };
}

async function bindWorkflowToApp(appId: string, workflowId: string, userId: string): Promise<any> {
  // Get the app
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Get the workflow
  const workflowResult = await docClient.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));
  const workflow = workflowResult.Item;
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  // Verify same orgId
  if (workflow.orgId !== app.orgId) {
    throw new Error('Workflow and app must belong to the same organization');
  }

  // Reject if workflow already bound to a different app
  if (workflow.appId && workflow.appId !== appId) {
    throw new Error('Workflow is already bound to another app');
  }

  // Idempotent: if already bound to this app, return unchanged
  if (workflow.appId === appId && (app.workflowIds || []).includes(workflowId)) {
    return app;
  }

  // Append workflowId to app's workflowIds
  await docClient.send(new UpdateCommand({
    TableName: APPS_TABLE,
    Key: { appId },
    UpdateExpression: 'SET #workflowIds = list_append(if_not_exists(#workflowIds, :emptyList), :newWorkflowId)',
    ExpressionAttributeNames: { '#workflowIds': 'workflowIds' },
    ExpressionAttributeValues: {
      ':newWorkflowId': [workflowId],
      ':emptyList': [],
    },
  }));

  // Set workflow's appId
  await docClient.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
    UpdateExpression: 'SET #appId = :appId',
    ExpressionAttributeNames: { '#appId': 'appId' },
    ExpressionAttributeValues: { ':appId': appId },
  }));

  return { ...app, workflowIds: [...(app.workflowIds || []), workflowId] };
}

async function unbindWorkflowFromApp(appId: string, workflowId: string, userId: string): Promise<any> {
  // Get the app
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Get the workflow
  const workflowResult = await docClient.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));
  const workflow = workflowResult.Item;
  if (!workflow) {
    throw new Error('Workflow not found');
  }

  // Remove workflowId from app's workflowIds
  const updatedWorkflowIds = (app.workflowIds || []).filter((id: string) => id !== workflowId);
  await docClient.send(new UpdateCommand({
    TableName: APPS_TABLE,
    Key: { appId },
    UpdateExpression: 'SET #workflowIds = :workflowIds',
    ExpressionAttributeNames: { '#workflowIds': 'workflowIds' },
    ExpressionAttributeValues: { ':workflowIds': updatedWorkflowIds },
  }));

  // Clear workflow's appId
  await docClient.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
    UpdateExpression: 'SET #appId = :null',
    ExpressionAttributeNames: { '#appId': 'appId' },
    ExpressionAttributeValues: { ':null': null },
  }));

  return { ...app, workflowIds: updatedWorkflowIds };
}

// ─── Agent Binding Update ────────────────────────────────────

async function updateAgentBinding(
  input: {
    appId: string;
    agentId: string;
    systemPromptAddition?: string;
    toolRestrictions?: string[];
    modelOverride?: string;
    status?: string;
  },
  userId: string,
): Promise<any> {
  // Verify app exists and caller has access (org-scoped)
  const app = await getApp(input.appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Check binding exists by querying GroupIndex for AGENT#{agentId}
  const bindingQuery = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid AND sortId = :sid',
    ExpressionAttributeValues: {
      ':gid': deriveGroupId(input.appId),
      ':sid': deriveSortId('agent', input.agentId),
    },
  }));

  const existingBinding = bindingQuery.Items?.[0];
  if (!existingBinding) {
    throw new Error('Agent is not a component of this app');
  }

  // When status is being set to READY, validate agent exists with state=active
  if (input.status === 'READY') {
    const agentResult = await docClient.send(new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId: input.agentId },
    }));

    if (!agentResult.Item || agentResult.Item.state !== 'active') {
      throw new Error('Agent must be active before it can be marked as ready');
    }
  }

  // Build update expression for override fields
  const updateExprParts: string[] = [];
  const exprAttrNames: Record<string, string> = {};
  const exprAttrValues: Record<string, any> = {};

  if (input.systemPromptAddition !== undefined) {
    updateExprParts.push('#spa = :spa');
    exprAttrNames['#spa'] = 'systemPromptAddition';
    exprAttrValues[':spa'] = input.systemPromptAddition;
  }
  if (input.toolRestrictions !== undefined) {
    updateExprParts.push('#tr = :tr');
    exprAttrNames['#tr'] = 'toolRestrictions';
    exprAttrValues[':tr'] = input.toolRestrictions;
  }
  if (input.modelOverride !== undefined) {
    updateExprParts.push('#mo = :mo');
    exprAttrNames['#mo'] = 'modelOverride';
    exprAttrValues[':mo'] = input.modelOverride;
  }
  if (input.status !== undefined) {
    updateExprParts.push('#st = :st');
    exprAttrNames['#st'] = 'status';
    exprAttrValues[':st'] = input.status;
  }

  if (updateExprParts.length > 0) {
    const bindingSortId = deriveSortId('agent', input.agentId);
    await docClient.send(new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId: `${input.appId}#${bindingSortId}` },
      UpdateExpression: `SET ${updateExprParts.join(', ')}`,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
    }));
  }

  return getAppWithComponents(input.appId);
}

// ─── Component Management ────────────────────────────────────

async function addAppComponent(appId: string, component: { type: string; data: string }, userId: string): Promise<any> {
  // Verify app exists and caller has access
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  const data = typeof component.data === 'string' ? JSON.parse(component.data) : component.data;
  const now = new Date().toISOString();
  let componentItem: Record<string, any>;
  let componentId: string;

  switch (component.type) {
    case 'agent': {
      componentId = data.agentId;
      const agentSortId = deriveSortId('agent', data.agentId);
      componentItem = {
        appId: `${appId}#${agentSortId}`,
        groupId: deriveGroupId(appId),
        sortId: agentSortId,
        agentId: data.agentId,
        status: 'DESIGN',
        addedAt: now,
        ...(data.systemPromptAddition !== undefined && { systemPromptAddition: data.systemPromptAddition }),
        ...(data.toolRestrictions !== undefined && { toolRestrictions: data.toolRestrictions }),
        ...(data.modelOverride !== undefined && { modelOverride: data.modelOverride }),
      };
      break;
    }
    case 'permission': {
      // Validate IAM actions before storing
      const validation = validatePermissionActions(data.actions || []);
      if (!validation.valid) {
        throw new Error(`Permission validation failed: ${validation.errors.join('; ')}`);
      }

      componentId = data.permissionId;
      const permSortId = deriveSortId('permission', data.permissionId);
      componentItem = {
        appId: `${appId}#${permSortId}`,
        groupId: deriveGroupId(appId),
        sortId: permSortId,
        permissionId: data.permissionId,
        actions: data.actions,
        resources: data.resources,
        ...(data.description !== undefined && { description: data.description }),
      };
      break;
    }
    default:
      throw new Error(`Unsupported component type: ${component.type}`);
  }

  // Upsert: PutCommand overwrites existing items
  await docClient.send(new PutCommand({
    TableName: APPS_TABLE,
    Item: componentItem,
  }));

  await emitEvent('app.component.added', {
    appId,
    componentType: component.type,
    componentId,
    userId,
  });

  return getAppWithComponents(appId);
}

async function removeAppComponent(appId: string, componentType: string, componentId: string, userId: string): Promise<any> {
  // Verify app exists and caller has access (org-scoped check)
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  const sortId = deriveSortId(componentType, componentId);
  const groupId = deriveGroupId(appId);
  const componentAppId = `${appId}#${sortId}`;

  // Idempotent: DeleteCommand is a no-op if item doesn't exist
  await docClient.send(new DeleteCommand({
    TableName: APPS_TABLE,
    Key: { appId: componentAppId },
  })).catch((error: any) => {
    if (error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  });

  await emitEvent('app.component.removed', {
    appId,
    componentType,
    componentId,
    userId,
  });

  return getAppWithComponents(appId);
}

// ─── Permission Validation ────────────────────────────────────

export function validatePermissionActions(actions: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const action of actions) {
    if (action === '*') {
      errors.push('Bare wildcard (*) not allowed — must specify service prefix (e.g., s3:*)');
    } else if (!/^[a-zA-Z0-9-]+:[a-zA-Z0-9*]+$/.test(action)) {
      errors.push(`Invalid IAM action format: ${action}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function aggregatePermissions(
  permissionItems: Array<{ actions: string[]; resources: string[] }>,
): { actions: string[]; resources: string[] } {
  const actionsSet = new Set<string>();
  const resourcesSet = new Set<string>();
  for (const item of permissionItems) {
    for (const action of item.actions) actionsSet.add(action);
    for (const resource of item.resources) resourcesSet.add(resource);
  }
  return { actions: [...actionsSet], resources: [...resourcesSet] };
}

// ─── Component Table Pattern Helpers ─────────────────────────

const SORT_ID_PREFIXES: Record<string, string> = {
  agent: 'AGENT',
  permission: 'PERMISSION',
  config: 'CONFIG',
};

export function deriveSortId(type: string, id: string): string {
  const prefix = SORT_ID_PREFIXES[type];
  if (!prefix) {
    throw new Error(`Unknown component type: ${type}`);
  }
  return `${prefix}#${id}`;
}

export function deriveGroupId(appId: string): string {
  return `APP#${appId}`;
}

export async function getAppWithComponents(appId: string): Promise<any> {
  const result = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': `APP#${appId}` },
  }));

  const items = result.Items || [];
  const metadata = items.find(i => i.sortId === 'METADATA');

  if (!metadata) {
    return null;
  }

  const agentBindings = items.filter(i => i.sortId?.startsWith('AGENT#'));
  const permissions = items.filter(i => i.sortId?.startsWith('PERMISSION#'));
  const configSchema = items.find(i => i.sortId === 'CONFIG#schema');
  const configValues = items.find(i => i.sortId === 'CONFIG#values');

  return {
    ...metadata,
    agentBindings,
    permissions,
    configSchema: configSchema?.schema || null,
    configValues: configValues?.values || null,
  };
}

// ─── Config Schema Management ────────────────────────────────

async function setAppConfigSchema(appId: string, schemaStr: string, version: number, userId: string): Promise<any> {
  // Verify app exists and caller has access (org-scoped)
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Parse the AWSJSON schema string (may already be parsed by AppSync)
  const schema = typeof schemaStr === 'string' ? JSON.parse(schemaStr) : schemaStr;

  // Validate it's a valid JSON Schema draft-07 document
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('Invalid JSON Schema: schema must be a JSON object');
  }

  const ajv = new Ajv();
  const isValid = ajv.validateSchema(schema);
  if (!isValid) {
    const errors = ajv.errors?.map(e => e.message).join('; ') || 'unknown validation error';
    throw new Error(`Invalid JSON Schema: ${errors}`);
  }

  // Optimistic locking: increment version with condition check
  const now = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId },
      UpdateExpression: 'SET #version = :nextVersion, #updatedAt = :updatedAt',
      ConditionExpression: 'version = :currentVersion',
      ExpressionAttributeNames: {
        '#version': 'version',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':nextVersion': version + 1,
        ':currentVersion': version,
        ':updatedAt': now,
      },
      ReturnValues: 'ALL_NEW',
    }));
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: app was modified concurrently. Please retry.');
    }
    throw error;
  }

  // Store as CONFIG#schema component item
  const schemaSortId = deriveSortId('config', 'schema');
  await docClient.send(new PutCommand({
    TableName: APPS_TABLE,
    Item: {
      appId: `${appId}#${schemaSortId}`,
      groupId: deriveGroupId(appId),
      sortId: schemaSortId,
      schema,
    },
  }));

  return getAppWithComponents(appId);
}

async function setAppConfigValues(appId: string, valuesStr: string, version: number, userId: string): Promise<any> {
  // Verify app exists and caller has access (org-scoped)
  const app = await getApp(appId, userId);
  if (!app) {
    throw new Error('App not found');
  }

  // Parse the AWSJSON values string (may already be parsed by AppSync)
  const values = typeof valuesStr === 'string' ? JSON.parse(valuesStr) : valuesStr;

  // Load stored schema from GroupIndex
  const groupResult = await docClient.send(new QueryCommand({
    TableName: APPS_TABLE,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': deriveGroupId(appId) },
  }));

  const items = groupResult.Items || [];
  const configSchemaItem = items.find(i => i.sortId === 'CONFIG#schema');

  // If schema exists, validate values against it
  if (configSchemaItem?.schema) {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(configSchemaItem.schema);
    const valid = validate(values);

    if (!valid) {
      const errors = (validate.errors || []).map((e: any) => {
        const path = e.instancePath || (e.params?.missingProperty ? e.params.missingProperty : '');
        return `${path ? path + ': ' : ''}${e.message}`;
      }).join('; ');
      throw new Error(`Config validation failed: ${errors}`);
    }
  }

  // Optimistic locking: increment version with condition check
  const now = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId },
      UpdateExpression: 'SET #version = :nextVersion, #updatedAt = :updatedAt',
      ConditionExpression: 'version = :currentVersion',
      ExpressionAttributeNames: {
        '#version': 'version',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':nextVersion': version + 1,
        ':currentVersion': version,
        ':updatedAt': now,
      },
      ReturnValues: 'ALL_NEW',
    }));
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error('Conflict: app was modified concurrently. Please retry.');
    }
    throw error;
  }

  // Store as CONFIG#values component item
  const valuesSortId = 'CONFIG#values';
  await docClient.send(new PutCommand({
    TableName: APPS_TABLE,
    Item: {
      appId: `${appId}#${valuesSortId}`,
      groupId: deriveGroupId(appId),
      sortId: valuesSortId,
      values,
    },
  }));

  return getAppWithComponents(appId);
}

async function emitEvent(eventType: string, detail: any): Promise<void> {
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.apps',
        DetailType: eventType,
        Detail: JSON.stringify(detail),
        EventBusName: process.env.EVENT_BUS_NAME || EVENT_BUS_NAME,
      },
    ],
  }));
}
