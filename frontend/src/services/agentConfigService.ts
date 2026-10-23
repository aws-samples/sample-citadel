import serverService from './server';
import { cached, invalidate } from './queryCache';

export interface AgentConfig {
  agentId: string;
  /** Display name of the agent. Returned by Registry-backed records and
   * preferred over agentId for UI labels. May be absent on legacy DynamoDB
   * rows where the name was stored inside config.name instead. */
  name?: string;
  /** Top-level description returned by the resolver. Preferred over
   * config.description for display — config.description is the legacy
   * fallback for rows where the description was nested inside the AWSJSON
   * config blob. */
  description?: string;
  config: any;
  state: 'active' | 'inactive' | 'maintenance';
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
  /**
   * Raw Registry record status (e.g. "DRAFT", "APPROVED"), present only on
   * records backed by a Registry record. Null/undefined on legacy,
   * non-registry rows. This is the explicit, non-heuristic discriminator
   * clients should use to tell registry-backed records from legacy ones —
   * do not infer it from `name` or any other field (finding 414f8013).
   */
  registryStatus?: string | null;
  /** Cognito userId of the admin who approved/rejected (set server-side). */
  decidedBy?: string | null;
  /** ISO timestamp of the approval/rejection decision (set server-side). */
  decidedAt?: string | null;
  /** Reason text — required for REJECTED, optional for APPROVED. */
  statusReason?: string | null;
  /** Resource tags (key=value pairs, AWSJSON on the wire). */
  tags?: Record<string, string> | null;
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
      description
      config
      state
      categories
      tags
      registryStatus
      decidedBy
      decidedAt
      statusReason
      createdAt
      updatedAt
    }
  }
`;

const getAgentConfigQuery = `
  query GetAgentConfig($agentId: String!) {
    getAgentConfig(agentId: $agentId) {
      agentId
      name
      description
      config
      state
      categories
      tags
      registryStatus
      decidedBy
      decidedAt
      statusReason
      createdAt
      updatedAt
    }
  }
`;

const searchAgentConfigsQuery = `
  query SearchAgentConfigs($query: String!) {
    searchAgentConfigs(query: $query) {
      agentId
      name
      description
      config
      state
      categories
      tags
      registryStatus
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
      tags
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
      tags
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
 * The wire value can arrive in three shapes:
 *   1. A JSON string — the normal resolver path.  → JSON.parse it.
 *   2. An already-parsed object — Amplify may pre-parse AWSJSON scalars
 *      before the response reaches service code.  → Use as-is.
 *   3. A non-JSON string (legacy free-text description, or garbage)
 *      → Fall back to an empty object so callers can always dot-access
 *        config properties without guarding against a string.
 *
 * The function never throws.
 */
function parseAgentConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    // JSON.parse('42') or JSON.parse('"hello"') are valid JSON but not
    // useful as config objects — treat them the same as non-JSON strings.
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return {};
  } catch {
    return {};
  }
}

export const agentConfigService = {
  async listAgentConfigs(): Promise<AgentConfig[]> {
    return cached('agentConfigs:list', async () => {
      try {
        const response = await serverService.query<{ listAgentConfigs: AgentConfig[] }>(
          listAgentConfigsQuery
        );
        
        return (response.listAgentConfigs || []).map((agent: any) => ({
          ...agent,
          config: parseAgentConfig(agent.config),
          tags: typeof agent.tags === 'string' ? JSON.parse(agent.tags) : agent.tags,
        }));
      } catch (error) {
        console.error('Error listing agent configs:', error);
        throw error;
      }
    });
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
        tags: typeof agent.tags === 'string' ? JSON.parse(agent.tags) : agent.tags,
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
        tags: typeof agent.tags === 'string' ? JSON.parse(agent.tags) : agent.tags,
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
    tags?: Record<string, string>;
  }): Promise<AgentConfig> {
    try {
      const response = await serverService.mutate<{ createAgentConfig: AgentConfig }>(
        createAgentConfigMutation,
        {
          input: {
            ...input,
            config: JSON.stringify(input.config),
            tags: input.tags ? JSON.stringify(input.tags) : undefined,
          },
        }
      );
      
      const agent = response.createAgentConfig;
      invalidate('agentConfigs:');
      return {
        ...agent,
        config: parseAgentConfig(agent.config),
        tags: typeof agent.tags === 'string' ? JSON.parse(agent.tags) : agent.tags,
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
    tags?: Record<string, string>;
  }): Promise<AgentConfig> {
    try {
      const response = await serverService.mutate<{ updateAgentConfig: AgentConfig }>(
        updateAgentConfigMutation,
        {
          input: {
            ...input,
            config: input.config ? JSON.stringify(input.config) : undefined,
            tags: input.tags ? JSON.stringify(input.tags) : undefined,
          },
        }
      );
      
      const agent = response.updateAgentConfig;
      invalidate('agentConfigs:');
      return {
        ...agent,
        config: parseAgentConfig(agent.config),
        tags: typeof agent.tags === 'string' ? JSON.parse(agent.tags) : agent.tags,
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
      
      invalidate('agentConfigs:');
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

      invalidate('agentConfigs:');
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
