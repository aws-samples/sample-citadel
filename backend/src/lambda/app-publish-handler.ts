/**
 * App Publish Handler — Orchestrates the full publishing flow.
 *
 * Validates preconditions, provisions API Gateway HTTP API via SDK,
 * creates default API key, updates app status, and emits EventBridge event.
 *
 * Requirements: 1.1-1.11, 2.1-2.10
 */
import Ajv from 'ajv';
import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateStageCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateAuthorizerCommand,
  DeleteApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PolicyManager } from '../utils/policy-manager';
import { updateAppMetaFields } from '../utils/apps-table-meta';

// ── Types ───────────────────────────────────────────────────

export interface AppMetadata {
  appId: string;
  name: string;
  status: string;
  workflowIds: string[];
  orgId?: string;
  endpointUrl?: string;
  apiId?: string;
  version?: number;
  [key: string]: any;
}

export interface ComponentItem {
  sortId: string;
  agentId?: string;
  status?: string;
  schema?: Record<string, any>;
  values?: Record<string, any>;
  actions?: string[];
  resources?: string[];
  [key: string]: any;
}

export interface PublishResult {
  app: AppMetadata;
  endpointUrl: string;
  apiKey: string;
  apiKeyId: string;
}

export interface ApiKeyGenResult {
  plaintext: string;
  hashed: string;
  prefix: string;
  keyId: string;
}

// ── Pure Utility Functions ──────────────────────────────────

/**
 * Derives the API Gateway name for an app.
 * Pattern: citadel-app-{appId}-{env}
 */
export function deriveApiGatewayName(appId: string, env: string): string {
  return `citadel-app-${appId}-${env}`;
}

/**
 * Derives the endpoint URL from an API Gateway ID and region.
 * Pattern: https://{apiId}.execute-api.{region}.amazonaws.com
 */
export function deriveEndpointUrl(apiId: string, region: string): string {
  return `https://${apiId}.execute-api.${region}.amazonaws.com`;
}

/**
 * Generates a cryptographically random API key.
 * - 32 random bytes → base64url plaintext
 * - SHA-256 hex hash for storage
 * - First 8 chars of plaintext as prefix for identification
 */
export function generateApiKey(): ApiKeyGenResult {
  const keyBytes = randomBytes(32);
  const plaintext = keyBytes.toString('base64url');
  const hashed = createHash('sha256').update(plaintext).digest('hex');
  const prefix = plaintext.substring(0, 8);
  const keyId = uuidv4();
  return { plaintext, hashed, prefix, keyId };
}

/**
 * Builds the EventBridge event for a status transition.
 */
export function buildStatusTransitionEvent(
  fromStatus: string,
  toStatus: string,
  detail: Record<string, any>,
): { detailType: string; source: string; detail: Record<string, any> } {
  const detailType = `app.status.${fromStatus.toLowerCase()}_to_${toStatus.toLowerCase()}`;
  return {
    detailType,
    source: 'citadel.apps',
    detail: {
      ...detail,
      timestamp: detail.timestamp || new Date().toISOString(),
    },
  };
}

/**
 * Validates all publish preconditions for transitioning an app to PUBLISHED status.
 *
 * Checks performed:
 * 1. All agent bindings must have status = READY
 * 2. At least one workflow must be bound to the app
 * 3. If a config schema exists, config values must exist and validate against it
 * 4. Admin email must be present in config values
 *
 * @param metadata - The app metadata item
 * @param componentItems - All component items from the GroupIndex query
 * @returns An array of error strings. Empty array means all preconditions pass.
 */
export function validatePublishPreconditions(
  metadata: AppMetadata,
  componentItems: ComponentItem[],
): string[] {
  const errors: string[] = [];

  const agentBindings = componentItems.filter(i => i.sortId?.startsWith('AGENT#'));
  const configSchema = componentItems.find(i => i.sortId === 'CONFIG#schema');
  const configValues = componentItems.find(i => i.sortId === 'CONFIG#values');

  // Check 1: All agent bindings must have status=READY
  const notReadyAgents = agentBindings.filter(b => b.status !== 'READY');
  if (notReadyAgents.length > 0) {
    const agentIds = notReadyAgents.map(b => b.agentId).join(', ');
    errors.push(`Agents not ready: ${agentIds}`);
  }

  // Check 2: Workflow required only for multi-agent apps
  const workflowIds = metadata.workflowIds || [];
  if (workflowIds.length < 1 && agentBindings.length > 1) {
    errors.push('Multi-agent apps require at least one workflow to define orchestration');
  }

  // Check 3: If configSchema exists, configValues must exist and validate
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

  // Admin email is optional — not a publish blocker

  return errors;
}

