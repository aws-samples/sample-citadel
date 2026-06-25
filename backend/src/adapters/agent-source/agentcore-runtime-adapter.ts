/**
 * AGENTCORE_RUNTIME adapter.
 *
 * Invokes a Bedrock AgentCore runtime via InvokeAgentRuntimeCommand against
 * `descriptor.invocation.target` — the same client pattern the legacy
 * agent-message-handler uses. Only invoke() is implemented for now.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
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
import type { CommandSender } from './invoke-support';
import { NO_RESPONSE_TEXT, extractTextOutput, isAsyncIterable } from './invoke-support';

const DEFAULT_REGION = process.env.AWS_REGION || 'ap-southeast-2';

export class AgentCoreRuntimeAdapter implements AgentSourceAdapter {
  public readonly protocol: AgentInvocationProtocol = 'AGENTCORE_RUNTIME';

  /** Optional injected sender for tests; production lazily builds a client. */
  constructor(private readonly sender?: CommandSender) {}

  async invoke(
    req: InvokeRequest,
    descriptor: AgentCapabilityDescriptor,
  ): Promise<InvokeResponse> {
    const { target, region } = descriptor.invocation;

    const payload = JSON.stringify({
      prompt: req.prompt,
      session_id: req.sessionId,
      ...(req.attributes && Object.keys(req.attributes).length > 0
        ? { sessionAttributes: req.attributes }
        : {}),
    });

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: target,
      runtimeSessionId: req.sessionId,
      payload,
      qualifier: 'DEFAULT',
    });

    const response = this.sender
      ? await this.sender.send(command)
      : await new BedrockAgentCoreClient({ region: region || DEFAULT_REGION }).send(command);

    return { output: await parseRuntimeResponse(response), raw: response };
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

/** Parse a streaming or buffered AgentCore runtime response into text. */
async function parseRuntimeResponse(response: unknown): Promise<string> {
  if (!response || typeof response !== 'object') return NO_RESPONSE_TEXT;
  const r = response as { contentType?: string; response?: unknown };
  if (r.response == null) return NO_RESPONSE_TEXT;

  const contentType = r.contentType ?? '';
  if (contentType.includes('text/event-stream') && isAsyncIterable(r.response)) {
    const chunks: string[] = [];
    for await (const chunk of r.response) {
      if (chunk != null) chunks.push(Buffer.from(chunk as Uint8Array).toString('utf-8'));
    }
    return parseEventStream(chunks.join('')) || NO_RESPONSE_TEXT;
  }

  const body = r.response as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return extractTextOutput(Buffer.from(bytes).toString('utf-8')) || NO_RESPONSE_TEXT;
  }

  return NO_RESPONSE_TEXT;
}

/** Collapse an SSE ("data: ...") event stream body into a single string. */
function parseEventStream(full: string): string {
  const out: string[] = [];
  for (const line of full.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.substring(6);
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === 'string') {
        out.push(parsed);
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>).text === 'string'
      ) {
        out.push((parsed as Record<string, string>).text);
      } else {
        out.push(JSON.stringify(parsed));
      }
    } catch {
      out.push(data);
    }
  }
  return out.join('');
}
