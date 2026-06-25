/**
 * MCP adapter.
 *
 * Issues a JSON-RPC `tools/call` POST to `descriptor.invocation.target` and
 * extracts the text content from the MCP result. Only invoke() is implemented
 * for now.
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
import { NO_RESPONSE_TEXT } from './invoke-support';

export interface McpAdapterDeps {
  fetchFn?: typeof fetch;
}

export class McpAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'MCP';
  private readonly fetchFn: typeof fetch;

  constructor(deps: McpAdapterDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  }

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target } = descriptor.invocation;
    const rpc = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: descriptor.name,
        arguments: {
          prompt: req.prompt,
          sessionId: req.sessionId,
          ...(req.attributes ?? {}),
        },
      },
    };

    const response = await this.fetchFn(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc),
    });
    const text = await response.text();
    return { output: parseJsonRpcResult(text), raw: text };
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

/** Extract the text content of an MCP JSON-RPC `tools/call` result. */
function parseJsonRpcResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed as { result?: unknown; error?: unknown };
      if (envelope.result && typeof envelope.result === 'object') {
        const result = envelope.result as { content?: unknown };
        if (Array.isArray(result.content)) {
          const texts = result.content
            .filter(
              (c): c is { text: string } =>
                !!c &&
                typeof c === 'object' &&
                typeof (c as Record<string, unknown>).text === 'string',
            )
            .map((c) => c.text);
          if (texts.length > 0) return texts.join('');
        }
        return JSON.stringify(envelope.result);
      }
      if (envelope.error) return `MCP error: ${JSON.stringify(envelope.error)}`;
    }
    return text || NO_RESPONSE_TEXT;
  } catch {
    return text || NO_RESPONSE_TEXT;
  }
}
