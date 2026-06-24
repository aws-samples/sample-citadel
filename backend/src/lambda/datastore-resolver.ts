import { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from './adapters/registry';
import { PolicyManager } from '../utils/policy-manager';
import { getDataStoreOperations } from '../utils/operations-registry';
import {
  ConflictError,
  ResourceNotFoundError,
  ValidationError,
} from './adapters/errors';

// --- Clients ---

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsManager = new SecretsManagerClient({});
const policyManager = new PolicyManager();

const DATASTORES_TABLE = process.env.DATASTORES_TABLE!;
const HEALTH_MONITOR_ROLE_PARAM = process.env.HEALTH_MONITOR_ROLE_PARAM || '';

// Lazy-loaded health monitor role ARN from SSM
let _healthMonitorRoleArn: string | null = null;
async function getAdditionalTrustedPrincipals(): Promise<string[]> {
  if (!HEALTH_MONITOR_ROLE_PARAM) return [];
  if (_healthMonitorRoleArn !== null) return _healthMonitorRoleArn ? [_healthMonitorRoleArn] : [];
  try {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    const result = await ssm.send(new GetParameterCommand({ Name: HEALTH_MONITOR_ROLE_PARAM }));
    _healthMonitorRoleArn = result.Parameter?.Value || '';
  } catch {
    _healthMonitorRoleArn = '';
  }
  return _healthMonitorRoleArn ? [_healthMonitorRoleArn] : [];
}

// --- Types ---

interface AppSyncEventIdentity {
  username?: string;
  sub?: string;
}

interface AppSyncEvent extends Omit<AppSyncResolverEvent<any>, 'identity'> {
  identity?: AppSyncEventIdentity;
}

// --- Handler ---

export async function handler(event: AppSyncEvent) {
  const sanitizedEvent = {
    ...event,
    arguments: event.arguments
      ? {
          ...event.arguments,
          input: event.arguments.input
            ? {
                ...event.arguments.input,
                credentials: event.arguments.input.credentials
                  ? '[REDACTED]'
                  : undefined,
              }
            : undefined,
        }
      : undefined,
  };
  console.log(
    'DataStore resolver event:',
    JSON.stringify(sanitizedEvent, null, 2)
  );

  const { fieldName } = event.info;

  try {
    switch (fieldName) {
      case 'listDataStores':
        return await listDataStores(
          event.arguments.orgId,
          event.arguments.category
        );
      case 'getDataStore':
        return await getDataStore(event.arguments.dataStoreId);
      case 'getDataStoreStats':
        return await getDataStoreStats(event.arguments.orgId);
      case 'createDataStore':
        return await createDataStore(
          event.arguments.input,
          event.identity?.username || 'system'
        );
      case 'updateDataStore':
        return await updateDataStore(event.arguments.input);
      case 'deleteDataStore':
        return await deleteDataStore(event.arguments.dataStoreId);
      case 'connectDataStore':
        return await connectDataStore(event.arguments.dataStoreId);
      case 'disconnectDataStore':
        return await disconnectDataStore(event.arguments.dataStoreId);
      case 'testDataStoreConnection':
        return await testDataStoreConnection(event.arguments.dataStoreId);
      case 'listAvailableDataSources':
        return await listAvailableDataSources(
          event.arguments.orgId,
          event.arguments.usage
        );
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: any) {
    console.error('DataStore resolver error:', error);
    throw error;
  }
}

// --- Helpers ---

async function persistErrorState(
  dataStoreId: string,
  _error: unknown
): Promise<void> {
  try {
    // Clean up the failed entry so stale records don't accumulate in the UI
    await dynamodb.send(
      new DeleteCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
      })
    );
  } catch (persistError) {
    console.error('Failed to clean up failed data store entry:', persistError);
  }
}

async function retryOptimisticLock<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (
        error.name === 'ConditionalCheckFailedException' ||
        error instanceof ConflictError
      ) {
        lastError = error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
  throw new ConflictError(
    'Version conflict: data store was modified concurrently',
    lastError
  );
}

// --- Queries ---

