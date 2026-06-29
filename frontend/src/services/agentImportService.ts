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
  AgentImportRecord,
  DiscoverAgentsInput,
  ImportAgentInput,
  ImportAgentResult,
  ImportTestResult,
  ProposedManifest,
  ProposedManifestConfidence,
  ProposedManifestReviewState,
  TestImportedAgentInput,
  Tier3ProposalResult,
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
// operation has no sub-selection set. The optional cross-account discovery
// variables are nullable — omitting them from the variables object leaves the
// backend's same-account describe path unchanged (back-compat).
const describeAgentCandidateQuery = `
  query DescribeAgentCandidate(
    $ref: String!
    $discoveryRoleArn: String
    $discoveryExternalId: String
  ) {
    describeAgentCandidate(
      ref: $ref
      discoveryRoleArn: $discoveryRoleArn
      discoveryExternalId: $discoveryExternalId
    )
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

// Pre-activation TEST-INVOKE. Returns a plain ImportTestResult (no AWSJSON / no
// sub-record) — a reachability failure surfaces as `ok: false`, not an error.
const testImportedAgentMutation = `
  mutation TestImportedAgent($input: TestImportedAgentInput!) {
    testImportedAgent(input: $input) {
      ok
      output
      error
      latencyMs
    }
  }
`;

// Shared selection for the UNTRUSTED, LLM-proposed manifest parked on a DRAFT
// import record (Tier-3). `manifest` and `fieldConfidence` are AWSJSON scalars
// (JSON strings) — parsed into objects by `normalizeProposedManifest`. Fields
// mirror the GraphQL `ProposedManifest` type exactly (no reviewedBy/reviewedAt:
// the schema does not expose them).
const proposedManifestSelection = `
  proposedManifest {
    manifest
    confidence
    reviewState
    source
    fieldConfidence
    proposedAt
    correlationId
    sanitized
    truncated
    error
  }
`;

// Tier-3 ASYNC manifest-proposal REQUEST. Returns only { requestId, status };
// the proposed manifest lands later on the DRAFT record's `proposedManifest`.
// The optional cross-account discovery variables are nullable — omitting them
// leaves the same-account signal-gathering path unchanged (back-compat).
const proposeAgentManifestTier3Mutation = `
  mutation ProposeAgentManifestTier3(
    $ref: String!
    $discoveryRoleArn: String
    $discoveryExternalId: String
  ) {
    proposeAgentManifestTier3(
      ref: $ref
      discoveryRoleArn: $discoveryRoleArn
      discoveryExternalId: $discoveryExternalId
    ) {
      requestId
      status
    }
  }
`;

// Human-only ACCEPT step: promotes a pending proposedManifest into the record's
// trusted manifest. The record STAYS DRAFT (never auto-activated). Returns the
// updated AgentConfig; we re-select proposedManifest to reflect the accepted
// review state back to the UI.
const acceptProposedManifestTier3Mutation = `
  mutation AcceptProposedManifestTier3($importId: String!) {
    acceptProposedManifestTier3(importId: $importId) {
      agentId
      name
      config
      state
      categories
      createdAt
      updatedAt
      ${proposedManifestSelection}
    }
  }
