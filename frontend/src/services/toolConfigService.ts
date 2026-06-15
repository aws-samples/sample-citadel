import serverService from './server';

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

export interface ToolConfig {
  toolId: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance';
  categories?: string[];
  integrationBindings?: IntegrationBinding[] | null;
  dataStoreBindings?: DataStoreBinding[] | null;
  createdAt?: string;
  updatedAt?: string;
}

const listToolConfigsQuery = `
  query ListToolConfigs {
    listToolConfigs {
      toolId
      config
      state
      categories
      integrationBindings { integrationId integrationType operations direction }
      dataStoreBindings { dataStoreId dataStoreType operations direction }
      createdAt
      updatedAt
    }
  }
`;

const getToolConfigQuery = `
  query GetToolConfig($toolId: String!) {
    getToolConfig(toolId: $toolId) {
      toolId
      config
      state
      categories
      integrationBindings { integrationId integrationType operations direction }
      dataStoreBindings { dataStoreId dataStoreType operations direction }
      createdAt
      updatedAt
    }
  }
`;

const searchToolConfigsQuery = `
  query SearchToolConfigs($query: String!) {
    searchToolConfigs(query: $query) {
      toolId
      config
      state
      categories
      integrationBindings { integrationId integrationType operations direction }
      dataStoreBindings { dataStoreId dataStoreType operations direction }
      createdAt
      updatedAt
    }
  }
`;

const createToolConfigMutation = `
  mutation CreateToolConfig($input: CreateToolConfigInput!) {
    createToolConfig(input: $input) {
      toolId
      config
      state
      categories
      integrationBindings { integrationId integrationType operations direction }
      dataStoreBindings { dataStoreId dataStoreType operations direction }
      createdAt
      updatedAt
    }
  }
`;

const updateToolConfigMutation = `
  mutation UpdateToolConfig($input: UpdateToolConfigInput!) {
    updateToolConfig(input: $input) {
      toolId
      config
      state
      categories
      integrationBindings { integrationId integrationType operations direction }
      dataStoreBindings { dataStoreId dataStoreType operations direction }
      createdAt
      updatedAt
    }
  }
`;

const deleteToolConfigMutation = `
  mutation DeleteToolConfig($toolId: String!) {
    deleteToolConfig(toolId: $toolId) {
      success
      message
    }
  }
`;

export const toolConfigService = {
  async listToolConfigs(): Promise<ToolConfig[]> {
    try {
      const response = await serverService.query<{ listToolConfigs: ToolConfig[] }>(
        listToolConfigsQuery
      );
      
      return (response.listToolConfigs || []).map((tool: any) => ({
        ...tool,
        config: typeof tool.config === 'string' ? JSON.parse(tool.config) : tool.config,
      }));
    } catch (error) {
      console.error('Error listing tool configs:', error);
      throw error;
    }
  },

  async getToolConfig(toolId: string): Promise<ToolConfig | null> {
    try {
      const response = await serverService.query<{ getToolConfig: ToolConfig | null }>(
        getToolConfigQuery,
        { toolId }
      );
      
      const tool = response.getToolConfig;
      if (!tool) return null;
      
      return {
        ...tool,
        config: typeof tool.config === 'string' ? JSON.parse(tool.config) : tool.config,
      };
    } catch (error) {
      console.error('Error getting tool config:', error);
      throw error;
    }
  },

  async searchToolConfigs(query: string): Promise<ToolConfig[]> {
    try {
      const response = await serverService.query<{ searchToolConfigs: ToolConfig[] }>(
        searchToolConfigsQuery,
        { query }
      );

      return (response.searchToolConfigs || []).map((tool: any) => ({
        ...tool,
        config: typeof tool.config === 'string' ? JSON.parse(tool.config) : tool.config,
      }));
    } catch (error) {
      console.warn('Semantic search failed, falling back to client-side filtering:', error);
      const all = await this.listToolConfigs();
      const normalized = (query || '').trim().toLowerCase();
      if (!normalized) return all;

      return all.filter((tool) => {
        const haystacks: string[] = [tool.toolId];
        if (tool.config && typeof tool.config === 'object') {
          const cfg = tool.config as Record<string, any>;
          if (typeof cfg.name === 'string') haystacks.push(cfg.name);
          if (typeof cfg.description === 'string') haystacks.push(cfg.description);
        }
        if (Array.isArray(tool.categories)) {
          haystacks.push(...tool.categories);
        }
        return haystacks.some((h) => typeof h === 'string' && h.toLowerCase().includes(normalized));
      });
    }
  },

  async createToolConfig(input: {
    toolId: string;
    config: any;
    state?: 'active' | 'inactive' | 'maintenance';
    categories?: string[];
    integrationBindings?: IntegrationBinding[];
    dataStoreBindings?: DataStoreBinding[];
  }): Promise<ToolConfig> {
    try {
      const response = await serverService.mutate<{ createToolConfig: ToolConfig }>(
        createToolConfigMutation,
        {
          input: {
            ...input,
            config: JSON.stringify(input.config),
          },
        }
      );
      
      const tool = response.createToolConfig;
      return {
        ...tool,
        config: typeof tool.config === 'string' ? JSON.parse(tool.config) : tool.config,
      };
    } catch (error) {
      console.error('Error creating tool config:', error);
      throw error;
    }
  },

  async updateToolConfig(input: {
    toolId: string;
    config?: any;
    state?: 'active' | 'inactive' | 'maintenance';
    categories?: string[];
    integrationBindings?: IntegrationBinding[];
    dataStoreBindings?: DataStoreBinding[];
  }): Promise<ToolConfig> {
    try {
      const response = await serverService.mutate<{ updateToolConfig: ToolConfig }>(
        updateToolConfigMutation,
        {
          input: {
            ...input,
            config: input.config ? JSON.stringify(input.config) : undefined,
          },
        }
      );
      
      const tool = response.updateToolConfig;
      return {
        ...tool,
        config: typeof tool.config === 'string' ? JSON.parse(tool.config) : tool.config,
      };
    } catch (error) {
      console.error('Error updating tool config:', error);
      throw error;
    }
  },

  async deleteToolConfig(toolId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await serverService.mutate<{ deleteToolConfig: { success: boolean; message?: string } }>(
        deleteToolConfigMutation,
        { toolId }
      );
      
      return response.deleteToolConfig;
    } catch (error) {
      console.error('Error deleting tool config:', error);
      throw error;
    }
  },
};
