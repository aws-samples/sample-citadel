/**
 * Unit tests for the minimal per-protocol AgentSourceAdapters and the default
 * registry factory (invocation-dispatcher story).
 *
 * Each adapter implements ONLY invoke() for now; discover/describe/healthCheck/
 * vendCredentials throw the shared NotImplementedError. SDK clients are
 * injected as fakes so these tests never reach AWS and do not depend on the
 * bedrock-agent-runtime package (which is not installed).
 */
import { NotImplementedError } from '../not-implemented';
import { AgentCoreRuntimeAdapter } from '../agentcore-runtime-adapter';
import { LambdaInvokeAdapter } from '../lambda-invoke-adapter';
import { HttpEndpointAdapter } from '../http-endpoint-adapter';
import { BedrockAgentAdapter } from '../bedrock-agent-adapter';
import { McpAdapter } from '../mcp-adapter';
import { buildDefaultAgentSourceRegistry } from '../registry-factory';
import { UnknownProtocolError, type AgentSourceAdapter } from '../base';
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from '../base';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function descriptorFor(
  invocation: AgentInvocationBlock,
  name = 'agent-under-test',
): AgentCapabilityDescriptor {
  return {
    name,
    description: '',
    version: '1.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin: {
      substrate: invocation.protocol,
      discoveredAt: '2026-06-26T00:00:00.000Z',
      ownership: 'external',
    },
  };
}

const baseReq: InvokeRequest = {
  prompt: 'hello world',
  sessionId: 'sess-1',
  attributes: { projectId: 'p1' },
};

describe('NotImplementedError', () => {
  it('carries the documented message and is an Error', () => {
    const err = new NotImplementedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NotImplementedError);
    expect(err.name).toBe('NotImplementedError');
    expect(err.message).toBe('implemented in a later story');
  });
});

describe('adapter unimplemented capabilities reject with NotImplementedError', () => {
  const adapters: AgentSourceAdapter[] = [
    new AgentCoreRuntimeAdapter({ send: jest.fn() }),
    new LambdaInvokeAdapter({ send: jest.fn() }),
    new HttpEndpointAdapter(),
    new BedrockAgentAdapter(),
    new McpAdapter(),
  ];

  for (const adapter of adapters) {
    it(`${adapter.protocol}: discover/describe/healthCheck/vendCredentials are not implemented`, async () => {
      await expect(adapter.discover(undefined)).rejects.toBeInstanceOf(NotImplementedError);
      await expect(adapter.describe('ref')).rejects.toBeInstanceOf(NotImplementedError);
      await expect(adapter.healthCheck('ref')).rejects.toBeInstanceOf(NotImplementedError);
      await expect(adapter.vendCredentials('ref')).rejects.toBeInstanceOf(NotImplementedError);
    });
  }
});

describe('AgentCoreRuntimeAdapter.invoke', () => {
  it('invokes the runtime ARN target and extracts the response text', async () => {
    const send = jest.fn().mockResolvedValue({
      contentType: 'application/json',
      response: {
        transformToByteArray: async () => enc(JSON.stringify({ output: 'core-out' })),
      },
    });
    const adapter = new AgentCoreRuntimeAdapter({ send });
    const target = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agent';

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'AGENTCORE_RUNTIME', target, auth: { mode: 'SIGV4' }, mode: 'sync' }),
    );

    expect(res.output).toBe('core-out');
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.agentRuntimeArn).toBe(target);
    expect(command.input.runtimeSessionId).toBe('sess-1');
    expect(JSON.parse(command.input.payload as string).prompt).toBe('hello world');
  });
});

describe('LambdaInvokeAdapter.invoke', () => {
  const target = 'arn:aws:lambda:us-east-1:123456789012:function:my-agent';

  it('uses InvocationType RequestResponse for sync mode and parses the payload', async () => {
    const send = jest.fn().mockResolvedValue({
      StatusCode: 200,
      Payload: enc(JSON.stringify({ output: 'lambda-out' })),
    });
    const adapter = new LambdaInvokeAdapter({ send });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'LAMBDA_INVOKE', target, auth: { mode: 'NONE' }, mode: 'sync' }),
    );

    expect(res.output).toBe('lambda-out');
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.FunctionName).toBe(target);
    expect(command.input.InvocationType).toBe('RequestResponse');
  });

  it('uses InvocationType Event for async_callback mode', async () => {
    const send = jest.fn().mockResolvedValue({ StatusCode: 202 });
    const adapter = new LambdaInvokeAdapter({ send });

    await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'LAMBDA_INVOKE', target, auth: { mode: 'NONE' }, mode: 'async_callback' }),
    );

    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.InvocationType).toBe('Event');
  });
});

