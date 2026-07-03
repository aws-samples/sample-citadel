import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isAdminFromEvent } from '../utils/auth-event';
import { publishEvent, createProjectEvent, EventTypes } from '../utils/events';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const MODEL_CONFIG_TABLE = process.env.MODEL_CONFIG_TABLE!;
const MODEL_CATALOG_TABLE = process.env.MODEL_CATALOG_TABLE!;

// Enum-ish value sets are enforced in-code. This resolver is DATA-DRIVEN: the
// set of valid models lives entirely in the catalog table — there are no
// hardcoded model-id literals anywhere in this file.
const VALID_STATUS = new Set(['enabled', 'disabled', 'deprecated', 'discovered']);
const VALID_LOCALITY = new Set(['off', 'regional_preferred', 'strict']);
const DEFAULT_SCOPE = 'platform';

interface ModelCatalogEntry {
  modelKey: string;
  provider: string;
  baseModelId: string;
  status: string;
  modality: string;
  invocationMode: string;
  supportsTools: boolean;
  supportsSystemPrompt: boolean;
  supportsStreaming: boolean;
  regionProfiles?: unknown;
}

interface ModelConfig {
  scope: string;
  globalDefaultKey: string | null;
  slotDefaults: Record<string, unknown>;
  orgDefaults: Record<string, unknown>;
  agentOverrides: Record<string, unknown>;
  localityMode: string;
  updatedAt?: string;
  updatedBy?: string;
}

export const handler = async (event: any) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    switch (fieldName) {
      case 'listModelCatalog':
        return await listModelCatalog();

      case 'getModelConfig':
        return await getModelConfig(event.arguments?.scope);

      case 'updateModelConfig':
        return await updateModelConfig(event.arguments.input, event);

      case 'setModelCatalogEntryStatus':
        return await setModelCatalogEntryStatus(
          event.arguments.modelKey,
          event.arguments.status,
          event,
        );

      case 'syncModelCatalog':
        return await syncModelCatalog(event);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

/**
 * Returns every row of the model catalog. Each item already matches the
 * ModelCatalogEntry GraphQL shape, so we return them verbatim (regionProfiles
 * is passed through as-is).
 */
async function listModelCatalog(): Promise<ModelCatalogEntry[]> {
  const result = await docClient.send(
    new ScanCommand({ TableName: MODEL_CATALOG_TABLE }),
  );
  return (result.Items || []) as ModelCatalogEntry[];
}

/**
 * Returns the resolved model config for `scope` (defaults to DEFAULT_SCOPE).
 * When no row exists yet, returns an empty skeleton so callers always receive a
 * well-formed ModelConfig rather than null.
 */
async function getModelConfig(scope?: string): Promise<ModelConfig> {
  const resolvedScope = scope || DEFAULT_SCOPE;
  const result = await docClient.send(
    new GetCommand({
      TableName: MODEL_CONFIG_TABLE,
      Key: { scope: resolvedScope },
    }),
  );

  if (!result.Item) {
    return {
      scope: resolvedScope,
      globalDefaultKey: null,
      slotDefaults: {},
      orgDefaults: {},
      agentOverrides: {},
      localityMode: 'off',
    };
  }

  return result.Item as ModelConfig;
}

/** Loads the catalog table into a modelKey -> entry map for validation. */
async function loadCatalog(): Promise<Record<string, ModelCatalogEntry>> {
  const result = await docClient.send(
    new ScanCommand({ TableName: MODEL_CATALOG_TABLE }),
  );
  const map: Record<string, ModelCatalogEntry> = {};
  for (const item of result.Items || []) {
    const entry = item as ModelCatalogEntry;
    map[entry.modelKey] = entry;
  }
  return map;
}

/**
 * Admin-only. Validates any referenced model keys against the catalog (each
 * must exist AND be `enabled`), merges the partial input onto the existing
 * config row, stamps updatedAt/updatedBy, persists it, and emits
 * MODEL_CONFIG_CHANGED.
 */
async function updateModelConfig(input: any, event: any): Promise<ModelConfig> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Only administrators can update model configuration');
  }

  if (
    input.localityMode !== undefined &&
    input.localityMode !== null &&
    !VALID_LOCALITY.has(input.localityMode)
  ) {
    throw new Error(`Invalid localityMode: ${input.localityMode}`);
  }

  const catalog = await loadCatalog();
  const assertEnabled = (key: string): void => {
    const entry = catalog[key];
    if (!entry) {
      throw new Error(`Unknown model: ${key}`);
    }
    if (entry.status !== 'enabled') {
      throw new Error(`Model not enabled: ${key}`);
    }
  };

  if (input.globalDefaultKey !== undefined && input.globalDefaultKey !== null) {
    assertEnabled(input.globalDefaultKey);
  }

  let slotDefaults: Record<string, unknown> | undefined;
  if (input.slotDefaults !== undefined && input.slotDefaults !== null) {
    slotDefaults =
      typeof input.slotDefaults === 'string'
        ? JSON.parse(input.slotDefaults)
        : input.slotDefaults;
    for (const value of Object.values(slotDefaults as Record<string, unknown>)) {
      assertEnabled(value as string);
    }
  }

  const scope = input.scope || DEFAULT_SCOPE;

  const existingResult = await docClient.send(
    new GetCommand({
      TableName: MODEL_CONFIG_TABLE,
      Key: { scope },
    }),
  );
  const existing: ModelConfig =
    (existingResult.Item as ModelConfig) || {
      scope,
      globalDefaultKey: null,
      slotDefaults: {},
      orgDefaults: {},
      agentOverrides: {},
      localityMode: 'off',
    };

  const updatedBy =
    event.identity?.username || event.identity?.claims?.sub || 'unknown';

  const merged: ModelConfig = {
    ...existing,
    scope,
    globalDefaultKey:
      input.globalDefaultKey !== undefined
        ? input.globalDefaultKey
        : existing.globalDefaultKey,
    slotDefaults: slotDefaults !== undefined ? slotDefaults : existing.slotDefaults,
    localityMode:
      input.localityMode !== undefined && input.localityMode !== null
        ? input.localityMode
        : existing.localityMode,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  await docClient.send(
    new PutCommand({
      TableName: MODEL_CONFIG_TABLE,
      Item: merged,
    }),
  );

  await publishEvent(
    createProjectEvent(
      EventTypes.MODEL_CONFIG_CHANGED,
      scope,
      { changed: Object.keys(input), updatedBy },
      undefined,
    ),
  );

  return merged;
}