async function listDataStores(orgId: string, category?: string) {
  const params: any = {
    TableName: DATASTORES_TABLE,
    IndexName: 'OrgIndex',
    KeyConditionExpression: 'orgId = :orgId',
    ExpressionAttributeValues: { ':orgId': orgId } as Record<string, any>,
    ScanIndexForward: false,
  };

  if (category) {
    params.FilterExpression = 'category = :category';
    params.ExpressionAttributeValues[':category'] = category;
  }

  const result = await dynamodb.send(new QueryCommand(params));
  // Backward compatibility: default usage to 'both' for legacy items (Req 1.10)
  const items = result.Items || [];
  for (const item of items) {
    item.usage = (item.usage || 'both').toUpperCase();
  }
  return items;
}

async function getDataStore(dataStoreId: string) {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: DATASTORES_TABLE,
      Key: { dataStoreId },
    })
  );

  if (!result.Item) {
    throw new ResourceNotFoundError(
      `Data store not found: ${dataStoreId}`
    );
  }

  // Backward compatibility: default usage to 'both' for legacy items (Req 1.10)
  const item = result.Item;
  item.usage = (item.usage || 'both').toUpperCase();

  return item;
}

async function getDataStoreStats(orgId: string) {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: DATASTORES_TABLE,
      IndexName: 'OrgIndex',
      KeyConditionExpression: 'orgId = :orgId',
      ExpressionAttributeValues: { ':orgId': orgId },
    })
  );

  const items = result.Items || [];
  const byCategory: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let connected = 0;
  let errorCount = 0;

  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    byType[item.type] = (byType[item.type] || 0) + 1;
    if (item.status === 'CONNECTED') connected++;
    if (item.status === 'ERROR') errorCount++;
  }

  return {
    total: items.length,
    connected,
    error: errorCount,
    byCategory: JSON.stringify(byCategory),
    byType: JSON.stringify(byType),
  };
}

async function listAvailableDataSources(orgId: string, usage?: string) {
  // Query all data stores for the org
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: DATASTORES_TABLE,
      IndexName: 'OrgIndex',
      KeyConditionExpression: 'orgId = :orgId',
      ExpressionAttributeValues: { ':orgId': orgId },
    })
  );

  const items = result.Items || [];

  // Filter to only CONNECTED stores (Req 3.7)
  let connectedStores = items.filter((item) => item.status === 'CONNECTED');

  // Apply usage filter when provided (Req 3.5)
  if (usage) {
    const filterUpper = usage.toUpperCase();
    if (filterUpper !== 'BOTH') {
      connectedStores = connectedStores.filter((item) => {
        const storeUsage = (item.usage || 'BOTH').toUpperCase();
        return storeUsage === filterUpper || storeUsage === 'BOTH';
      });
    }
    // When filter is 'both', return all connected stores (no additional filtering)
  }

  // Get account context for scopedRoleArn computation
  let accountId: string | null = null;
  try {
    const ctx = await policyManager.getAccountContext();
    accountId = ctx.accountId;
  } catch (error) {
    console.warn('Failed to get account context for scopedRoleArn:', error);
  }

  // Enrich each store with capabilities and scopedRoleArn (Req 3.3, 3.4)
  return connectedStores.map((item) => ({
    dataStoreId: item.dataStoreId,
    name: item.name,
    type: item.type,
    category: item.category,
    usage: (item.usage || 'BOTH').toUpperCase(),
    status: item.status,
    provider: item.provider,
    capabilities: getDataStoreOperations(item.type),
    scopedRoleArn: accountId
      ? `arn:aws:iam::${accountId}:role/citadel-ds-${item.dataStoreId}`
      : null,
  }));
}

// --- Mutations ---