describe('HttpEndpointAdapter.invoke', () => {
  const target = 'https://api.example.com/agent';

  it('SigV4-signs the request before sending when auth.mode is SIGV4', async () => {
    const sign = jest.fn(async (_req: unknown) => ({ headers: {} as Record<string, string> }));
    const signerFactory = jest.fn(() => ({ sign }));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: 'http-out' }),
    }));
    const adapter = new HttpEndpointAdapter({
      signerFactory,
      fetchFn: fetchFn as unknown as typeof fetch,
      credentialsProvider: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
    });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'HTTP_ENDPOINT', target, auth: { mode: 'SIGV4' }, mode: 'sync', region: 'us-east-1' }),
    );

    expect(signerFactory).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(target);
    expect(res.output).toBe('http-out');
  });

  it('does NOT sign when auth.mode is not SIGV4', async () => {
    const sign = jest.fn(async (_req: unknown) => ({ headers: {} as Record<string, string> }));
    const signerFactory = jest.fn(() => ({ sign }));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: 'plain-out' }),
    }));
    const adapter = new HttpEndpointAdapter({
      signerFactory,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'HTTP_ENDPOINT', target, auth: { mode: 'API_KEY', secretRef: 'secret/x' }, mode: 'sync' }),
    );

    expect(signerFactory).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(res.output).toBe('plain-out');
  });
});

describe('McpAdapter.invoke', () => {
  const target = 'https://mcp.example.com/rpc';

  it('POSTs a JSON-RPC tools/call and extracts the text content', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'mcp-out' }] },
        }),
    }));
    const adapter = new McpAdapter({ fetchFn: fetchFn as unknown as typeof fetch });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'MCP', target, auth: { mode: 'NONE' }, mode: 'sync' }),
    );

    expect(fetchFn.mock.calls[0][0]).toBe(target);
    const body = JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body);
    expect(body.method).toBe('tools/call');
    expect(res.output).toBe('mcp-out');
  });
});

describe('BedrockAgentAdapter.invoke', () => {
  it('parses agentId/aliasId from the target and streams the completion', async () => {
    const createCommand = jest.fn((input: Record<string, unknown>) => ({ input }));
    async function* completion() {
      yield { chunk: { bytes: enc('bedrock-out') } };
    }
    const send = jest.fn().mockResolvedValue({ completion: completion() });
    const adapter = new BedrockAgentAdapter({ client: { send }, createCommand });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({ protocol: 'BEDROCK_AGENT', target: 'AGENT123/ALIAS1', auth: { mode: 'SIGV4' }, mode: 'sync' }),
    );

    expect(createCommand).toHaveBeenCalledTimes(1);
    expect(createCommand.mock.calls[0][0]).toEqual({
      agentId: 'AGENT123',
      agentAliasId: 'ALIAS1',
      sessionId: 'sess-1',
      inputText: 'hello world',
    });
    expect(res.output).toBe('bedrock-out');
  });
});

describe('buildDefaultAgentSourceRegistry', () => {
  it('registers exactly the five dispatchable protocols', () => {
    const registry = buildDefaultAgentSourceRegistry();
    for (const protocol of ['AGENTCORE_RUNTIME', 'LAMBDA_INVOKE', 'HTTP_ENDPOINT', 'BEDROCK_AGENT', 'MCP'] as const) {
      expect(registry.has(protocol)).toBe(true);
      expect(registry.resolve(protocol).protocol).toBe(protocol);
    }
  });

  it('throws UnknownProtocolError for protocols with no registered adapter', () => {
    const registry = buildDefaultAgentSourceRegistry();
    expect(() => registry.resolve('A2A')).toThrow(UnknownProtocolError);
    expect(() => registry.resolve('STEP_FUNCTIONS')).toThrow(UnknownProtocolError);
  });
});