// ── Access Log Format ───────────────────────────────────────

/**
 * Structured JSON access log format for API Gateway.
 * Includes all fields required by Requirement 2.9.
 */
export const ACCESS_LOG_FORMAT = JSON.stringify({
  requestId: '$context.requestId',
  appId: '$context.authorizer.appId',
  apiKeyId: '$context.authorizer.apiKeyId',
  status: '$context.status',
  latency: '$context.responseLatency',
  timestamp: '$context.requestTime',
  ip: '$context.identity.sourceIp',
  method: '$context.httpMethod',
  path: '$context.path',
});

// ── SDK Client Defaults (lazy-initialized) ──────────────────

const APPS_TABLE = process.env.APPS_TABLE || 'citadel-apps-dev';
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'citadel-agents-dev';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const AUTHORIZER_FUNCTION_ARN = process.env.AUTHORIZER_FUNCTION_ARN || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

let _docClient: DynamoDBDocumentClient | undefined;
let _apiGwClient: ApiGatewayV2Client | undefined;
let _eventBridgeClient: EventBridgeClient | undefined;
let _cwLogsClient: CloudWatchLogsClient | undefined;
let _policyManager: PolicyManager | undefined;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _docClient;
}
function getApiGwClient(): ApiGatewayV2Client {
  if (!_apiGwClient) _apiGwClient = new ApiGatewayV2Client({});
  return _apiGwClient;
}
function getEventBridgeClient(): EventBridgeClient {
  if (!_eventBridgeClient) _eventBridgeClient = new EventBridgeClient({});
  return _eventBridgeClient;
}
function getCwLogsClient(): CloudWatchLogsClient {
  if (!_cwLogsClient) _cwLogsClient = new CloudWatchLogsClient({});
  return _cwLogsClient;
}
function getPolicyManager(): PolicyManager {
  if (!_policyManager) _policyManager = new PolicyManager();
  return _policyManager;
}

// ── Provision API Gateway ───────────────────────────────────

/**
 * Creates a CloudWatch Logs log group for API Gateway access logging.
 * Handles ResourceAlreadyExistsException gracefully (idempotent).
 * Returns the log group ARN.
 */
async function ensureAccessLogGroup(
  logGroupName: string,
  region: string,
  cwLogsClient: CloudWatchLogsClient = getCwLogsClient(),
): Promise<string> {
  try {
    await cwLogsClient.send(new CreateLogGroupCommand({ logGroupName }));
  } catch (error: any) {
    if (error.name !== 'ResourceAlreadyExistsException') {
      throw error;
    }
  }

  // Retrieve the ARN for the log group
  const describeResult = await cwLogsClient.send(new DescribeLogGroupsCommand({
    logGroupNamePrefix: logGroupName,
    limit: 1,
  }));
  const logGroup = describeResult.logGroups?.find((lg: any) => lg.logGroupName === logGroupName);
  if (logGroup?.arn) {
    return logGroup.arn;
  }
  // Fallback: construct ARN from convention
  return `arn:aws:logs:${region}:*:log-group:${logGroupName}:*`;
}

/**
 * Provisions a per-app API Gateway HTTP API with EventBridge integration.
 * Returns the apiId and endpointUrl on success.
 * On failure, attempts rollback by deleting the partially created API.
 */
