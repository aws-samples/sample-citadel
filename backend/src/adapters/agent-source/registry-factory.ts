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

export function buildDefaultAgentSourceRegistry(): AgentSourceAdapterRegistry {
  const registry = new AgentSourceAdapterRegistry();
  registry.register(new AgentCoreRuntimeAdapter());
  registry.register(new LambdaInvokeAdapter());
  registry.register(new HttpEndpointAdapter());
  registry.register(new BedrockAgentAdapter());
  registry.register(new McpAdapter());
  return registry;
}
