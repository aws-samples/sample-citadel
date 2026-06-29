/**
 * Agent Import type definitions (US-IMP)
 *
 * TypeScript mirror of the agent-import GraphQL contract the backend exposes
 * (discoverAgents / describeAgentCandidate / importAgent / attestAgentImport).
 * Consumed by `agentImportService` and the forthcoming Import Wizard UI.
 *
 * Enum-like fields the GraphQL INPUTs declare as `String` (invocation
 * protocol / auth / mode on ImportAgentInput) are kept as `string` here to
 * match the wire contract exactly. The richer typed unions live on the
 * capability descriptor's `invocation` block, which mirrors the backend's
 * typed registry shape (`AgentInvocationBlock`).
 */

import type { AgentConfig } from '../services/agentConfigService';

/** Discovery strategy for enumerating importable agents. */
export type DiscoverySource = 'SCAN' | 'PASTE' | 'MANIFEST';

/**
 * Conflict-resolution strategy when an import collides with an existing record
 * (matched by sourceArn, then display name) in the caller's org.
 */
export type ImportConflictPolicy = 'LINK' | 'REPLACE' | 'COPY';

/** Protocol used to reach an agent's invocation target. */
export type AgentInvocationProtocol =
  | 'AGENTCORE_RUNTIME'
  | 'BEDROCK_AGENT'
  | 'LAMBDA_INVOKE'
  | 'HTTP_ENDPOINT'
  | 'MCP'
  | 'A2A'
  | 'STEP_FUNCTIONS'
  | 'SAGEMAKER_ENDPOINT'
  | 'SQS_ASYNC';

/** Authentication mode used when reaching an invocation target. */
export type AgentInvocationAuthMode =
  | 'SIGV4'
  | 'API_KEY'
  | 'BEARER'
  | 'OAUTH2'
  | 'COGNITO'
  | 'NONE';

/** Synchronous request/response vs. asynchronous callback delivery. */
export type AgentInvocationMode = 'sync' | 'async_callback';

/**
 * Per-field inference confidence on a capability descriptor. Self-described
 * fields are 'high'; probe-derived 'medium'; LLM-inferred 'low'.
 */
export type DescriptorFieldConfidence = 'high' | 'medium' | 'low';

/** An open JSON Schema document (input/output contracts). */
export type JsonSchema = Record<string, unknown>;

/**
 * Input for the `discoverAgents` query.
 * SCAN uses region/tagKey/tagValue; PASTE uses ref; MANIFEST uses manifest.
 * `manifest` is AWSJSON — a nested JSON object (the backend resolver accepts
 * it either as an object or as a JSON string).
 */
export interface DiscoverAgentsInput {
  source: DiscoverySource;
  region?: string;
  tagKey?: string;
  tagValue?: string;
  ref?: string;
  manifest?: Record<string, unknown>;
  /**
   * Optional read-only IAM role ARN in the *target* AWS account that Citadel
   * assumes (presenting `discoveryExternalId`) to SCAN/DESCRIBE a cross-account
   * target. Operator-supplied for cross-account discovery; omitted for
   * same-account scans. Distinct from the import-time `invocationRoleArn`
   * (cross-account invoke) and `invocationAnalysisRoleArn` (trust-path analysis).
   */
  discoveryRoleArn?: string;
  /**
   * Optional external ID Citadel presents when assuming `discoveryRoleArn`.
   * Only meaningful for cross-account discovery whose role trust policy requires it.
   */
  discoveryExternalId?: string;
}

/**
 * A discovered-but-not-yet-described agent candidate. Provenance is flattened
 * from the internal origin block; `ownership` is always 'external' — Citadel
 * never owns an imported agent's infrastructure.
 */
export interface AgentCandidate {
  displayName: string;
  reference: string;
  substrate: string;
  sourceArn?: string;
  region?: string;
  account?: string;
  ownership: string;
  discoveredAt: string;
}

/** Normalized invocation descriptor (mirrors the backend registry shape). */
export interface AgentInvocationBlock {
  protocol: AgentInvocationProtocol;
  target: string;
  auth: {
    mode: AgentInvocationAuthMode;
    secretRef?: string;
  };
  mode: AgentInvocationMode;
  region?: string;
  account?: string;
  roleArn?: string;
  externalId?: string;
}

/** Provenance of an imported agent. `ownership` is always 'external'. */
export interface AgentOrigin {
  sourceArn?: string;
  account?: string;
  region?: string;
  substrate: string;
  discoveredAt: string;
  ownership: 'external';
}

/**
 * Capability descriptor parsed from the AWSJSON string `describeAgentCandidate`
 * returns. Inferred fields may carry a per-field confidence in `fieldConfidence`
 * (keyed by descriptor field name, e.g. 'inputSchema').
 */
