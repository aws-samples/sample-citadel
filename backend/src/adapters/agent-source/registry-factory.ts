/**
 * Default AgentSourceAdapter registry factory (invocation-dispatcher story).
 *
 * Registers the five currently-dispatchable per-protocol adapters. Protocols
 * without a registered adapter (A2A, STEP_FUNCTIONS, SAGEMAKER_ENDPOINT,
 * SQS_ASYNC) resolve to UnknownProtocolError by design.
 */
import { AgentSourceAdapterRegistry } from './base';
import { AgentCoreRuntimeAdapter } from './agentcore-runtime-adapter';
import { LambdaInvokeAdapter } from './lambda-invoke-adapter';
import { HttpEndpointAdapter } from './http-endpoint-adapter';
import { BedrockAgentAdapter } from './bedrock-agent-adapter';
import { McpAdapter } from './mcp-adapter';

export { NotImplementedError } from './not-implemented';

/** Optional dependencies threaded into the per-protocol adapters. */
export interface AgentSourceRegistryDeps {
  /**
   * Invoke-side secret resolver threaded into the HTTP + MCP adapters so they
   * can turn an invocation `auth.secretRef` into an Authorization header. When
   * omitted, those adapters invoke without an auth header (back-compat).
   */
  resolveSecret?: (secretRef: string) => Promise<string>;
}

export function buildDefaultAgentSourceRegistry(
  deps: AgentSourceRegistryDeps = {},
): AgentSourceAdapterRegistry {
  const registry = new AgentSourceAdapterRegistry();
  registry.register(new AgentCoreRuntimeAdapter());
  registry.register(new LambdaInvokeAdapter());
  registry.register(new HttpEndpointAdapter({ resolveSecret: deps.resolveSecret }));
  registry.register(new BedrockAgentAdapter());
  registry.register(new McpAdapter({ resolveSecret: deps.resolveSecret }));
  return registry;
}