`;

// Import-record fetch: the DRAFT record (an AgentConfig) including the parked
// proposedManifest. Used to poll for the async Tier-3 result and to reflect the
// accepted state. Reuses the existing `getAgentConfig` field.
const getImportRecordQuery = `
  query GetAgentImportRecord($agentId: String!) {
    getAgentConfig(agentId: $agentId) {
      agentId
      name
      config
      state
      categories
      createdAt
      updatedAt
      ${proposedManifestSelection}
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

/**
 * Parse an AWSJSON scalar that should hold a JSON object (e.g. a proposed
 * manifest or a fieldConfidence map). Returns the object, passing an
 * already-parsed object through, and yielding `null` for absent/non-object/
 * malformed payloads (the UI renders "no body" rather than crashing).
 */
function parseAwsJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Raw `ProposedManifest` as returned by GraphQL (AWSJSON fields unparsed). */
interface RawProposedManifest {
  manifest?: unknown;
  confidence?: string | null;
  reviewState?: string | null;
  source?: string | null;
  fieldConfidence?: unknown;
  proposedAt?: string | null;
  correlationId?: string | null;
  sanitized?: boolean | null;
  truncated?: boolean | null;
  error?: string | null;
}

/** Raw import record (an AgentConfig) as returned by GraphQL. */
interface RawImportRecord {
  agentId: string;
  name?: string | null;
  config?: unknown;
  state?: AgentConfig['state'];
  categories?: string[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  proposedManifest?: RawProposedManifest | null;
}

/** Normalize a raw proposed manifest: parse its AWSJSON manifest/fieldConfidence. */
function normalizeProposedManifest(
  raw: RawProposedManifest | null | undefined
): ProposedManifest | null {
  if (!raw) return null;
  return {
    manifest: parseAwsJsonObject(raw.manifest),
    confidence: (raw.confidence ?? null) as ProposedManifestConfidence | null,
    reviewState: (raw.reviewState ?? 'pending_review') as ProposedManifestReviewState,
    source: raw.source ?? null,
    fieldConfidence: parseAwsJsonObject(raw.fieldConfidence) as
      | Record<string, ProposedManifestConfidence>
      | null,
    proposedAt: raw.proposedAt ?? null,
    correlationId: raw.correlationId ?? null,
    sanitized: raw.sanitized ?? null,
    truncated: raw.truncated ?? null,
    error: raw.error ?? null,
  };
}

/** Normalize a raw import record: parse `config` and the parked proposedManifest. */
function normalizeImportRecord(
  raw: RawImportRecord | null | undefined
): AgentImportRecord | null {
  if (!raw) return null;
  return {
    agentId: raw.agentId,
    name: raw.name ?? undefined,
    config: parseAgentConfig(raw.config),
    state: raw.state ?? 'inactive',
    categories: raw.categories ?? undefined,
    createdAt: raw.createdAt ?? undefined,
    updatedAt: raw.updatedAt ?? undefined,
    proposedManifest: normalizeProposedManifest(raw.proposedManifest),
  };
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
   *
   * For a cross-account SCAN-discovered candidate, pass the same read-only
   * discovery role + external ID used for the scan via `opts`; they are sent as
   * query variables only when present (existing same-account callers omit them
   * entirely — back-compat).
   */
  async describeAgentCandidate(
    ref: string,
    opts?: { discoveryRoleArn?: string; discoveryExternalId?: string }
  ): Promise<AgentCapabilityDescriptor> {
    try {
      const variables: {
        ref: string;
        discoveryRoleArn?: string;
        discoveryExternalId?: string;
      } = { ref };
      if (opts?.discoveryRoleArn) variables.discoveryRoleArn = opts.discoveryRoleArn;
      if (opts?.discoveryExternalId) {
        variables.discoveryExternalId = opts.discoveryExternalId;
      }

      const response = await serverService.query<{ describeAgentCandidate: string }>(
        describeAgentCandidateQuery,
        variables
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

  /**
   * Pre-activation test-invoke of a candidate's assembled invocation config.
   * Returns the typed result verbatim: `ok: true` carries a sanitized `output`
   * (+ `latencyMs`); `ok: false` carries the `error`. A reachability failure is
   * a normal `ok: false` result — only transport/GraphQL faults reject.
   */
  async testImportedAgent(input: TestImportedAgentInput): Promise<ImportTestResult> {
    try {
      const response = await serverService.mutate<{ testImportedAgent: ImportTestResult }>(
        testImportedAgentMutation,
        { input }
      );

      return response.testImportedAgent;
    } catch (error) {
      console.error('Error testing imported agent:', error);
      throw error;
    }
  },

  /**
   * Tier-3 ASYNC manifest-proposal REQUEST. Enqueues an LLM manifest proposal
   * for `ref`; the proposed manifest lands LATER on the DRAFT record's
   * `proposedManifest` (poll via `getImportRecord`). Returns `{ requestId,
   * status }` ('PENDING' on a successful enqueue) — it never mutates the record.
   *
   * For a cross-account SCAN-discovered candidate, pass the same read-only
   * discovery role + external ID via `opts`; they are sent as variables only
   * when present (same-account callers omit them — back-compat).
   */
  async proposeAgentManifestTier3(
    ref: string,
    opts?: { discoveryRoleArn?: string; discoveryExternalId?: string }
  ): Promise<Tier3ProposalResult> {
    try {
      const variables: {
        ref: string;
        discoveryRoleArn?: string;
        discoveryExternalId?: string;
      } = { ref };
      if (opts?.discoveryRoleArn) variables.discoveryRoleArn = opts.discoveryRoleArn;
      if (opts?.discoveryExternalId) {
        variables.discoveryExternalId = opts.discoveryExternalId;
      }

      const response = await serverService.mutate<{
        proposeAgentManifestTier3: Tier3ProposalResult;
      }>(proposeAgentManifestTier3Mutation, variables);

      return response.proposeAgentManifestTier3;
    } catch (error) {
      console.error('Error proposing Tier-3 agent manifest:', error);
      throw error;
    }
  },

  /**
   * Human-only ACCEPT: promotes a pending `proposedManifest` into the record's
   * trusted manifest. The record STAYS DRAFT and is NOT activated. Returns the
   * updated import record with its `config` parsed and the (now accepted)
   * `proposedManifest` normalized.
   */
  async acceptProposedManifestTier3(importId: string): Promise<AgentImportRecord> {
    try {
      const response = await serverService.mutate<{
        acceptProposedManifestTier3: RawImportRecord;
      }>(acceptProposedManifestTier3Mutation, { importId });

      const record = normalizeImportRecord(response.acceptProposedManifestTier3);
      if (!record) {
        throw new Error('acceptProposedManifestTier3 returned no record');
      }
      return record;
    } catch (error) {
      console.error('Error accepting proposed Tier-3 manifest:', error);
      throw error;
    }
  },

  /**
   * Fetch a DRAFT import record (an AgentConfig) including the parked
   * `proposedManifest`. Used to poll for the async Tier-3 result and reflect the
   * accepted state. The AWSJSON `config` and `proposedManifest.manifest`/
   * `fieldConfidence` are JSON-parsed into objects. Returns null when not found.
   */
  async getImportRecord(agentId: string): Promise<AgentImportRecord | null> {
    try {
      const response = await serverService.query<{
        getAgentConfig: RawImportRecord | null;
      }>(getImportRecordQuery, { agentId });

      return normalizeImportRecord(response.getAgentConfig);
    } catch (error) {
      console.error('Error fetching agent import record:', error);
      throw error;
    }
  },
};
