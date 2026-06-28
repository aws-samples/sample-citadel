/**
 * Invoke-side auth-secret resolution tests for the MCP adapter (completes the
 * US-IMP 003 auth TODO). The bearer-token modes apply `Authorization: Bearer
 * <value>` on the JSON-RPC POST; API_KEY sends the raw value; NONE / no
 * secretRef / no resolver send no auth header. The resolved value is never
 * logged. global fetch is injected as a fake.
 */
import { McpAdapter } from '../mcp-adapter';
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from '../base';

const TARGET = 'https://mcp.example.com/rpc';
const SECRET_VALUE = 'mcp-bearer-secret-DO-NOT-LOG';

interface FetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}
const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;

function descriptorFor(invocation: AgentInvocationBlock): AgentCapabilityDescriptor {
  return {
    name: 'mcp-agent',
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

function makeFetch(): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'mcp-out' }] },
      }),
  }));
}

function initOf(fetchFn: jest.Mock): FetchInit {
  return fetchFn.mock.calls[0][1] as FetchInit;
}

describe('McpAdapter.invoke — secret-backed auth headers', () => {
  it('OAUTH2 + secretRef: applies Authorization: Bearer <value> on the JSON-RPC POST', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    const res = await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/mcp' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/mcp');
    const init = initOf(fetchFn);
    expect(init.headers?.authorization).toBe(`Bearer ${SECRET_VALUE}`);
    // Still a JSON-RPC tools/call to the target.
    expect(fetchFn.mock.calls[0][0]).toBe(TARGET);
    expect(JSON.parse(init.body as string).method).toBe('tools/call');
    expect(res.output).toBe('mcp-out');
  });

  it('API_KEY + secretRef: sends the raw value as the Authorization header', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/key' },
        mode: 'sync',
      }),
    );

    expect(initOf(fetchFn).headers?.authorization).toBe(SECRET_VALUE);
  });

  it('BEARER + secretRef: applies Authorization: Bearer <value> on the JSON-RPC POST', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'BEARER', secretRef: 'secret/bearer' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/bearer');
    expect(initOf(fetchFn).headers?.authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('API_KEY + custom header: applies the custom header name carrying the raw value', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/key', header: 'x-api-key' },
        mode: 'sync',
      }),
    );

    const headers = initOf(fetchFn).headers ?? {};
    expect(headers['x-api-key']).toBe(SECRET_VALUE);
    expect(headers.authorization).toBeUndefined();
  });

  it('NONE: does not resolve a secret and sends no Authorization header', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'NONE' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).not.toHaveBeenCalled();
    expect(initOf(fetchFn).headers?.authorization).toBeUndefined();
  });

  it('secretRef present but no resolver wired: behaves as before (no auth header)', async () => {
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn) }); // no resolveSecret

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/mcp' },
        mode: 'sync',
      }),
    );

    expect(initOf(fetchFn).headers?.authorization).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('NEVER logs the resolved secret value', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'MCP',
        target: TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/mcp' },
        mode: 'sync',
      }),
    );

    const allLogs = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .map((c) => JSON.stringify(c))
      .join('\n');
    expect(allLogs).not.toContain(SECRET_VALUE);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
