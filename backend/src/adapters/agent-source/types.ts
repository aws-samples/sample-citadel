/**
 * Normalized agent-source types (US-IMP-002).
 *
 * These are the substrate-agnostic shapes every AgentSourceAdapter produces or
 * consumes, so the import pipeline can treat AgentCore runtimes, Bedrock
 * agents, Lambdas, HTTP/MCP endpoints, etc. uniformly. The invocation/origin
 * blocks are imported from registry-service.ts (the single source of truth) —
 * they are not redefined here.
 */
import type {
  AgentInvocationBlock,
  AgentOrigin,
} from '../../services/registry-service';

/** An open JSON Schema document (input/output contracts). */
export type JsonSchema = Record<string, unknown>;

/**
 * Confidence attached to an inferred descriptor field. Self-described fields
 * are 'high'; probe-derived 'medium'; LLM-inferred 'low' (invariant 3).
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * A discovered-but-not-yet-described agent. `reference` is the adapter's
 * opaque handle (ARN / endpoint / id) that describe()/invoke() can resolve.
 */
export interface AgentCandidate {
  origin: AgentOrigin;
  displayName: string;
  reference: string;
}

/**
 * The normalized capability descriptor produced by describe(). Inferred
 * fields may carry a per-field confidence in `fieldConfidence`.
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
  /** Per-field confidence keyed by descriptor field name (e.g. 'inputSchema'). */
  fieldConfidence?: Record<string, Confidence>;
}

/** Result of an adapter reachability probe (never throws for "unreachable"). */
export interface HealthCheckResult {
  reachable: boolean;
  detail?: string;
}

/**
 * Short-lived credentials vended for exactly one invoke target (invariant 2).
 * Adapter-specific extra fields are permitted via the index signature.
 */
export interface VendedCredentials {
  roleArn?: string;
  expiresAt?: string;
  [k: string]: unknown;
}

/** Normalized invoke request handed to an adapter. */
export interface InvokeRequest {
  prompt: string;
  sessionId?: string;
  attributes?: Record<string, unknown>;
}

/** Normalized invoke response. `raw` carries the substrate-native payload. */
export interface InvokeResponse {
  output: string;
  raw?: unknown;
}