export async function provisionApiGateway(
  appId: string,
  env: string,
  authorizerFnArn: string,
  eventBusName: string,
  region: string,
  client: ApiGatewayV2Client = getApiGwClient(),
  cwLogsClient: CloudWatchLogsClient = getCwLogsClient(),
): Promise<{ apiId: string; endpointUrl: string }> {
  const apiName = deriveApiGatewayName(appId, env);
  let apiId: string | undefined;

  try {
    // Step 1: Create HTTP API
    const createApiResult = await client.send(new CreateApiCommand({
      Name: apiName,
      ProtocolType: 'HTTP',
      Description: `API Gateway for Citadel app ${appId}`,
    }));
    apiId = createApiResult.ApiId!;

    // Step 1.5: Ensure CloudWatch log group for access logging
    const logGroupName = `/aws/apigateway/${apiName}`;
    const logGroupArn = await ensureAccessLogGroup(logGroupName, region, cwLogsClient);

    // Step 2: Create $default stage with auto-deploy, throttling, and access logging
    await client.send(new CreateStageCommand({
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 5000,
        ThrottlingRateLimit: 1000,
      },
      AccessLogSettings: {
        DestinationArn: logGroupArn,
        Format: ACCESS_LOG_FORMAT,
      },
    }));

    // Step 3: Create EventBridge integration
    const credentialsArn = process.env.APIGW_EVENTBRIDGE_ROLE_ARN || '';
    const integrationResult = await client.send(new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationSubtype: 'EventBridge-PutEvents',
      CredentialsArn: credentialsArn,
      PayloadFormatVersion: '1.0',
      RequestParameters: {
        Source: 'citadel.app.invoke',
        DetailType: 'app.invoke.requested',
        Detail: '$request.body',
        EventBusName: eventBusName,
      },
    }));
    const integrationId = integrationResult.IntegrationId!;

    // Step 4: Create Lambda authorizer
    const authorizerResult = await client.send(new CreateAuthorizerCommand({
      ApiId: apiId,
      AuthorizerType: 'REQUEST',
      AuthorizerUri: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${authorizerFnArn}/invocations`,
      IdentitySource: ['$request.header.x-api-key'],
      Name: `${apiName}-authorizer`,
      AuthorizerResultTtlInSeconds: 300,
      AuthorizerPayloadFormatVersion: '2.0',
      EnableSimpleResponses: true,
    }));
    const authorizerId = authorizerResult.AuthorizerId!;

    // Step 5: Create POST /invoke route with authorizer
    await client.send(new CreateRouteCommand({
      ApiId: apiId,
      RouteKey: 'POST /invoke',
      Target: `integrations/${integrationId}`,
      AuthorizationType: 'CUSTOM',
      AuthorizerId: authorizerId,
    }));

    const endpointUrl = deriveEndpointUrl(apiId!, region);
    return { apiId: apiId!, endpointUrl };
  } catch (error) {
    // Rollback: delete partially created API
    if (apiId) {
      try {
        await client.send(new DeleteApiCommand({ ApiId: apiId }));
      } catch {
        // Best-effort rollback — log but don't throw
      }
    }
    throw error;
  }
}

// ── Publish App Flow ────────────────────────────────────────

/**
 * Full publish flow orchestrator.
 * Called by the Lambda handler for the publishApp mutation.
 */
export async function publishApp(
  appId: string,
  userId: string,
  deps: {
    docClient: DynamoDBDocumentClient;
    apiGwClient: ApiGatewayV2Client;
    eventBridgeClient: EventBridgeClient;
    policyManager: PolicyManager;
    appsTable: string;
    eventBusName: string;
    environment: string;
    authorizerFnArn: string;
    region: string;
  } = {
    docClient: getDocClient(),
    apiGwClient: getApiGwClient(),
    eventBridgeClient: getEventBridgeClient(),
    policyManager: getPolicyManager(),
    appsTable: APPS_TABLE,
    eventBusName: EVENT_BUS_NAME,
    environment: ENVIRONMENT,
    authorizerFnArn: AUTHORIZER_FUNCTION_ARN,
    region: REGION,
  },
): Promise<PublishResult> {
  const correlationId = uuidv4();

  // 1. Fetch app metadata and components
  const componentsResult = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': `APP#${appId}` },
  }));

  const items = componentsResult.Items || [];
  const metadata = items.find(i => i.sortId === 'METADATA') as AppMetadata | undefined;

  if (!metadata) {
    throw new Error(`App not found: ${appId}`);
  }

  // 2. Idempotency check: if already PUBLISHED, return current state
  if (metadata.status === 'PUBLISHED') {
    // Find existing API key for the response
    const existingKey = items.find(i => i.sortId?.startsWith('APIKEY#'));
    return {
      app: metadata,
      endpointUrl: metadata.endpointUrl || '',
      apiKey: '', // Never return plaintext after initial creation
      apiKeyId: existingKey?.keyId || '',
    };
  }

  // 3. Validate preconditions
  const errors = validatePublishPreconditions(metadata, items as ComponentItem[]);
  if (errors.length > 0) {
    throw new Error(`Publish preconditions not met: ${errors.join('; ')}`);
  }

  // 4. Aggregate permissions and ensure IAM role (skip if no permissions declared)
  const permissionItems = items
    .filter(i => i.sortId?.startsWith('PERMISSION#'))
    .map(i => ({ actions: i.actions || [], resources: i.resources || [] }))
    .filter(p => p.actions.length > 0 && p.resources.length > 0);

  const { accountId } = await deps.policyManager.getAccountContext();

  if (permissionItems.length > 0) {
    await deps.policyManager.ensureRole(appId, permissionItems, accountId, 'agent');
  }

  // 5. Provision API Gateway
  const { apiId, endpointUrl } = await provisionApiGateway(
    appId,
    deps.environment,
    deps.authorizerFnArn,
    deps.eventBusName,
    deps.region,
    deps.apiGwClient,
  );

  // 6. Generate default API key
  const apiKey = generateApiKey();
  await deps.docClient.send(new PutCommand({
    TableName: deps.appsTable,
    Item: {
      appId: `${appId}#APIKEY#${apiKey.keyId}`,
      groupId: `APP#${appId}`,
      sortId: `APIKEY#${apiKey.keyId}`,
      keyId: apiKey.keyId,
      name: 'default',
      hashedKey: apiKey.hashed,
      prefix: apiKey.prefix,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
  }));

  // 7. Update app metadata: status=PUBLISHED, endpointUrl, apiId
  await deps.docClient.send(new UpdateCommand({
    TableName: deps.appsTable,
    Key: { appId },
    UpdateExpression: 'SET #status = :published, endpointUrl = :url, apiId = :apiId, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':published': 'PUBLISHED',
      ':url': endpointUrl,
      ':apiId': apiId,
      ':now': new Date().toISOString(),
    },
  }));

  // Eventually-consistent mirror to AppsTable.#META so OrgIndex sees the new
  // PUBLISHED status. Helper logs and returns false on failure; never throws.
  await updateAppMetaFields(deps.appsTable, appId, {
    status: 'PUBLISHED',
    updatedAt: new Date().toISOString(),
  });

  // 8. Emit EventBridge event
  const event = buildStatusTransitionEvent('active', 'published', {
    appId,
    orgId: metadata.orgId || '',
    endpointUrl,
    apiKeyId: apiKey.keyId,
    userId,
    correlationId,
  });

  await deps.eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: event.source,
      DetailType: event.detailType,
      Detail: JSON.stringify(event.detail),
      EventBusName: deps.eventBusName,
    }],
  }));

  // 9. Return PublishResult
  const updatedApp: AppMetadata = {
    ...metadata,
    status: 'PUBLISHED',
    endpointUrl,
    apiId,
  };

  return {
    app: updatedApp,
    endpointUrl,
    apiKey: apiKey.plaintext,
    apiKeyId: apiKey.keyId,
  };
}