async function createDataStore(input: any, createdBy: string) {
  const dataStoreId = uuidv4();
  const timestamp = new Date().toISOString();

  // Check for idempotent creation via clientRequestToken
  if (input.clientRequestToken) {
    const existingResult = await dynamodb.send(
      new QueryCommand({
        TableName: DATASTORES_TABLE,
        IndexName: 'OrgIndex',
        KeyConditionExpression: 'orgId = :orgId',
        FilterExpression: 'clientRequestToken = :token',
        ExpressionAttributeValues: {
          ':orgId': input.orgId,
          ':token': input.clientRequestToken,
        },
      })
    );

    if (existingResult.Items && existingResult.Items.length > 0) {
      return existingResult.Items[0];
    }
  }

  const adapter = getAdapter(input.type);
  const config =
    typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  // Inject the data store name into config so adapters can use it as the
  // resource name. This bridges the gap between the frontend wizard (which
  // sends a separate `name` field) and adapters (which read from config).
  if (!config.name && input.name) {
    config.name = input.name;
  }

  const credentials = input.credentials
    ? typeof input.credentials === 'string'
      ? JSON.parse(input.credentials)
      : input.credentials
    : undefined;

  // Determine icon and provider from type metadata
  const icon = 'Database';
  const provider = input.type.startsWith('EXTERNAL_')
    ? 'External'
    : 'Amazon Web Services';

  // Validate and default usage field (defense in depth — Req 10.2)
  const VALID_USAGE_VALUES = ['KNOWLEDGE', 'OPERATIONAL', 'BOTH'];
  const usage = input.usage ? input.usage.toUpperCase() : 'BOTH';
  if (!VALID_USAGE_VALUES.includes(usage)) {
    throw new ValidationError(
      `Invalid usage value: ${input.usage}. Allowed values: KNOWLEDGE, OPERATIONAL, BOTH`
    );
  }

  // Conditional PutItem to prevent duplicate dataStoreId
  const item: Record<string, any> = {
    dataStoreId,
    name: input.name,
    description: input.description || null,
    type: input.type,
    category: input.category,
    status: 'CREATED',
    icon,
    provider,
    provisionMode: input.provisionMode,
    orgId: input.orgId,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    config: typeof config === 'string' ? config : JSON.stringify(config),
    usage,
    version: 1,
    clientRequestToken: input.clientRequestToken || null,
  };

  try {
    await dynamodb.send(
      new PutCommand({
        TableName: DATASTORES_TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(dataStoreId)',
      })
    );
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new ConflictError(
        `Data store with ID ${dataStoreId} already exists`
      );
    }
    throw error;
  }

  try {
    // Store credentials in Secrets Manager
    let secretArn: string | undefined;
    if (credentials) {
      const secretName = `/citadel/datastores/${input.orgId}/${input.type.toLowerCase()}-${dataStoreId}`;
      const createSecretResponse = await secretsManager.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: JSON.stringify(credentials),
        })
      );
      secretArn = createSecretResponse.ARN;
    }

    // Get account context and set up IAM role
    const { accountId, region } = await policyManager.getAccountContext();
    const policies =
      input.provisionMode === 'CREATE_NEW'
        ? adapter.requiredPolicies(config, accountId, region).provision
        : adapter.requiredPolicies(config, accountId, region).connect;

    let scopedCredentials: Record<string, any> | undefined;
    if (policies.length > 0) {
      await policyManager.ensureRole(
        dataStoreId,
        policies,
        accountId,
        'datastore',
        config.crossAccountRoleArn,
        await getAdditionalTrustedPrincipals()
      );
      // IAM is eventually consistent — wait for role/policy propagation
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const creds = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        'datastore',
        config.crossAccountRoleArn
      );
      scopedCredentials = creds;
    }

    // Dispatch to adapter
    let resourceArn: string | undefined;
    let size: string | undefined;
    let records: number | undefined;

    if (input.provisionMode === 'CREATE_NEW') {
      // Update status to PROVISIONING
      await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression: 'SET #status = :status, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'PROVISIONING',
            ':now': new Date().toISOString(),
          },
        })
      );

      const provisionResult = await adapter.provision!(
        config,
        scopedCredentials || credentials
      );
      resourceArn = provisionResult.resourceArn;
      size = provisionResult.size;
      records = provisionResult.records;
    } else {
      await adapter.connect(config, scopedCredentials || credentials);
    }

    // Get metrics (use scoped credentials if available)
    try {
      const metrics = await adapter.getMetrics!(config, resourceArn);
      size = size || metrics.size;
      records = records ?? metrics.records;
    } catch (metricsError) {
      console.warn('Failed to get metrics (non-fatal):', metricsError);
    }

    // Update final state
    const finalUpdate = await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression:
          'SET #status = :status, updatedAt = :now, resourceArn = :arn, secretArn = :secret, #size = :size, records = :records',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#size': 'size',
        },
        ExpressionAttributeValues: {
          ':status': 'CONNECTED',
          ':now': new Date().toISOString(),
          ':arn': resourceArn || null,
          ':secret': secretArn || null,
          ':size': size || null,
          ':records': records ?? null,
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    return finalUpdate.Attributes;
  } catch (error) {
    await persistErrorState(dataStoreId, error);
    throw error;
  }
}