/**
 * Admin-only. Sets the lifecycle `status` on a single catalog entry (validated
 * against VALID_STATUS), persists it, and emits MODEL_CONFIG_CHANGED.
 */
async function setModelCatalogEntryStatus(
  modelKey: string,
  status: string,
  event: any,
): Promise<ModelCatalogEntry> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Only administrators can update model configuration');
  }

  if (!VALID_STATUS.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: MODEL_CATALOG_TABLE,
      Key: { modelKey },
    }),
  );

  if (!result.Item) {
    throw new Error(`Unknown model: ${modelKey}`);
  }

  const updated: ModelCatalogEntry = {
    ...(result.Item as ModelCatalogEntry),
    status,
  };

  await docClient.send(
    new PutCommand({
      TableName: MODEL_CATALOG_TABLE,
      Item: updated,
    }),
  );

  await publishEvent(
    createProjectEvent(
      EventTypes.MODEL_CONFIG_CHANGED,
      'catalog',
      { modelKey, status },
      undefined,
    ),
  );

  return updated;
}

/**
 * Admin-only. Requests an on-demand model catalog sync by publishing a
 * MODEL_CATALOG_SYNC_REQUESTED event onto the custom agent bus. An
 * event-pattern rule on that bus routes the event to the existing discovery
 * Lambda — this resolver never invokes that Lambda directly (no
 * lambda:InvokeFunction). Returns a lightweight acknowledgement.
 */
async function syncModelCatalog(event: any) {
  if (!isAdminFromEvent(event)) {
    throw new Error('Only administrators can trigger a model catalog sync');
  }
  const requestedBy =
    event.identity?.username || event.identity?.claims?.sub || 'unknown';
  await publishEvent(
    createProjectEvent(EventTypes.MODEL_CATALOG_SYNC_REQUESTED, 'catalog', {
      requestedBy,
    }),
  );
  return { triggered: true, message: 'Model catalog sync started' };
}
