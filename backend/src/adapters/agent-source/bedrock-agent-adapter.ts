/**
 * BEDROCK_AGENT adapter.
 *
 * Invokes an Agents-for-Bedrock agent via InvokeAgentCommand
 * (@aws-sdk/client-bedrock-agent-runtime). `descriptor.invocation.target` is
 * "<agentId>/<agentAliasId>". Only invoke() is implemented for now.
 *
 * NOTE: @aws-sdk/client-bedrock-agent-runtime is NOT currently a backend
 * dependency. To avoid breaking `tsc`/bundling for every other path, the SDK
 * is loaded through an indirected require that is only reached when a
 * BEDROCK_AGENT agent is actually invoked. Add the package to backend
 * dependencies before enabling BEDROCK_AGENT imports in production (tracked as
 * a follow-up; out of scope for this story, which must not touch package.json).
 */
import type { AgentSourceAdapter } from './base';
import type {
  AgentCandidate,
  AgentCapabilityDescriptor,
  AgentInvocationProtocol,
  HealthCheckResult,
  InvokeRequest,
  InvokeResponse,
  VendedCredentials,
} from './base';
import { NotImplementedError } from './not-implemented';
import { NO_RESPONSE_TEXT, bytesToString, isAsyncIterable } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const MODULE_NAME = '@aws-sdk/client-bedrock-agent-runtime';

/** Structural sender for the lazily-loaded bedrock-agent-runtime client. */
interface AgentRuntimeSender {
  send(command: unknown): Promise<unknown>;
}

/** Minimal shape of the parts of the SDK module this adapter needs. */
interface BedrockAgentRuntimeModule {
  BedrockAgentRuntimeClient: new (config: { region?: string }) => AgentRuntimeSender;
  InvokeAgentCommand: new (input: Record<string, unknown>) => unknown;
}

export interface BedrockAgentAdapterDeps {
  client?: AgentRuntimeSender;
  createCommand?: (input: Record<string, unknown>) => unknown;
  loadModule?: () => BedrockAgentRuntimeModule;
}

export class BedrockAgentAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'BEDROCK_AGENT';

  constructor(private readonly deps: BedrockAgentAdapterDeps = {}) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region } = descriptor.invocation;
    const slash = target.indexOf('/');
    const agentId = slash >= 0 ? target.slice(0, slash) : target;
    const agentAliasId = slash >= 0 ? target.slice(slash + 1) : 'TSTALIASID';

    const input: Record<string, unknown> = {
      agentId,
      agentAliasId,
      sessionId: req.sessionId,
      inputText: req.prompt,
    };

    let client = this.deps.client;
    let createCommand = this.deps.createCommand;
    if (!client || !createCommand) {
      const mod = (this.deps.loadModule ?? loadBedrockAgentRuntime)();
      client = client ?? new mod.BedrockAgentRuntimeClient({ region: region || DEFAULT_REGION });
      createCommand = createCommand ?? ((i) => new mod.InvokeAgentCommand(i));
    }

    const response = await client.send(createCommand(input));
    return { output: await parseAgentResponse(response), raw: response };
  }

  async discover(_scope: unknown): Promise<AgentCandidate[]> {
    throw new NotImplementedError();
  }
  async describe(_ref: AgentCandidate | string): Promise<AgentCapabilityDescriptor> {
    throw new NotImplementedError();
  }
  async healthCheck(_ref: AgentCandidate | string): Promise<HealthCheckResult> {
    throw new NotImplementedError();
  }
  async vendCredentials(_ref: AgentCandidate | string): Promise<VendedCredentials> {
    throw new NotImplementedError();
  }
}

/**
 * Load @aws-sdk/client-bedrock-agent-runtime through an indirected require so
 * a static import does not fail `tsc`/bundling when the package is absent.
 * Throws a clear error at invoke time if the dependency is missing.
 */
function loadBedrockAgentRuntime(): BedrockAgentRuntimeModule {
  const nodeRequire: (id: string) => unknown = require;
  return nodeRequire(MODULE_NAME) as BedrockAgentRuntimeModule;
}

/** Concatenate the InvokeAgent completion event-stream into a single string. */
async function parseAgentResponse(response: unknown): Promise<string> {
  if (!response || typeof response !== 'object') return NO_RESPONSE_TEXT;
  const r = response as { completion?: unknown; output?: unknown };

  if (isAsyncIterable(r.completion)) {
    const chunks: string[] = [];
    for await (const event of r.completion) {
      const e = event as { chunk?: { bytes?: unknown } };
      if (e.chunk?.bytes != null) chunks.push(bytesToString(e.chunk.bytes));
    }
    if (chunks.length > 0) return chunks.join('');
  }
  if (typeof r.output === 'string') return r.output;
  return NO_RESPONSE_TEXT;
}