export interface AgentCapabilityDescriptor {
  name: string;
  description: string;
  version: string;
  skills: string[];
  categories: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  invocation: AgentInvocationBlock;
  origin: AgentOrigin;
  constraints?: {
    maxLatencyMs?: number;
    costHint?: string;
    dataSensitivity?: string;
    piiHandling?: string;
  };
  fieldConfidence?: Record<string, DescriptorFieldConfidence>;
}

/**
 * Flat, typed import descriptor for the `importAgent` mutation. The backend
 * nests these into its internal invocation/origin descriptor and forces
 * origin.ownership to 'external'. Invocation protocol/auth/mode are `string`
 * to match the GraphQL `String` input contract. `manifest` is AWSJSON.
 */
export interface ImportAgentInput {
  name: string;
  manifest?: Record<string, unknown>;
  invocationProtocol: string;
  invocationTarget: string;
  invocationAuthMode?: string;
  invocationSecretRef?: string;
  /**
   * Optional custom request-header name for the resolved API_KEY secret (e.g.
   * 'x-api-key'). Only meaningful for `invocationAuthMode: 'API_KEY'`; absent ⇒
   * the secret is applied as `Authorization: <value>` (back-compat default).
   */
  invocationAuthHeader?: string;
  /**
   * Raw secret value the caller may submit at import time. On a record-creating
   * import the backend persists it to Secrets Manager and stores only the
   * resulting reference — the raw value never lands on the record or its logs.
   * Takes precedence over `invocationSecretRef`.
   */
  invocationSecret?: string;
  invocationMode?: string;
  /**
   * Optional read-only IAM role ARN in the *target* AWS account that Citadel
   * assumes (with the external ID) to analyze a cross-account invoke role's
   * trust path during activation. Operator-supplied; only meaningful for
   * cross-account targets and omitted otherwise.
   */
  invocationAnalysisRoleArn?: string;
  /**
   * Optional IAM role ARN in the *target* AWS account that Citadel assumes
   * (presenting `invocationExternalId`) to INVOKE a cross-account agent. The
   * role must trust Citadel and require the external ID. Distinct from the
   * read-only `invocationAnalysisRoleArn` (activation trust-path analysis only).
   * Operator-supplied; omitted for same-account targets.
   */
  invocationRoleArn?: string;
  /**
   * Optional external ID Citadel presents when assuming `invocationRoleArn`.
   * Only meaningful for cross-account targets whose role trust policy requires it.
   */
  invocationExternalId?: string;
  region?: string;
  account?: string;
  sourceArn?: string;
  substrate: string;
  categories?: string[];
  onConflict?: ImportConflictPolicy;
}

/**
 * Result of the `importAgent` mutation.
 *  - success:              `{ agent, conflict: false }`
 *  - unresolved collision: `{ agent: null, conflict: true, existingId, reason, options }`
 */
export interface ImportAgentResult {
  agent: AgentConfig | null;
  conflict: boolean;
  existingId?: string | null;
  reason?: string | null;
  options?: string[] | null;
}

/**
 * Input for the pre-activation `testImportedAgent` mutation. Carries ONLY the
 * invocation-bearing fields needed to reach and call a candidate (no name /
 * manifest / origin — a test-invoke never creates a record). `invocationSecret`
 * is a RAW secret used for THIS test only: the backend resolves it transiently
 * in-memory and never persists it. Mirrors the GraphQL `TestImportedAgentInput`.
 */
export interface TestImportedAgentInput {
  invocationProtocol: string;
  invocationTarget: string;
  invocationAuthMode?: string;
  invocationAuthHeader?: string;
  invocationSecretRef?: string;
  invocationSecret?: string;
  invocationMode?: string;
  /**
   * Optional cross-account invoke role ARN (assumed while presenting
   * `invocationExternalId`) so a pre-activation test-invoke can reach a
   * cross-account target. Mirrors `ImportAgentInput.invocationRoleArn`.
   */
  invocationRoleArn?: string;
  /** Optional external ID presented when assuming `invocationRoleArn`. */
  invocationExternalId?: string;
  region?: string;
  account?: string;
  prompt?: string;
}

/**
 * Result of a pre-activation test-invoke. `ok: true` ⇒ the candidate was
 * reached and `output` carries the SANITIZED response; `ok: false` ⇒ `error`
 * explains the failure (a normal result, NOT a thrown GraphQL error).
 * `latencyMs` is the wall-clock duration of the attempt.
 */
export interface ImportTestResult {
  ok: boolean;
  output?: string | null;
  error?: string | null;
  latencyMs?: number | null;
}
