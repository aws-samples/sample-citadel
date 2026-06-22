import serverService from './server';

export interface AgentConfig {
  agentId: string;
  /** Display name of the agent. Returned by Registry-backed records and
   * preferred over agentId for UI labels. May be absent on legacy DynamoDB
   * rows where the name was stored inside config.name instead. */
  name?: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance';
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** Outcome of a bulk project-agent activation, grouped by per-agent result. */
export interface ActivateAgentsResult {
  activated: string[];
  failed: string[];
  alreadyActive: string[];
}

const listAgentConfigsQuery = `
  query ListAgentConfigs {
    listAgentConfigs {
      agentId
      name
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

const activateProjectAgentsMutation = `
  mutation ActivateProjectAgents($projectId: ID!) {
    activateProjectAgents(projectId: $projectId) {
      activated
      failed
      alreadyActive
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

/**
 * Parse an agent's `config` field returned by the resolver.
 *
 * The resolver returns `config` as a string. Most agents store JSON there,
 * but some legacy/registry-backed records carry a free-text description
 * instead (e.g. seeded fabricator/orchestrator agents). When parsing fails
 * we keep the raw value so the UI can still render it as a string instead
 * of crashing the whole flow with a JSON.parse error.
 */
function parseAgentConfig(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const agentConfigService = {
  async listAgentConfigs(): Promise<AgentConfig[]> {
    try {
      const response = await serverService.query<{ listAgentConfigs: AgentConfig[] }>(
        listAgentConfigsQuery
      );
      
      return (response.listAgentConfigs || []).map((agent: any) => ({
        ...agent,
        config: parseAgentConfig(agent.config),
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
        config: parseAgentConfig(agent.config),
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
        config: parseAgentConfig(agent.config),
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
        config: parseAgentConfig(agent.config),
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
        config: parseAgentConfig(agent.config),
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

  /**
   * Activates every fabricated agent belonging to a project in one call.
   * Returns the per-agent outcome grouped into activated / failed /
   * alreadyActive name lists. Never partially throws — the backend swallows
   * per-agent errors and reports them in `failed`.
   */
  async activateProjectAgents(projectId: string): Promise<ActivateAgentsResult> {
    try {
      const response = await serverService.mutate<{ activateProjectAgents: ActivateAgentsResult }>(
        activateProjectAgentsMutation,
        { projectId }
      );

      return response.activateProjectAgents;
    } catch (error) {
      console.error('Error activating project agents:', error);
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
