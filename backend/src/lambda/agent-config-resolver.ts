import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { RegistryService } from '../services/registry-service';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;

// ---------------------------------------------------------------------------
// Feature flag + Registry Service initialization (task 6.1)
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

interface AgentConfig {
  agentId: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance' | 'pending' | string;
  categories?: string[] | string;
  createdAt?: string;
  updatedAt?: string;
}

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    const registryEnabled = isRegistryEnabled();

    switch (fieldName) {
      case 'listAgentConfigs':
        return registryEnabled
          ? await listAgentConfigsRegistry()
          : await listAgentConfigs();

      case 'getAgentConfig':
        return registryEnabled
          ? await getAgentConfigRegistry(event.arguments.agentId)
          : await getAgentConfig(event.arguments.agentId);

      case 'createAgentConfig':
        return registryEnabled
          ? await createAgentConfigRegistry(event.arguments.input)
          : await createAgentConfig(event.arguments.input);

      case 'updateAgentConfig':
        return registryEnabled
          ? await updateAgentConfigRegistry(event.arguments.input)
          : await updateAgentConfig(event.arguments.input);

      case 'deleteAgentConfig':
        return registryEnabled
          ? await deleteAgentConfigRegistry(event.arguments.agentId)
          : await deleteAgentConfig(event.arguments.agentId);

      case 'publishAgentManifest':
        return registryEnabled
          ? await publishAgentManifestRegistry(event.arguments.agentId, event.arguments.manifest)
          : await publishAgentManifest(event.arguments.agentId, event.arguments.manifest);

      case 'searchAgentConfigs':
        return await searchAgentConfigsRegistry(event.arguments.query);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

/**
 * Registry-first get: checks Registry for the agent, falls back to DynamoDB
 * if not found or if Registry is unavailable. Returns null when neither
 * source has the record.
 *
 * Error handling per design:
 * - Registry returns null (404) → fall back to DynamoDB
 * - Registry throws (unavailable / transient error) → log warning, fall
 *   back to DynamoDB so get queries can degrade gracefully
 */
export async function getAgentConfigRegistry(agentId: string): Promise<AgentConfig | null> {
  const registryService = getRegistryService();
  try {
    const record = await registryService.getResource('agent', agentId);
    if (record) {
      return registryService.mapToAgentConfig(record);
    }
  } catch (err) {
    console.warn(
      `Registry getResource failed for agent ${agentId}, falling back to DynamoDB:`,
      err,
    );
  }
  // Fallback to DynamoDB for legacy records (or on Registry error)
  return getAgentConfig(agentId);
}

/**
 * Dual-source list: fetches agent configs from both Registry and DynamoDB,
 * merges them with Registry records taking precedence on duplicate agentIds.
 */
export async function listAgentConfigsRegistry(): Promise<AgentConfig[]> {
  // 1. Fetch Registry records and map to AgentConfig
  const registryService = getRegistryService();
  const registryRecords = await registryService.listResources('agent');
  const registryConfigs = registryRecords.map((record) =>
    registryService.mapToAgentConfig(record),
  );

  // 2. Fetch DynamoDB legacy records
  const dynamoConfigs = await listAgentConfigs();

  // 3. Build set of agentIds from Registry (Registry wins on duplicates)
  const registryIds = new Set(registryConfigs.map((c) => c.agentId));

  // 4. Filter DynamoDB records to exclude duplicates
  const legacyOnly = dynamoConfigs.filter((c) => !registryIds.has(c.agentId));

  // 5. Return merged list
  return [...registryConfigs, ...legacyOnly];
}

/**
 * Registry-backed create: serializes custom metadata and creates a Registry
 * resource. Returns the mapped AgentConfig.
 */
export async function createAgentConfigRegistry(input: any): Promise<AgentConfig> {
  const registryService = getRegistryService();

  const config = typeof input.config === 'string' ? input.config : JSON.stringify(input.config);
  const parsedConfig = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const customMetadata = registryService.serializeCustomMetadata({
    categories: input.categories || [],
    icon: input.icon || '',
    state: input.state || 'active',
    appId: input.appId || undefined,
  });

  const record = await registryService.createResource('agent', input.agentId, {
    name: parsedConfig.name || input.agentId,
    description: config,
    customMetadata,
  });

  // If an initial state is provided, update the status accordingly
  if (input.state) {
    const registryStatus = registryService.toRegistryStatus(input.state);
    await registryService.updateResourceStatus('agent', input.agentId, registryStatus);
  }

  return registryService.mapToAgentConfig(record);
}

/**
 * Registry-backed update: updates the Registry resource with new metadata.
 * If state is being changed, also updates the Registry status via toRegistryStatus.
 * Returns the mapped AgentConfig.
 */
export async function updateAgentConfigRegistry(input: any): Promise<AgentConfig> {
  const registryService = getRegistryService();

  // Fetch existing record to merge with
  const existing = await registryService.getResource('agent', input.agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${input.agentId}`);
  }

  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    appId?: string;
    manifest?: Record<string, any>;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    appId: undefined,
    manifest: undefined,
  });

  // Merge config
  const newConfig = input.config
    ? (typeof input.config === 'string' ? input.config : JSON.stringify(input.config))
    : existing.description;

  const parsedNewConfig = newConfig ? (typeof newConfig === 'string' ? JSON.parse(newConfig) : newConfig) : {};

  // Merge custom metadata
  const updatedMeta = registryService.serializeCustomMetadata({
    categories: input.categories !== undefined ? input.categories : existingMeta.categories,
    icon: input.icon !== undefined ? input.icon : existingMeta.icon,
    state: input.state || existingMeta.state,
    appId: input.appId !== undefined ? input.appId : existingMeta.appId,
    manifest: existingMeta.manifest,
  });

  const record = await registryService.updateResource('agent', input.agentId, {
    name: parsedNewConfig.name || existing.name,
    description: newConfig,
    customMetadata: updatedMeta,
  });

  // State is tracked in custom metadata; registry status stays as-is after update
  return registryService.mapToAgentConfig(record);
}

/**
 * Registry-backed delete: deletes the resource from the Registry.
 * Returns success/failure object matching the existing shape.
 */
export async function deleteAgentConfigRegistry(agentId: string): Promise<{ success: boolean; message?: string }> {
  const registryService = getRegistryService();
  try {
    await registryService.deleteResource('agent', agentId);
    return {
      success: true,
      message: `Agent config ${agentId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting agent config from Registry:', error);
    return {
      success: false,
      message: `Failed to delete agent config: ${error}`,
    };
  }
}

/**
 * Registry-backed manifest publish: validates the manifest, fetches the
 * existing record, updates custom metadata with the new manifest, and
 * calls updateResource. Returns the mapped AgentConfig.
 */
export async function publishAgentManifestRegistry(agentId: string, manifestStr: string): Promise<AgentConfig> {
  // Parse the AWSJSON manifest string
  let manifest: any;
  try {
    manifest = JSON.parse(manifestStr);
  } catch {
    throw new Error('Invalid manifest JSON: unable to parse');
  }

  // Validate required fields
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
  }

  const registryService = getRegistryService();

  // Verify agent exists in Registry
  const existing = await registryService.getResource('agent', agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${agentId}`);
  }

  // Deserialize existing custom metadata and merge in the new manifest
  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    appId?: string;
    manifest?: Record<string, any>;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    appId: undefined,
    manifest: undefined,
  });

  const updatedMeta = registryService.serializeCustomMetadata({
    ...existingMeta,
    manifest,
  } as any);

  const record = await registryService.updateResource('agent', agentId, {
    name: existing.name,
    description: existing.description,
    customMetadata: updatedMeta,
  });

  return registryService.mapToAgentConfig(record);
}

/**
 * Searches for agent configs via Registry semantic search.
 * Returns results mapped to the AgentConfig GraphQL type.
 */
async function searchAgentConfigsRegistry(query: string): Promise<AgentConfig[]> {
  const registryService = getRegistryService();
  const records = await registryService.searchResources('agent', query);
  return records.map((record) => registryService.mapToAgentConfig(record));
}

async function listAgentConfigs(): Promise<AgentConfig[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: AGENT_CONFIG_TABLE,
    })
  );

  return (result.Items || []).map(item => ({
    agentId: item.agentId,
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    agentId: result.Item.agentId,
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof result.Item.config === 'string' ? result.Item.config : JSON.stringify(result.Item.config),
    state: result.Item.state || 'active',
    categories: result.Item.categories || [],
    createdAt: result.Item.createdAt,
    updatedAt: result.Item.updatedAt,
  };
}

async function createAgentConfig(input: any): Promise<AgentConfig> {
  const now = new Date().toISOString();
  const config = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const agentConfig: AgentConfig = {
    agentId: input.agentId,
    config,
    state: input.state || 'active',
    categories: input.categories || [],
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: AGENT_CONFIG_TABLE,
      Item: agentConfig,
    })
  );

  return {
    ...agentConfig,
    config: JSON.stringify(config),
  };
}

async function updateAgentConfig(input: any): Promise<AgentConfig> {
  const existing = await getAgentConfig(input.agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${input.agentId}`);
  }

  const now = new Date().toISOString();
  const existingConfig = typeof existing.config === 'string' ? JSON.parse(existing.config) : existing.config;
  const newConfig = input.config 
    ? (typeof input.config === 'string' ? JSON.parse(input.config) : input.config)
    : existingConfig;

  // D-02: Optimistic locking — increment version and use conditional write
  const currentVersion = (existing as any).version || 0;
  const nextVersion = currentVersion + 1;

  const updatedConfig: AgentConfig = {
    agentId: input.agentId,
    config: newConfig,
    state: input.state || existing.state,
    categories: input.categories !== undefined ? input.categories : existing.categories,
    createdAt: existing.createdAt,
    updatedAt: now,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: AGENT_CONFIG_TABLE,
        Item: { ...updatedConfig, version: nextVersion },
        ConditionExpression: currentVersion === 0
          ? 'attribute_not_exists(version) OR version = :currentVersion'
          : 'version = :currentVersion',
        ExpressionAttributeValues: {
          ':currentVersion': currentVersion,
        },
      })
    );
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error(`Conflict: agent config ${input.agentId} was modified concurrently. Please retry.`);
    }
    throw error;
  }

  return {
    ...updatedConfig,
    config: JSON.stringify(newConfig),
  };
}