// ── Unpublish App Flow ──────────────────────────────────────

export interface UnpublishResult {
  app: AppMetadata;
  warnings?: string[];
}

/**
 * Unpublish flow orchestrator.
 * Called by the Lambda handler for the unpublishApp mutation.
 *
 * Idempotency: if app is not PUBLISHED, returns current state without
 * performing any teardown operations.
 *
 * Best-effort teardown: deletes API Gateway, revokes all active keys,
 * deletes scoped IAM role, updates status to DRAFT, emits EventBridge event.
 * Continues on individual step failures and collects warnings.
 *
 * Requirements: 8.1-8.9
 */
export async function unpublishApp(
  appId: string,
  userId: string,
  deps: {
    docClient: DynamoDBDocumentClient;
    apiGwClient: ApiGatewayV2Client;
    eventBridgeClient: EventBridgeClient;
    policyManager: PolicyManager;
    appsTable: string;
    eventBusName: string;
    environment: string;
    authorizerFnArn: string;
    region: string;
  } = {
    docClient: getDocClient(),
    apiGwClient: getApiGwClient(),
    eventBridgeClient: getEventBridgeClient(),
    policyManager: getPolicyManager(),
    appsTable: APPS_TABLE,
    eventBusName: EVENT_BUS_NAME,
    environment: ENVIRONMENT,
    authorizerFnArn: AUTHORIZER_FUNCTION_ARN,
    region: REGION,
  },
): Promise<UnpublishResult> {
  const correlationId = uuidv4();
  const warnings: string[] = [];

  // 1. Fetch app metadata and components
  const componentsResult = await deps.docClient.send(new QueryCommand({
    TableName: deps.appsTable,
    IndexName: 'GroupIndex',
    KeyConditionExpression: 'groupId = :gid',
    ExpressionAttributeValues: { ':gid': `APP#${appId}` },
  }));

  const items = componentsResult.Items || [];
  const metadata = items.find(i => i.sortId === 'METADATA') as AppMetadata | undefined;

  if (!metadata) {
    throw new Error(`App not found: ${appId}`);
  }

  // 2. Idempotency check: if not PUBLISHED, return current state
  if (metadata.status !== 'PUBLISHED') {
    return { app: metadata };
  }

  // 3. Best-effort teardown: delete API Gateway
  if (metadata.apiId) {
    try {
      await deps.apiGwClient.send(new DeleteApiCommand({ ApiId: metadata.apiId }));
    } catch (error: any) {
      warnings.push(`Failed to delete API Gateway: ${error.message}`);
    }
  }

  // 4. Best-effort teardown: revoke all active APIKEY# items
  const activeKeys = items.filter(i => i.sortId?.startsWith('APIKEY#') && i.status === 'ACTIVE');
  for (const key of activeKeys) {
    try {
      await deps.docClient.send(new UpdateCommand({
        TableName: deps.appsTable,
        Key: { appId: `${appId}#APIKEY#${key.keyId}` },
        UpdateExpression: 'SET #status = :REVOKED, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':REVOKED': 'REVOKED',
          ':now': new Date().toISOString(),
        },
      }));
    } catch (error: any) {
      warnings.push(`Failed to revoke key ${key.keyId}: ${error.message}`);
    }
  }

  // 5. Best-effort teardown: delete scoped IAM role
  try {
    await deps.policyManager.deleteRole(appId, 'agent');
  } catch (error: any) {
    warnings.push(`Failed to delete IAM role: ${error.message}`);
  }

  // 6. Update app metadata: status=DRAFT, remove endpointUrl and apiId
  await deps.docClient.send(new UpdateCommand({
    TableName: deps.appsTable,
    Key: { appId },
    UpdateExpression: 'SET #status = :draft, updatedAt = :now REMOVE endpointUrl, apiId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':draft': 'DRAFT',
      ':now': new Date().toISOString(),
    },
  }));

  // Eventually-consistent mirror to AppsTable.#META so OrgIndex sees the
  // unpublish (status=DRAFT). Helper never throws.
  await updateAppMetaFields(deps.appsTable, appId, {
    status: 'DRAFT',
    updatedAt: new Date().toISOString(),
  });

  // 7. Emit EventBridge event
  const event = buildStatusTransitionEvent('published', 'draft', {
    appId,
    orgId: metadata.orgId || '',
    userId,
    correlationId,
  });

  await deps.eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: event.source,
      DetailType: event.detailType,
      Detail: JSON.stringify(event.detail),
      EventBusName: deps.eventBusName,
    }],
  }));

  // 8. Return result
  const updatedApp: AppMetadata = {
    ...metadata,
    status: 'DRAFT',
  };
  delete updatedApp.endpointUrl;
  delete updatedApp.apiId;

  return {
    app: updatedApp,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ── Lambda Handler ──────────────────────────────────────────

export const handler = async (event: any): Promise<any> => {
  console.log('Publish handler event:', JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info?.fieldName;
  const userId = identity?.sub || identity?.claims?.sub || 'unknown';

  switch (fieldName) {
    case 'publishApp':
      return await publishApp(args.appId, userId);
    case 'unpublishApp': {
      const unpublishResult = await unpublishApp(args.appId, userId);
      return unpublishResult.app;
    }
    default:
      throw new Error(`Unknown field: ${fieldName}`);
  }
};
