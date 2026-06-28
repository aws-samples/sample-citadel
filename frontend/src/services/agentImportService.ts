/**
 * agentImportService (US-IMP)
 *
 * Typed frontend wrapper over the agent-import GraphQL operations the backend
 * exposes: `discoverAgents`, `describeAgentCandidate`, `importAgent`, and
 * `attestAgentImport`. This is the foundation the Import Wizard UI consumes —
 * no UI lives here.
 *
 * Mirrors `agentConfigService`: same `serverService` query/mutate entrypoints,
 * the same try/catch + `console.error` + rethrow error surface, and the same
 * AWSJSON convention — AWSJSON payloads are parsed on the way out, and the
 * `config` field on any returned `AgentConfig` record is parsed into an object.
 */

import serverService from './server';
import type { AgentConfig } from './agentConfigService';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  DiscoverAgentsInput,
  ImportAgentInput,
  ImportAgentResult,
} from '../types/agentImport';

const discoverAgentsQuery = `
  query DiscoverAgents($input: DiscoverAgentsInput!) {
    discoverAgents(input: $input) {
      displayName
      reference
      substrate
      sourceArn
      region
      account
      ownership
      discoveredAt
    }
  }
`;

// `describeAgentCandidate` returns the AWSJSON scalar (a JSON string), so the
// operation has no sub-selection set.
const describeAgentCandidateQuery = `
  query DescribeAgentCandidate($ref: String!) {
    describeAgentCandidate(ref: $ref)
  }
`;

const importAgentMutation = `
  mutation ImportAgent($input: ImportAgentInput!) {
    importAgent(input: $input) {
      agent {
        agentId
        name
        config
        state
        categories
        createdAt
        updatedAt
      }
      conflict
      existingId
      reason
      options
    }
  }
`;

const attestAgentImportMutation = `
  mutation AttestAgentImport($agentId: ID!) {
    attestAgentImport(agentId: $agentId) {
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

/**
 * Parse an AgentConfig's AWSJSON `config` field. Most records store JSON, but
 * some legacy/registry-backed records carry free text. On parse failure we
 * keep the raw value so the UI can still render it as a string instead of
 * crashing — identical to agentConfigService's `parseAgentConfig`.
 */
function parseAgentConfig(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Apply config parsing to a returned AgentConfig record (passing null through). */
function normalizeAgent(agent: AgentConfig | null | undefined): AgentConfig | null {
  if (!agent) return null;
  return { ...agent, config: parseAgentConfig(agent.config) };
}

/**
 * Parse the AWSJSON capability descriptor returned by `describeAgentCandidate`.
 * The resolver returns a JSON STRING; we parse it into the typed descriptor.
 * Unlike `config`, a malformed payload is a hard error — there is no
 * meaningful string fallback for the structured descriptor the wizard renders.
 */
function parseCapabilityDescriptor(raw: unknown): AgentCapabilityDescriptor {
  // Defensive: some clients/configs may surface AWSJSON already parsed.
  if (raw !== null && typeof raw === 'object') {
    return raw as AgentCapabilityDescriptor;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as AgentCapabilityDescriptor;
    } catch {
      throw new Error(
        'Failed to parse agent capability descriptor: describeAgentCandidate returned malformed AWSJSON'
      );
    }
  }
  throw new Error(
    'Failed to parse agent capability descriptor: describeAgentCandidate returned no descriptor'
  );
}

export const agentImportService = {
  /**
   * Enumerate importable agents for a discovery source (SCAN / PASTE /
   * MANIFEST). Returns the flat candidate array (never null).
   */
  async discoverAgents(input: DiscoverAgentsInput): Promise<AgentCandidate[]> {
    try {
      const response = await serverService.query<{ discoverAgents: AgentCandidate[] }>(
        discoverAgentsQuery,
        { input }
      );

      return response.discoverAgents || [];
    } catch (error) {
      console.error('Error discovering agents:', error);
      throw error;
    }
  },

  /**
   * Resolve a discovered candidate's opaque `ref` to its capability descriptor.
   * The AWSJSON result is JSON-parsed into a typed descriptor; a malformed
   * payload throws a clear error.
   */
  async describeAgentCandidate(ref: string): Promise<AgentCapabilityDescriptor> {
    try {
      const response = await serverService.query<{ describeAgentCandidate: string }>(
        describeAgentCandidateQuery,
        { ref }
      );

      return parseCapabilityDescriptor(response.describeAgentCandidate);
    } catch (error) {
      console.error('Error describing agent candidate:', error);
      throw error;
    }
  },

  /**
   * Import an agent. On success returns `{ agent, conflict: false }`; on an
   * unresolved collision returns `{ agent: null, conflict: true, existingId,
   * reason, options }`. The returned agent's `config` is parsed into an object.
   */
  async importAgent(input: ImportAgentInput): Promise<ImportAgentResult> {
    try {
      const response = await serverService.mutate<{ importAgent: ImportAgentResult }>(
        importAgentMutation,
        { input }
      );

      const result = response.importAgent;
      return { ...result, agent: normalizeAgent(result.agent) };
    } catch (error) {
      console.error('Error importing agent:', error);
      throw error;
    }
  },

  /**
   * Attest a previously imported agent, transitioning it to an attested state.
   * Returns the updated AgentConfig with its `config` parsed into an object.
   */
  async attestAgentImport(agentId: string): Promise<AgentConfig> {
    try {
      const response = await serverService.mutate<{ attestAgentImport: AgentConfig }>(
        attestAgentImportMutation,
        { agentId }
      );

      const agent = normalizeAgent(response.attestAgentImport);
      if (!agent) {
        throw new Error('attestAgentImport returned no agent');
      }
      return agent;
    } catch (error) {
      console.error('Error attesting agent import:', error);
      throw error;
    }
  },
};