async function deleteAgentConfig(agentId: string): Promise<{ success: boolean; message?: string }> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: AGENT_CONFIG_TABLE,
        Key: { agentId },
      })
    );

    return {
      success: true,
      message: `Agent config ${agentId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting agent config:', error);
    return {
      success: false,
      message: `Failed to delete agent config: ${error}`,
    };
  }
}


// ─── Manifest Validation ─────────────────────────────────────

export function validateManifest(manifest: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    errors.push('description is required and must be a non-empty string');
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    errors.push('version is required and must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Publish Agent Manifest ──────────────────────────────────

async function publishAgentManifest(agentId: string, manifestStr: string): Promise<any> {
  // Parse the AWSJSON manifest string
  let manifest: any;
  try {
    manifest = JSON.parse(manifestStr);
  } catch {
    throw new Error('Invalid manifest JSON: unable to parse');
  }

  // Validate required fields
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
  }

  // Verify agent exists
  const existing = await docClient.send(
    new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    })
  );

  if (!existing.Item) {
    throw new Error(`Agent config not found: ${agentId}`);
  }

  // Store manifest in agent config item
  const now = new Date().toISOString();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
      UpdateExpression: 'SET #manifest = :manifest, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#manifest': 'manifest',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':manifest': manifest,
        ':updatedAt': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  const item = result.Attributes!;
  return {
    agentId: item.agentId,
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    manifest: item.manifest,
  };
}
