import serverService from './server';

export interface AgentConfig {
  agentId: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance';
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
}

const listAgentConfigsQuery = `
  query ListAgentConfigs {
    listAgentConfigs {
      agentId
      config
      state
      categories
      createdAt
      updatedAt
    }
  }
`;

const getAgentConfigQuery = `
  query GetAgentConfig($agentId: String!) {
    getAgentConfig(agentId: $agentId) {
      agentId
      config
      state
      categories
      createdAt
      updatedAt
    }
  }
`;

const searchAgentConfigsQuery = `
  query SearchAgentConfigs($query: String!) {
    searchAgentConfigs(query: $query) {
      agentId
      config
      state
      categories
      createdAt
      updatedAt
    }
  }
`;

const createAgentConfigMutation = `
  mutation CreateAgentConfig($input: CreateAgentConfigInput!) {
    createAgentConfig(input: $input) {
      agentId
      config
      state
      categories
      createdAt
      updatedAt
    }
  }
`;

const updateAgentConfigMutation = `
  mutation UpdateAgentConfig($input: UpdateAgentConfigInput!) {
    updateAgentConfig(input: $input) {
      agentId
      config
      state
      categories
      createdAt
      updatedAt
    }
  }
`;

const deleteAgentConfigMutation = `
  mutation DeleteAgentConfig($agentId: String!) {
    deleteAgentConfig(agentId: $agentId) {
      success
      message
    }
  }
`;

const getAgentCodeQuery = `
  query GetAgentCode($agentId: String!) {
    getAgentCode(agentId: $agentId) {
      agentId
      code
      version
      lastModified
    }
  }
`;

const updateAgentCodeMutation = `
  mutation UpdateAgentCode($input: UpdateAgentCodeInput!) {
    updateAgentCode(input: $input) {
      agentId
      code
      version
      lastModified
    }
  }
`;

export const agentConfigService = {
  async listAgentConfigs(): Promise<AgentConfig[]> {
    try {
      const response = await serverService.query<{ listAgentConfigs: AgentConfig[] }>(
        listAgentConfigsQuery
      );
      
      return (response.listAgentConfigs || []).map((agent: any) => ({
        ...agent,
        config: typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config,
      }));
    } catch (error) {
      console.error('Error listing agent configs:', error);
      throw error;
    }
  },

  async getAgentConfig(agentId: string): Promise<AgentConfig | null> {
    try {
      const response = await serverService.query<{ getAgentConfig: AgentConfig | null }>(
        getAgentConfigQuery,
        { agentId }
      );
      
      const agent = response.getAgentConfig;
      if (!agent) return null;
      
      return {
        ...agent,
        config: typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config,
      };
    } catch (error) {
      console.error('Error getting agent config:', error);
      throw error;
    }
  },

  async searchAgentConfigs(query: string): Promise<AgentConfig[]> {
    try {
      const response = await serverService.query<{ searchAgentConfigs: AgentConfig[] }>(
        searchAgentConfigsQuery,
        { query }
      );

      return (response.searchAgentConfigs || []).map((agent: any) => ({
        ...agent,
        config: typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config,
      }));
    } catch (error) {
      console.warn('Semantic search failed, falling back to client-side filtering:', error);
      const all = await this.listAgentConfigs();
      const normalized = (query || '').trim().toLowerCase();
      if (!normalized) return all;

      return all.filter((agent) => {
        const haystacks: string[] = [agent.agentId];
        if (agent.config && typeof agent.config === 'object') {
          const cfg = agent.config as Record<string, any>;
          if (typeof cfg.name === 'string') haystacks.push(cfg.name);
          if (typeof cfg.description === 'string') haystacks.push(cfg.description);
        }
        if (Array.isArray(agent.categories)) {
          haystacks.push(...agent.categories);
        }
        return haystacks.some((h) => typeof h === 'string' && h.toLowerCase().includes(normalized));
      });
    }
  },

  async createAgentConfig(input: {
    agentId: string;
    config: any;
    state?: 'active' | 'inactive' | 'maintenance';
    categories?: string[];
  }): Promise<AgentConfig> {
    try {
      const response = await serverService.mutate<{ createAgentConfig: AgentConfig }>(
        createAgentConfigMutation,
        {
          input: {
            ...input,
            config: JSON.stringify(input.config),
          },
        }
      );
      
      const agent = response.createAgentConfig;
      return {
        ...agent,
        config: typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config,
      };
    } catch (error) {
      console.error('Error creating agent config:', error);
      throw error;
    }
  },

  async updateAgentConfig(input: {
    agentId: string;
    config?: any;
    state?: 'active' | 'inactive' | 'maintenance';
    categories?: string[];
  }): Promise<AgentConfig> {
    try {
      const response = await serverService.mutate<{ updateAgentConfig: AgentConfig }>(
        updateAgentConfigMutation,
        {
          input: {
            ...input,
            config: input.config ? JSON.stringify(input.config) : undefined,
          },
        }
      );
      
      const agent = response.updateAgentConfig;
      return {
        ...agent,
        config: typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config,
      };
    } catch (error) {
      console.error('Error updating agent config:', error);
      throw error;
    }
  },

  async deleteAgentConfig(agentId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await serverService.mutate<{ deleteAgentConfig: { success: boolean; message?: string } }>(
        deleteAgentConfigMutation,
        { agentId }
      );
      
      return response.deleteAgentConfig;
    } catch (error) {
      console.error('Error deleting agent config:', error);
      throw error;
    }
  },

  async getAgentCode(agentId: string): Promise<{ agentId: string; code: string; version?: string; lastModified?: string }> {
    try {
      const response = await serverService.query<{ getAgentCode: { agentId: string; code: string; version?: string; lastModified?: string } }>(
        getAgentCodeQuery,
        { agentId }
      );
      
      return response.getAgentCode;
    } catch (error) {
      console.error('Error getting agent code:', error);
      throw error;
    }
  },

  async updateAgentCode(agentId: string, code: string): Promise<{ agentId: string; code: string; version?: string; lastModified?: string }> {
    try {
      const response = await serverService.mutate<{ updateAgentCode: { agentId: string; code: string; version?: string; lastModified?: string } }>(
        updateAgentCodeMutation,
        {
          input: { agentId, code },
        }
      );
      
      return response.updateAgentCode;
    } catch (error) {
      console.error('Error updating agent code:', error);
      throw error;
    }
  },
};
