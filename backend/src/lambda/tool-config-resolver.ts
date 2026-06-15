import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getOperations } from '../utils/operations-registry';
import { RegistryService } from '../services/registry-service';
import { extractOrgFromEvent, isAdminFromEvent } from '../utils/auth-event';

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
  orgId: string;
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
// Read-time binding sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitises a list of bindings for GraphQL responses. Drops entries whose
 * required string fields are null/undefined/empty (which would otherwise
 * trip the "Cannot return null for non-nullable type 'String'" AppSync
 * error) and normalises `direction` to its uppercase form.
 *
 * Validators on the write paths prevent invalid bindings going forward, but
 * legacy rows that pre-date validation can still hold corrupt data. This
 * function is the read-time defence.
 *
 * Returns `null` if the input is falsy or no bindings survive the filter.
 */
export function sanitizeIntegrationBindings(bindings: any): IntegrationBinding[] | null {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const cleaned = bindings
    .filter((b: any) =>
      b &&
      typeof b.integrationId === 'string' && b.integrationId.length > 0 &&
      typeof b.integrationType === 'string' && b.integrationType.length > 0,
    )
    .map((b: any) => ({
      ...b,
      direction: b.direction ? String(b.direction).toUpperCase() : 'BIDIRECTIONAL',
    }));
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeDataStoreBindings(bindings: any): DataStoreBinding[] | null {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const cleaned = bindings
    .filter((b: any) =>
      b &&
      typeof b.dataStoreId === 'string' && b.dataStoreId.length > 0 &&
      typeof b.dataStoreType === 'string' && b.dataStoreType.length > 0,
    )
    .map((b: any) => ({
      ...b,
      direction: b.direction ? String(b.direction).toUpperCase() : 'BIDIRECTIONAL',
    }));
  return cleaned.length > 0 ? cleaned : null;
}


// ---------------------------------------------------------------------------
// Handler (task 7.5)
// ---------------------------------------------------------------------------

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  // Extract the AppSync caller's user id from the event identity. AppSync
  // `event.identity` shape varies by auth mode (Cognito sets `sub`, IAM sets
  // `username`, API key leaves it undefined). Mirror the fabricator pattern
  // (fabricator-request-resolver.ts) so we stay consistent across resolvers.
  const requestedBy =
    (event.identity && ('sub' in event.identity ? event.identity.sub : undefined)) ||
    (event.identity && ('username' in event.identity ? event.identity.username : undefined)) ||
    'unknown';

  try {
    const registryEnabled = isRegistryEnabled();

    switch (fieldName) {
      case 'listToolConfigs':
        return registryEnabled
          ? await listToolConfigsRegistry(event)
          : await listToolConfigs();

      case 'getToolConfig':
        return registryEnabled
          ? await getToolConfigRegistry(event.arguments.toolId, event)
          : await getToolConfig(event.arguments.toolId);

      case 'createToolConfig':
        return registryEnabled
          ? await createToolConfigRegistry(event.arguments.input, requestedBy, event)
          : await createToolConfig(event.arguments.input);

      case 'updateToolConfig':
        return registryEnabled
          ? await updateToolConfigRegistry(event.arguments.input, requestedBy, event)
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
 *
 * Results are filtered to the caller's organization unless the caller has
 * `custom:role=admin`, in which case the full list (across all orgs) is
 * returned. A non-admin caller without an orgId receives an empty list
 * with a warning.
 */
export async function listToolConfigsRegistry(event?: any): Promise<ToolConfig[]> {
  const callerOrgId = event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;

  if (!admin && !callerOrgId) {
    console.warn('listToolConfigsRegistry: no caller orgId and not admin; returning empty list');
    return [];
  }

  const registryService = getRegistryService();
  const registryRecords = await registryService.listResources('tool');
  const allRegistryConfigs = registryRecords.map((record) =>
    registryService.mapToToolConfig(record),
  );
  const registryConfigs = admin
    ? allRegistryConfigs
    : allRegistryConfigs.filter((t) => t.orgId === callerOrgId);

  const allDynamoConfigs = await listToolConfigs();
  const dynamoConfigs = admin
    ? allDynamoConfigs
    : allDynamoConfigs.filter((t) => t.orgId === callerOrgId);

  // Registry wins on duplicates. Post-420d0ae, registryConfigs[].toolId is a
  // 12-char recordId while dynamoConfigs[].toolId is still the legacy name.
  // Dedupe by the `name` field inside the config payload — the stable human
  // identifier shared by both representations. Guard against unparseable/
  // missing names.
  const extractName = (c: ToolConfig): string | undefined => {
    if (!c.config) return undefined;
    try {
      const parsed = typeof c.config === 'string' ? JSON.parse(c.config) : c.config;
      const name = parsed?.name;
      return typeof name === 'string' && name.length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  };
  const registryNames = new Set(
    registryConfigs
      .map(extractName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  );
  const legacyOnly = dynamoConfigs.filter((c) => {
    const n = extractName(c);
    return !n || !registryNames.has(n);
  });

  return [...registryConfigs, ...legacyOnly];
}

/**
 * Registry-first get: checks Registry for the tool, falls back to DynamoDB
 * if not found. Returns null when neither source has the record.
 *
 * Cross-org access is reported as not-found (404-style, not 403) so we
 * don't leak existence across tenants. Admins bypass the org check.
 */
export async function getToolConfigRegistry(toolId: string, event?: any): Promise<ToolConfig | null> {
  const registryService = getRegistryService();
  const callerOrgId = event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;

  const record = await registryService.getResource('tool', toolId);
  if (record) {
    const mapped = registryService.mapToToolConfig(record);
    if (!admin && mapped.orgId && mapped.orgId !== callerOrgId) {
      return null;
    }
    return mapped;
  }
  // Fallback to DynamoDB for legacy records
  const legacy = await getToolConfig(toolId);
  if (!legacy) return null;
  if (!admin && legacy.orgId && legacy.orgId !== callerOrgId) {
    return null;
  }
  return legacy;
}

/**
 * Registry-backed create: validates bindings, serializes custom metadata,
 * and creates a Registry resource. Returns the mapped ToolConfig.
 *
 * `userId` is forwarded from the AppSync handler and stored as `createdBy`
 * inside customMetadata so we retain caller attribution on the Registry
 * record. Defaults to `'unknown'` so other callers (e.g. internal scripts)
 * still work unchanged.
 */
export async function createToolConfigRegistry(input: any, userId: string = 'unknown', event?: any): Promise<ToolConfig> {
  // Validate bindings before Registry write
  if (input.integrationBindings && Array.isArray(input.integrationBindings)) {
    validateIntegrationBindings(input.integrationBindings);
  }
  if (input.dataStoreBindings && Array.isArray(input.dataStoreBindings)) {
    validateDataStoreBindings(input.dataStoreBindings);
  }

  const registryService = getRegistryService();

  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error('Cannot determine caller organization');
  }

  const config = typeof input.config === 'string' ? input.config : JSON.stringify(input.config);
  const parsedConfig = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const customMetadata = registryService.serializeCustomMetadata({
    categories: input.categories || [],
    icon: input.icon || '',
    state: input.state || 'active',
    integrationBindings: input.integrationBindings || undefined,
    dataStoreBindings: input.dataStoreBindings || undefined,
    appId: input.appId || undefined,
    config,
    createdBy: userId,
    orgId,
  });

  const record = await registryService.createResource('tool', input.toolId, {
    name: parsedConfig.name || input.toolId,
    description: parsedConfig.description ?? '',   // plain human-readable (was full JSON)
    customMetadata,
  });

  // If an initial state is provided, update the status accordingly
  if (input.state) {
    const registryStatus = registryService.toRegistryStatus(input.state);
    await registryService.updateResourceStatus('tool', input.toolId, registryStatus);
    // Re-fetch so the returned state reflects the post-transition record
    // rather than the stale DRAFT snapshot from createResource above. Matches
    // the fix in agent-config-resolver (0715f73).
    const refreshed = await registryService.getResource('tool', input.toolId);
    return registryService.mapToToolConfig(refreshed ?? record);
  }

  return registryService.mapToToolConfig(record);
}

/**
 * Registry-backed update: validates bindings, updates the Registry resource
 * with new metadata. If state is being changed, also updates the Registry
 * status via toRegistryStatus. Returns the mapped ToolConfig.
 *
 * `userId` is forwarded from the AppSync handler. Legacy records without a
 * prior `createdBy` get the current caller's id on first edit; existing
 * values are preserved so we never clobber a known creator.
 */
export async function updateToolConfigRegistry(input: any, userId: string = 'unknown', event?: any): Promise<ToolConfig> {
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
    config?: string;
    createdBy?: string;
    orgId?: string;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    integrationBindings: undefined,
    dataStoreBindings: undefined,
    appId: undefined,
    config: undefined,
    createdBy: undefined,
    orgId: undefined,
  });

  // Preserve existing orgId; fall back to caller for legacy records.
  // Never derive orgId from input — that field is backend-owned.
  const preservedOrgId = existingMeta.orgId
    ?? (event !== undefined ? (await extractOrgFromEvent(event)) ?? undefined : undefined);

  // Merge config. Source of truth for the "existing" config is
  // customMetadata.config (new contract), with a fallback to
  // existing.description for legacy records written before this change.
  const existingConfig = existingMeta.config ?? existing.description ?? '';
  const newConfig = input.config
    ? (typeof input.config === 'string' ? input.config : JSON.stringify(input.config))
    : existingConfig;

  // Defensive parse: legacy records may carry free-text in description
  // rather than JSON. State-only toggles must not crash on malformed data.
  let parsedNewConfig: any = {};
  if (newConfig && typeof newConfig === 'string') {
    try {
      parsedNewConfig = JSON.parse(newConfig);
    } catch {
      parsedNewConfig = {};
    }
  } else if (newConfig && typeof newConfig === 'object') {
    parsedNewConfig = newConfig;
  }

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
    config: newConfig,
    createdBy: existingMeta.createdBy ?? userId,
    orgId: preservedOrgId,
  });

  const record = await registryService.updateResource('tool', input.toolId, {
    name: parsedNewConfig.name || existing.name,
    description: parsedNewConfig.description ?? '',
    customMetadata: updatedMeta,
  });

  // If state is being changed, update the Registry status. The condition
  // compares against the actual Registry status — gating on metadata is
  // unreliable because customMetadata.state can drift out of sync with
  // record.status (e.g. when deserializeCustomMetadata falls back to its
  // 'active' default for records missing the field). The user-facing state
  // is derived from record.status via toInternalState, so that's what must
  // change for the toggle to actually take effect.
  const desiredRegistryStatus = input.state
    ? registryService.toRegistryStatus(input.state)
    : undefined;
  if (input.state && desiredRegistryStatus && desiredRegistryStatus !== existing.status) {
    await registryService.updateResourceStatus('tool', input.toolId, desiredRegistryStatus);
    // Re-fetch so the returned state reflects the post-transition record
    // rather than the stale snapshot from updateResource above. Matches the
    // fix in agent-config-resolver (0715f73).
    const refreshed = await registryService.getResource('tool', input.toolId);
    return registryService.mapToToolConfig(refreshed ?? record);
  }

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
    orgId: item.orgId || '',
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    integrationBindings: sanitizeIntegrationBindings(item.integrationBindings),
    dataStoreBindings: sanitizeDataStoreBindings(item.dataStoreBindings),
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
    orgId: result.Item.orgId || '',
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof result.Item.config === 'string' ? result.Item.config : JSON.stringify(result.Item.config),
    state: result.Item.state || 'active',
    categories: result.Item.categories || [],
    integrationBindings: sanitizeIntegrationBindings(result.Item.integrationBindings),
    dataStoreBindings: sanitizeDataStoreBindings(result.Item.dataStoreBindings),
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
    orgId: '',
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
  // Defensive: legacy DynamoDB rows may have non-JSON `config` strings.
  const existingConfig = (() => {
    if (typeof existing.config !== 'string') return existing.config ?? {};
    try { return JSON.parse(existing.config); } catch { return {}; }
  })();
  const newConfig = input.config 
    ? (typeof input.config === 'string' ? (() => { try { return JSON.parse(input.config); } catch { return {}; } })() : input.config)
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
    orgId: existing.orgId || '',
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
