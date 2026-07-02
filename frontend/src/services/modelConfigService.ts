import serverService from './server';

/**
 * A single entry in the model catalog. `regionProfiles` is stored as AWSJSON
 * on the backend, so it arrives as a JSON string and is parsed on read into a
 * `region -> resolvedModelId` map.
 */
export interface ModelCatalogEntry {
  modelKey: string;
  provider: string;
  baseModelId: string;
  status: string;
  modality: string;
  invocationMode: string;
  supportsTools: boolean;
  supportsSystemPrompt: boolean;
  supportsStreaming: boolean;
  regionProfiles: Record<string, string>;
}

/**
 * Resolved model configuration for a scope (default `platform`). The
 * `slotDefaults`, `orgDefaults` and `agentOverrides` maps are AWSJSON on the
 * backend and are parsed on read into plain `slot -> modelKey` maps.
 */
export interface ModelConfig {
  scope: string;
  globalDefaultKey?: string | null;
  slotDefaults: Record<string, string>;
  orgDefaults: Record<string, string>;
  agentOverrides: Record<string, string>;
  localityMode: string;
  updatedAt?: string;
  updatedBy?: string;
}

const listModelCatalogQuery = `
  query ListModelCatalog {
    listModelCatalog {
      modelKey
      provider
      baseModelId
      status
      modality
      invocationMode
      supportsTools
      supportsSystemPrompt
      supportsStreaming
      regionProfiles
    }
  }
`;

const getModelConfigQuery = `
  query GetModelConfig($scope: String) {
    getModelConfig(scope: $scope) {
      scope
      globalDefaultKey
      slotDefaults
      orgDefaults
      agentOverrides
      localityMode
      updatedAt
      updatedBy
    }
  }
`;

const updateModelConfigMutation = `
  mutation UpdateModelConfig($input: UpdateModelConfigInput!) {
    updateModelConfig(input: $input) {
      scope
      globalDefaultKey
      slotDefaults
      orgDefaults
      agentOverrides
      localityMode
      updatedAt
      updatedBy
    }
  }
`;

const setModelCatalogEntryStatusMutation = `
  mutation SetModelCatalogEntryStatus($modelKey: String!, $status: String!) {
    setModelCatalogEntryStatus(modelKey: $modelKey, status: $status) {
      modelKey
      provider
      baseModelId
      status
      modality
      invocationMode
      supportsTools
      supportsSystemPrompt
      supportsStreaming
      regionProfiles
    }
  }
`;

/**
 * Safely parse an AWSJSON field. AppSync returns AWSJSON scalars as JSON
 * strings, but a resolver may also hand back an already-parsed object. When a
 * string fails to parse we fall back rather than crashing the whole flow.
 */
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}

/** Normalize a raw catalog entry, parsing its AWSJSON `regionProfiles`. */
function normalizeCatalogEntry(entry: any): ModelCatalogEntry {
  return {
    ...entry,
    regionProfiles: parseJson<Record<string, string>>(entry?.regionProfiles, {}),
  };
}

/** Normalize a raw config record, parsing its three AWSJSON map fields. */
function normalizeConfig(config: any): ModelConfig {
  return {
    ...config,
    slotDefaults: parseJson<Record<string, string>>(config?.slotDefaults, {}),
    orgDefaults: parseJson<Record<string, string>>(config?.orgDefaults, {}),
    agentOverrides: parseJson<Record<string, string>>(config?.agentOverrides, {}),
  };
}

export interface UpdateModelConfigInput {
  scope?: string;
  globalDefaultKey?: string | null;
  slotDefaults?: Record<string, string>;
  localityMode?: string;
}

export const modelConfigService = {
  async listModelCatalog(): Promise<ModelCatalogEntry[]> {
    try {
      const response = await serverService.query<{ listModelCatalog: any[] }>(
        listModelCatalogQuery
      );

      return (response.listModelCatalog || []).map(normalizeCatalogEntry);
    } catch (error) {
      console.error('Error listing model catalog:', error);
      throw error;
    }
  },

  async getModelConfig(scope = 'platform'): Promise<ModelConfig | null> {
    try {
      const response = await serverService.query<{ getModelConfig: any }>(
        getModelConfigQuery,
        { scope }
      );

      const config = response.getModelConfig;
      if (!config) return null;

      return normalizeConfig(config);
    } catch (error) {
      console.error('Error getting model config:', error);
      throw error;
    }
  },

  async updateModelConfig(input: UpdateModelConfigInput): Promise<ModelConfig> {
    try {
      const response = await serverService.mutate<{ updateModelConfig: any }>(
        updateModelConfigMutation,
        {
          input: {
            ...input,
            // slotDefaults is an AWSJSON field — stringify when provided.
            slotDefaults:
              input.slotDefaults !== undefined
                ? JSON.stringify(input.slotDefaults)
                : undefined,
          },
        }
      );

      return normalizeConfig(response.updateModelConfig);
    } catch (error) {
      console.error('Error updating model config:', error);
      throw error;
    }
  },

  async setModelCatalogEntryStatus(
    modelKey: string,
    status: string
  ): Promise<ModelCatalogEntry> {
    try {
      const response = await serverService.mutate<{
        setModelCatalogEntryStatus: any;
      }>(setModelCatalogEntryStatusMutation, { modelKey, status });

      return normalizeCatalogEntry(response.setModelCatalogEntryStatus);
    } catch (error) {
      console.error('Error setting model catalog entry status:', error);
      throw error;
    }
  },
};

export default modelConfigService;