async function updateDataStore(input: any) {
  const dataStoreId = input.dataStoreId;
  const existing = await getDataStore(dataStoreId);

  // Optimistic locking
  if (existing.version !== input.version) {
    throw new ConflictError(
      `Version conflict: expected ${input.version}, found ${existing.version}`
    );
  }

  const updates: Record<string, any> = {
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  };

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.config !== undefined) {
    updates.config =
      typeof input.config === 'string'
        ? input.config
        : JSON.stringify(input.config);
  }
  if (input.usage !== undefined) {
    // Validate usage field (defense in depth — Req 10.2)
    const VALID_USAGE_VALUES = ['KNOWLEDGE', 'OPERATIONAL', 'BOTH'];
    const usageValue = input.usage.toUpperCase();
    if (!VALID_USAGE_VALUES.includes(usageValue)) {
      throw new ValidationError(
        `Invalid usage value: ${input.usage}. Allowed values: KNOWLEDGE, OPERATIONAL, BOTH`
      );
    }
    updates.usage = usageValue;
  }

  const setExpressions: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, any> = {};

  for (const [key, value] of Object.entries(updates)) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    setExpressions.push(`${nameKey} = ${valueKey}`);
    exprNames[nameKey] = key;
    exprValues[valueKey] = value;
  }

  exprValues[':expectedVersion'] = input.version;

  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: DATASTORES_TABLE,
        Key: { dataStoreId },
        UpdateExpression: `SET ${setExpressions.join(', ')}`,
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { ...exprNames, '#version': 'version' },
        ExpressionAttributeValues: exprValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    return result.Attributes;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new ConflictError(
        'Version conflict: data store was modified concurrently'
      );
    }
    await persistErrorState(dataStoreId, error);
    throw error;
  }
}

async function deleteDataStore(dataStoreId: string) {
  let existing: Record<string, any> | undefined;

  try {
    existing = await getDataStore(dataStoreId);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      return { success: true, message: 'Data store not found or already deleted' };
    }
    throw error;
  }

  const adapter = getAdapter(existing.type);
  const config =
    typeof existing.config === 'string'
      ? JSON.parse(existing.config)
      : existing.config;

  // Get scoped credentials for infrastructure cleanup
  let scopedCredentials: Record<string, any> | undefined;
  try {
    const { accountId } = await policyManager.getAccountContext();
    scopedCredentials = await policyManager.assumeScopedRole(
      dataStoreId,
      accountId,
      'datastore'
    );
  } catch (error) {
    console.warn('Failed to assume scoped role for cleanup:', error);
  }

  // Disconnect first
  try {
    await adapter.disconnect(config);
  } catch (error) {
    console.warn('Failed to disconnect:', error);
  }

  // Deprovision infrastructure if this was a CREATE_NEW data store
  if (existing.provisionMode === 'CREATE_NEW' && adapter.deprovision) {
    try {
      await adapter.deprovision(config, scopedCredentials);
    } catch (error) {
      console.warn('Failed to deprovision infrastructure:', error);
    }
  }

  // Delete secret from Secrets Manager
  if (existing.secretArn) {
    try {
      await secretsManager.send(
        new DeleteSecretCommand({
          SecretId: existing.secretArn,
          ForceDeleteWithoutRecovery: true,
        })
      );
    } catch (error) {
      console.warn('Failed to delete secret:', error);
    }
  }

  // Delete IAM role
  try {
    await policyManager.deleteRole(dataStoreId);
  } catch (error) {
    console.warn('Failed to delete IAM role:', error);
  }

  // Delete from DynamoDB
  await dynamodb.send(
    new DeleteCommand({
      TableName: DATASTORES_TABLE,
      Key: { dataStoreId },
    })
  );

  return { success: true, message: 'Data store deleted successfully' };
}

