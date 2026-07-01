/**
 * Agent Source Adapter interface + protocol registry (US-IMP-002).
 *
 * Mirrors the ConnectorAdapter pattern in ../base.ts: a small, fully-typed
 * interface plus a single registry that is the ONLY lookup point for
 * protocol → adapter dispatch (no dispatch path constructs adapters directly).
 * Concrete adapters (AgentCore, Bedrock Agent, Lambda, HTTP/MCP, ...) implement
 * this interface in later stories.
 *
 * The invocation/origin descriptor types are imported from registry-service.ts
 * (the single source of truth) and re-exported for convenience — they are not
 * redefined here.
 */
import type {
  AgentInvocationProtocol,
  AgentInvocationBlock,
} from '../../services/registry-service';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  HealthCheckResult,
  InvokeRequest,
  InvokeResponse,
  VendedCredentials,
} from './types';

// Single import surface: re-export the normalized types and the descriptor
// blocks so callers can `import { ... } from '.../agent-source/base'`.
export type {
  JsonSchema,
  Confidence,
  AgentCandidate,
  AgentCapabilityDescriptor,
  HealthCheckResult,
  VendedCredentials,
  InvokeRequest,
  InvokeResponse,
} from './types';
export type {
  AgentInvocationProtocol,
  AgentInvocationBlock,
  AgentOrigin,
} from '../../services/registry-service';

/**
 * A reference to an agent for describe/healthCheck/vendCredentials/invoke:
 * either a discovered candidate or a bare adapter-specific string handle.
 */
export type AgentRef = AgentCandidate | string;

/**
 * Substrate-agnostic adapter contract. One concrete implementation per
 * protocol; every dispatch flows through {@link AgentSourceAdapterRegistry}.
 */
export interface AgentSourceAdapter {
  /** The protocol this adapter handles; its key in the registry. */
  readonly protocol: AgentInvocationProtocol;

  /** Enumerate importable candidates within the adapter-defined scope. */
  discover(scope: unknown): Promise<AgentCandidate[]>;

  /** Resolve a candidate/handle to a normalized capability descriptor. */
  describe(ref: AgentRef): Promise<AgentCapabilityDescriptor>;

  /** Confirm the target is reachable without invoking it. */
  healthCheck(ref: AgentRef): Promise<HealthCheckResult>;

  /**
   * Vend short-lived, least-privilege credentials for invoking the target,
   * derived from its invocation block (cross-account role + optional
   * ExternalId). Unused by the dispatch paths today — wired in a later
   * increment.
   */
  vendCredentials(invocation: AgentInvocationBlock): Promise<VendedCredentials>;

  /** Invoke the agent with a normalized request and return a normalized response. */
  invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse>;
}

/**
 * Thrown by {@link AgentSourceAdapterRegistry.resolve} when no adapter is
 * registered for a protocol. A typed error (not a generic Error) so callers
 * can branch on it explicitly via `instanceof`.
 */
export class UnknownProtocolError extends Error {
  public readonly protocol: string;

  constructor(protocol: string) {
    super(`No agent source adapter registered for protocol: ${protocol}`);
    this.name = 'UnknownProtocolError';
    this.protocol = protocol;
    // Preserve the prototype chain so `instanceof UnknownProtocolError` holds
    // even when this class is transpiled to a lower target.
    Object.setPrototypeOf(this, UnknownProtocolError.prototype);
  }
}

/**
 * The single lookup point for protocol → adapter dispatch. Concrete adapters
 * register themselves under their declared protocol; callers resolve through
 * this registry rather than constructing adapters directly.
 */
export class AgentSourceAdapterRegistry {
  private readonly adapters = new Map<
    AgentInvocationProtocol,
    AgentSourceAdapter
  >();

  /** Register (or replace) the adapter for its declared protocol. */
  register(adapter: AgentSourceAdapter): void {
    this.adapters.set(adapter.protocol, adapter);
  }

  /**
   * Resolve the adapter for a protocol.
   * @throws {UnknownProtocolError} when no adapter is registered.
   */
  resolve(protocol: AgentInvocationProtocol): AgentSourceAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new UnknownProtocolError(protocol);
    }
    return adapter;
  }

  /** True when an adapter is registered for the protocol. */
  has(protocol: AgentInvocationProtocol): boolean {
    return this.adapters.has(protocol);
  }
}
