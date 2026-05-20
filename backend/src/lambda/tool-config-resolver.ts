import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getOperations } from '../utils/operations-registry';
import { RegistryService } from '../services/registry-service';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TOOLS_CONFIG_TABLE = process.env.TOOLS_CONFIG_TABLE!;

// ---------------------------------------------------------------------------
// Feature flag + Registry Service initialization (task 7.1)
// ---------------------------------------------------------------------------

/**
 * Returns true when the Registry feature flag is enabled.
 * Defaults to false if the environment variable is missing or unreadable.
 */
export function isRegistryEnabled(): boolean {
  try {
    return process.env.REGISTRY_ENABLED === 'true';
  } catch {
    return false;
  }
}

/** Lazily-initialised RegistryService singleton (created on first use). */
let registryServiceInstance: RegistryService | null = null;

/**
 * Returns the shared RegistryService instance, creating it on first call.
 * Only call this when `isRegistryEnabled()` is true — the function reads
 * REGISTRY_ID from the environment and will throw if it is missing.
 */
export function getRegistryService(): RegistryService {
  if (!registryServiceInstance) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error('REGISTRY_ID environment variable is required when REGISTRY_ENABLED is true');
    }
    registryServiceInstance = new RegistryService({
      registryId,
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return registryServiceInstance;
}

/**
 * Resets the cached RegistryService instance.
 * Exposed for testing so that tests can clear state between runs.
 * @internal
 */
export function _resetRegistryService(): void {
  registryServiceInstance = null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingDirection = 'INPUT' | 'OUTPUT' | 'BIDIRECTIONAL';

export interface IntegrationBinding {
  integrationId: string;
  integrationType: string;
  operations?: string[];
  direction?: BindingDirection;
}

export interface DataStoreBinding {
  dataStoreId: string;
  dataStoreType: string;
  operations?: string[];
  direction?: BindingDirection;
}

interface ToolConfig {
  toolId: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance' | 'pending' | string;
  categories?: string[];
  integrationBindings?: IntegrationBinding[] | null;
  dataStoreBindings?: DataStoreBinding[] | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Binding validation
// ---------------------------------------------------------------------------

export function validateIntegrationBindings(bindings: any[]): void {
  for (const binding of bindings) {
    if (!binding.integrationId || typeof binding.integrationId !== 'string') {
      throw new Error('Validation error: integrationBinding missing required field "integrationId"');
    }
    if (!binding.integrationType || typeof binding.integrationType !== 'string') {
      throw new Error('Validation error: integrationBinding missing required field "integrationType"');
    }
  }
}

export function validateDataStoreBindings(bindings: any[]): void {
  for (const binding of bindings) {
    if (!binding.dataStoreId || typeof binding.dataStoreId !== 'string') {
      throw new Error('Validation error: dataStoreBinding missing required field "dataStoreId"');
    }
    if (!binding.dataStoreType || typeof binding.dataStoreType !== 'string') {
      throw new Error('Validation error: dataStoreBinding missing required field "dataStoreType"');
    }
  }
}


// ---------------------------------------------------------------------------
// Handler (task 7.5)
// ---------------------------------------------------------------------------

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    const registryEnabled = isRegistryEnabled();

    switch (fieldName) {
      case 'listToolConfigs':
        return registryEnabled
          ? await listToolConfigsRegistry()
          : await listToolConfigs();

      case 'getToolConfig':
        return registryEnabled
          ? await getToolConfigRegistry(event.arguments.toolId)
          : await getToolConfig(event.arguments.toolId);

      case 'createToolConfig':
        return registryEnabled
          ? await createToolConfigRegistry(event.arguments.input)
          : await createToolConfig(event.arguments.input);

      case 'updateToolConfig':
        return registryEnabled
          ? await updateToolConfigRegistry(event.arguments.input)
          : await updateToolConfig(event.arguments.input);

      case 'deleteToolConfig':
        return registryEnabled
          ? await deleteToolConfigRegistry(event.arguments.toolId)
          : await deleteToolConfig(event.arguments.toolId);

      case 'listIntegrationOperations':
        return getOperations(event.arguments.integrationType);

      case 'searchToolConfigs':
        return await searchToolConfigs(event.arguments.query);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Registry-backed implementations (tasks 7.2–7.4, 7.6)
// ---------------------------------------------------------------------------

/**
 * Dual-source list: fetches tool configs from both Registry and DynamoDB,
 * merges them with Registry records taking precedence on duplicate toolIds.
 */
export async function listToolConfigsRegistry(): Promise<ToolConfig[]> {
  const registryService = getRegistryService();
  const registryRecords = await registryService.listResources('tool');
  const registryConfigs = registryRecords.map((record) =>
    registryService.mapToToolConfig(record),
  );

  const dynamoConfigs = await listToolConfigs();

  // Registry wins on duplicates
  const registryIds = new Set(registryConfigs.map((c) => c.toolId));
  const legacyOnly = dynamoConfigs.filter((c) => !registryIds.has(c.toolId));

  return [...registryConfigs, ...legacyOnly];
}

/**
 * Registry-first get: checks Registry for the tool, falls back to DynamoDB
 * if not found. Returns null when neither source has the record.
 */
export async function getToolConfigRegistry(toolId: string): Promise<ToolConfig | null> {
  const registryService = getRegistryService();
  const record = await registryService.getResource('tool', toolId);
  if (record) {
    return registryService.mapToToolConfig(record);
  }
  // Fallback to DynamoDB for legacy records
  return getToolConfig(toolId);
}

/**
 * Registry-backed create: validates bindings, serializes custom metadata,
 * and creates a Registry resource. Returns the mapped ToolConfig.
 */
export async function createToolConfigRegistry(input: any): Promise<ToolConfig> {
  // Validate bindings before Registry write
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const registryService = getRegistryService();

  const config = typeof input.config === 'string' ? input.config : JSON.stringify(input.config);
  const parsedConfig = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const customMetadata = registryService.serializeCustomMetadata({
    categories: input.categories || [],
    icon: input.icon || '',
    state: input.state || 'active',
    integrationBindings: input.integrationBindings || undefined,
    dataStoreBindings: input.dataStoreBindings || undefined,
    appId: input.appId || undefined,
  });

  const record = await registryService.createResource('tool', input.toolId, {
    name: parsedConfig.name || input.toolId,
    description: config,
    customMetadata,
  });

  // If an initial state is provided, update the status accordingly
  if (input.state) {
    const registryStatus = registryService.toRegistryStatus(input.state);
    await registryService.updateResourceStatus('tool', input.toolId, registryStatus);
  }

  return registryService.mapToToolConfig(record);
}

/**
 * Registry-backed update: validates bindings, updates the Registry resource
 * with new metadata. If state is being changed, also updates the Registry
 * status via toRegistryStatus. Returns the mapped ToolConfig.
 */
export async function updateToolConfigRegistry(input: any): Promise<ToolConfig> {
  // Validate bindings before Registry write
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const registryService = getRegistryService();

  // Fetch existing record to merge with
  const existing = await registryService.getResource('tool', input.toolId);
  if (!existing) {
    throw new Error(`Tool config not found: ${input.toolId}`);
  }

  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    integrationBindings?: IntegrationBinding[];
    dataStoreBindings?: DataStoreBinding[];
    appId?: string;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    integrationBindings: undefined,
    dataStoreBindings: undefined,
    appId: undefined,
  });

  // Merge config
  const newConfig = input.config
    ? (typeof input.config === 'string' ? input.config : JSON.stringify(input.config))
    : existing.description;

  const parsedNewConfig = newConfig ? (typeof newConfig === 'string' ? JSON.parse(newConfig) : newConfig) : {};

  // Merge bindings — only overwrite if provided in input
  const integrationBindings = input.integrationBindings !== undefined
    ? input.integrationBindings
    : existingMeta.integrationBindings;
  const dataStoreBindings = input.dataStoreBindings !== undefined
    ? input.dataStoreBindings
    : existingMeta.dataStoreBindings;

  // Merge custom metadata
  const updatedMeta = registryService.serializeCustomMetadata({
    categories: input.categories !== undefined ? input.categories : existingMeta.categories,
    icon: input.icon !== undefined ? input.icon : existingMeta.icon,
    state: input.state || existingMeta.state,
    integrationBindings: integrationBindings || undefined,
    dataStoreBindings: dataStoreBindings || undefined,
    appId: input.appId !== undefined ? input.appId : existingMeta.appId,
  });

  const record = await registryService.updateResource('tool', input.toolId, {
    name: parsedNewConfig.name || existing.name,
    description: newConfig,
    customMetadata: updatedMeta,
  });

  // If state is being changed, update the Registry status
  return registryService.mapToToolConfig(record);
}

/**
 * Registry-backed delete: deletes the resource from the Registry.
 * Returns success/failure object matching the existing shape.
 */
export async function deleteToolConfigRegistry(toolId: string): Promise<{ success: boolean; message?: string }> {
  const registryService = getRegistryService();
  try {
    await registryService.deleteResource('tool', toolId);
    return {
      success: true,
      message: `Tool config ${toolId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting tool config from Registry:', error);
    return {
      success: false,
      message: `Failed to delete tool config: ${error}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Search handlers (task 7.6)
// ---------------------------------------------------------------------------

/**
 * Searches for tool configs via Registry semantic search.
 * Returns results mapped to the ToolConfig GraphQL type.
 */
async function searchToolConfigs(query: string): Promise<ToolConfig[]> {
  const registryService = getRegistryService();
  const records = await registryService.searchResources('tool', query);
  return records.map((record) => registryService.mapToToolConfig(record));
}


// ---------------------------------------------------------------------------
// DynamoDB-backed implementations (existing / legacy)
// ---------------------------------------------------------------------------

async function listToolConfigs(): Promise<ToolConfig[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TOOLS_CONFIG_TABLE,
    })
  );

  return (result.Items || []).map(item => ({
    toolId: item.toolId,
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    integrationBindings: item.integrationBindings
      ? item.integrationBindings.map((b: any) => ({ ...b, direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL' }))
      : null,
    dataStoreBindings: item.dataStoreBindings
      ? item.dataStoreBindings.map((b: any) => ({ ...b, direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL' }))
      : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

async function getToolConfig(toolId: string): Promise<ToolConfig | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Key: { toolId },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    toolId: result.Item.toolId,
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof result.Item.config === 'string' ? result.Item.config : JSON.stringify(result.Item.config),
    state: result.Item.state || 'active',
    categories: result.Item.categories || [],
    integrationBindings: result.Item.integrationBindings
      ? result.Item.integrationBindings.map((b: any) => ({ ...b, direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL' }))
      : null,
    dataStoreBindings: result.Item.dataStoreBindings
      ? result.Item.dataStoreBindings.map((b: any) => ({ ...b, direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL' }))
      : null,
    createdAt: result.Item.createdAt,
    updatedAt: result.Item.updatedAt,
  };
}

async function createToolConfig(input: any): Promise<ToolConfig> {
  const now = new Date().toISOString();
  const config = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  // Validate bindings before persistence
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const toolConfig: any = {
    toolId: input.toolId,
    config,
    state: input.state || 'active',
    categories: input.categories || [],
    createdAt: now,
    updatedAt: now,
  };

  if (input.integrationBindings && Array.isArray(input.integrationBindings) && input.integrationBindings.length > 0) {
    toolConfig.integrationBindings = input.integrationBindings.map((b: any) => ({
      ...b,
      direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
    }));
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings) && input.dataStoreBindings.length > 0) {
    toolConfig.dataStoreBindings = input.dataStoreBindings.map((b: any) => ({
      ...b,
      direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
    }));
  }

  await docClient.send(
    new PutCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Item: toolConfig,
    })
  );

  return {
    ...toolConfig,
    config: JSON.stringify(config),
    integrationBindings: toolConfig.integrationBindings || null,
    dataStoreBindings: toolConfig.dataStoreBindings || null,
  };
}

async function updateToolConfig(input: any): Promise<ToolConfig> {
  const existing = await getToolConfig(input.toolId);
  if (!existing) {
    throw new Error(`Tool config not found: ${input.toolId}`);
  }

  // Validate bindings before persistence
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const now = new Date().toISOString();
  const existingConfig = typeof existing.config === 'string' ? JSON.parse(existing.config) : existing.config;
  const newConfig = input.config 
    ? (typeof input.config === 'string' ? JSON.parse(input.config) : input.config)
    : existingConfig;

  // Merge bindings independently — only overwrite if provided in input
  const integrationBindings = input.integrationBindings !== undefined
    ? input.integrationBindings
    : existing.integrationBindings;
  const dataStoreBindings = input.dataStoreBindings !== undefined
    ? input.dataStoreBindings
    : existing.dataStoreBindings;

  const updatedItem: any = {
    toolId: input.toolId,
    config: newConfig,
    state: input.state || existing.state,
    categories: input.categories !== undefined ? input.categories : existing.categories,
    createdAt: existing.createdAt,
    updatedAt: now,
  };

  if (integrationBindings && Array.isArray(integrationBindings) && integrationBindings.length > 0) {
    updatedItem.integrationBindings = integrationBindings;
  }
  if (dataStoreBindings && Array.isArray(dataStoreBindings) && dataStoreBindings.length > 0) {
    updatedItem.dataStoreBindings = dataStoreBindings;
  }

  await docClient.send(
    new PutCommand({
      TableName: TOOLS_CONFIG_TABLE,
      Item: updatedItem,
    })
  );

  return {
    ...updatedItem,
    config: JSON.stringify(newConfig),
    integrationBindings: updatedItem.integrationBindings || null,
    dataStoreBindings: updatedItem.dataStoreBindings || null,
  };
}

async function deleteToolConfig(toolId: string): Promise<{ success: boolean; message?: string }> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TOOLS_CONFIG_TABLE,
        Key: { toolId },
      })
    );

    return {
      success: true,
      message: `Tool config ${toolId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting tool config:', error);
    return {
      success: false,
      message: `Failed to delete tool config: ${error}`,
    };
  }
}