async function connectDataStore(dataStoreId: string) {
  return retryOptimisticLock(async () => {
    const existing = await getDataStore(dataStoreId);
    const currentVersion = existing.version;

    const adapter = getAdapter(existing.type);
    const config =
      typeof existing.config === 'string'
        ? JSON.parse(existing.config)
        : existing.config;

    // Retrieve credentials from Secrets Manager if available
    let credentials: Record<string, any> | undefined;
    if (existing.secretArn) {
      try {
        const secretResult = await secretsManager.send(
          new GetSecretValueCommand({ SecretId: existing.secretArn })
        );
        credentials = JSON.parse(secretResult.SecretString || '{}');
      } catch (error) {
        console.warn('Failed to retrieve credentials:', error);
      }
    }

    // Set up scoped credentials if needed
    const { accountId, region } = await policyManager.getAccountContext();
    const policies = adapter.requiredPolicies(config, accountId, region).connect;
    let scopedCredentials: Record<string, any> | undefined;

    if (policies.length > 0) {
      await policyManager.ensureRole(
        dataStoreId,
        policies,
        accountId,
        'datastore',
        config.crossAccountRoleArn,
        await getAdditionalTrustedPrincipals()
      );
      // IAM is eventually consistent — wait for policy propagation
      await new Promise((resolve) => setTimeout(resolve, 5000));
      scopedCredentials = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        'datastore',
        config.crossAccountRoleArn
      );
    }

    try {
      await adapter.connect(config, scopedCredentials || credentials);
    } catch (error) {
      await persistErrorState(dataStoreId, error);
      throw error;
    }

    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression:
            'SET #status = :status, updatedAt = :now, #version = :newVersion REMOVE errorMessage',
          ConditionExpression: '#version = :expectedVersion',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':status': 'CONNECTED',
            ':now': new Date().toISOString(),
            ':newVersion': currentVersion + 1,
            ':expectedVersion': currentVersion,
          },
          ReturnValues: 'ALL_NEW',
        })
      );

      return result.Attributes;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new ConflictError(
          'Version conflict: data store was modified concurrently'
        );
      }
      throw error;
    }
  });
}

async function disconnectDataStore(dataStoreId: string) {
  return retryOptimisticLock(async () => {
    const existing = await getDataStore(dataStoreId);
    const currentVersion = existing.version;

    const adapter = getAdapter(existing.type);
    const config =
      typeof existing.config === 'string'
        ? JSON.parse(existing.config)
        : existing.config;

    try {
      await adapter.disconnect(config);
    } catch (error) {
      console.warn('Disconnect warning:', error);
    }

    try {
      const result = await dynamodb.send(
        new UpdateCommand({
          TableName: DATASTORES_TABLE,
          Key: { dataStoreId },
          UpdateExpression:
            'SET #status = :status, updatedAt = :now, #version = :newVersion',
          ConditionExpression: '#version = :expectedVersion',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':status': 'DISCONNECTED',
            ':now': new Date().toISOString(),
            ':newVersion': currentVersion + 1,
            ':expectedVersion': currentVersion,
          },
          ReturnValues: 'ALL_NEW',
        })
      );

      return result.Attributes;
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new ConflictError(
          'Version conflict: data store was modified concurrently'
        );
      }
      throw error;
    }
  });
}

async function testDataStoreConnection(dataStoreId: string) {
  const existing = await getDataStore(dataStoreId);
  const adapter = getAdapter(existing.type);
  const config =
    typeof existing.config === 'string'
      ? JSON.parse(existing.config)
      : existing.config;

  // Retrieve credentials if available
  let credentials: Record<string, any> | undefined;
  if (existing.secretArn) {
    try {
      const secretResult = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: existing.secretArn })
      );
      credentials = JSON.parse(secretResult.SecretString || '{}');
    } catch (error) {
      console.warn('Failed to retrieve credentials:', error);
    }
  }

  // Set up scoped credentials if needed
  let scopedCredentials: Record<string, any> | undefined;
  const { accountId, region } = await policyManager.getAccountContext();
  const policies = adapter.requiredPolicies(config, accountId, region).connect;

  if (policies.length > 0) {
    try {
      scopedCredentials = await policyManager.assumeScopedRole(
        dataStoreId,
        accountId,
        'datastore',
        config.crossAccountRoleArn
      );
    } catch (error) {
      console.warn('Failed to assume scoped role for test:', error);
    }
  }

  const testResult = await adapter.testConnection(
    config,
    scopedCredentials || credentials
  );

  return {
    success: testResult.success,
    message: testResult.message,
    details: testResult.details ? JSON.stringify(testResult.details) : null,
  };
}
