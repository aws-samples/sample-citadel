/**
 * buildDefaultAgentSourceRegistry must thread an optional `resolveSecret` dep
 * into the HTTP + MCP adapters so the invoke path can apply auth headers. When
 * omitted, those adapters invoke without an auth header (back-compat). The
 * factory builds adapters with the DEFAULT fetch, so these tests stub the
 * global fetch the late-binding adapters pick up.
 */
import { buildDefaultAgentSourceRegistry } from '../registry-factory';
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from '../base';

const HTTP_TARGET = 'https://api.example.com/agent';
const MCP_TARGET = 'https://mcp.example.com/rpc';
const SECRET_VALUE = 'factory-threaded-secret-DO-NOT-LOG';

function descriptorFor(invocation: AgentInvocationBlock): AgentCapabilityDescriptor {
  return {
    name: 'agent-under-test',
    description: '',
    version: '1.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin: {
      substrate: invocation.protocol,
      discoveredAt: '2026-06-28T00:00:00.000Z',
      ownership: 'external',
    },
  };
}

const baseReq: InvokeRequest = { prompt: 'hello', sessionId: 's1', attributes: {} };

const realFetch = global.fetch;

function stubGlobalFetch(body: string): jest.Mock {
  const fn = jest.fn(async () => ({ ok: true, status: 200, text: async () => body }));
  (global as unknown as { fetch: jest.Mock }).fetch = fn;
  return fn;
}

function headersOf(fetchFn: jest.Mock): Record<string, string> {
  return (fetchFn.mock.calls[0][1] as { headers?: Record<string, string> }).headers ?? {};
}

afterEach(() => {
  (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
});

describe('buildDefaultAgentSourceRegistry — resolveSecret threading', () => {
  it('threads resolveSecret into the HTTP adapter (Bearer applied via the factory)', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = stubGlobalFetch(JSON.stringify({ output: 'ok' }));
    const registry = buildDefaultAgentSourceRegistry({ resolveSecret });

    await registry.resolve('HTTP_ENDPOINT').invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: HTTP_TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/http' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/http');
    expect(headersOf(fetchFn).authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('threads resolveSecret into the MCP adapter', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = stubGlobalFetch(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'mcp-out' }] } }),
    );
    const registry = buildDefaultAgentSourceRegistry({ resolveSecret });

    await registry.resolve('MCP').invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: MCP_TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/mcp' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/mcp');
    expect(headersOf(fetchFn).authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('builds without resolveSecret (back-compat): no auth header, still invokes + registers 5 protocols', async () => {
    const fetchFn = stubGlobalFetch(JSON.stringify({ output: 'ok' }));
    const registry = buildDefaultAgentSourceRegistry();

    for (const protocol of ['AGENTCORE_RUNTIME', 'LAMBDA_INVOKE', 'HTTP_ENDPOINT', 'BEDROCK_AGENT', 'MCP'] as const) {
      expect(registry.has(protocol)).toBe(true);
    }

    await registry.resolve('HTTP_ENDPOINT').invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: HTTP_TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/http' },
        mode: 'sync',
      }),
    );

    expect(headersOf(fetchFn).authorization).toBeUndefined();
  });
});
