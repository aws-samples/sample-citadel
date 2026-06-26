/**
 * Discovery / describe / healthCheck tests for the MCP adapter (US-IMP-011).
 * Discovery is by PASTED ENDPOINT; describe drives JSON-RPC initialize +
 * tools/list. Global fetch is injected as a fake — no live network.
 */
import { McpAdapter } from '../mcp-adapter';
import { NotImplementedError } from '../not-implemented';

const URL_ = 'https://mcp.example.com/rpc';

interface FetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}
const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;
const methodOf = (init: unknown): string =>
  JSON.parse(String((init as FetchInit).body)).method as string;

describe('McpAdapter.discover (US-IMP-011)', () => {
  it('returns a single candidate for a pasted endpoint (substrate mcp, no sourceArn)', async () => {
    const adapter = new McpAdapter({ fetchFn: asFetch(jest.fn()) });
    const candidates = await adapter.discover({ endpoint: URL_, name: 'FileTools' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      reference: URL_,
      displayName: 'FileTools',
      origin: { substrate: 'mcp', ownership: 'external' },
    });
    expect(candidates[0].origin.sourceArn).toBeUndefined();
  });

  it('returns [] when no endpoint is present in scope', async () => {
    const adapter = new McpAdapter({ fetchFn: asFetch(jest.fn()) });
    await expect(adapter.discover({})).resolves.toEqual([]);
    await expect(adapter.discover(undefined)).resolves.toEqual([]);
  });
});

describe('McpAdapter.describe (US-IMP-011)', () => {
  const readSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const writeSchema = {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
  };

  function rpcFetch(): jest.Mock {
    return jest.fn(async (_url: unknown, init?: unknown) => {
      const method = methodOf(init);
      if (method === 'initialize') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'FileTools', version: '1.2.0' },
                instructions: 'File ops server',
              },
            }),
        };
      }
      if (method === 'tools/list') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: {
                tools: [
                  { name: 'read_file', description: 'Reads a file', inputSchema: readSchema },
                  { name: 'write_file', description: 'Writes a file', inputSchema: writeSchema },
                ],
              },
            }),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    });
  }

  it('maps tools/list into skills + schemas at high confidence', async () => {
    const fetchFn = rpcFetch();
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn) });

    const d = await adapter.describe(URL_);

    // initialize then tools/list, both POSTed to the endpoint URL.
    expect(fetchFn.mock.calls.map((c) => methodOf(c[1]))).toEqual(['initialize', 'tools/list']);
    expect(String(fetchFn.mock.calls[0][0])).toBe(URL_);

    expect(d.name).toBe('FileTools');
    expect(d.version).toBe('1.2.0');
    expect(d.description).toBe('File ops server');
    expect(d.skills).toEqual(['read_file', 'write_file']);
    expect(d.inputSchema).toEqual({
      type: 'object',
      properties: { read_file: readSchema, write_file: writeSchema },
    });
    expect(d.fieldConfidence?.inputSchema).toBe('high');
    expect(d.fieldConfidence?.skills).toBe('high');
    expect(d.invocation).toMatchObject({
      protocol: 'MCP',
      target: URL_,
      auth: { mode: 'NONE' },
      mode: 'sync',
    });
    expect(d.origin.substrate).toBe('mcp');
  });

  it('reflects scope auth (secretRef -> OAUTH2) in the invocation block', async () => {
    const adapter = new McpAdapter({
      fetchFn: asFetch(rpcFetch()),
      auth: { secretRef: 'secret/mcp-oauth' },
    });

    const d = await adapter.describe(URL_);

    expect(d.invocation.auth).toEqual({ mode: 'OAUTH2', secretRef: 'secret/mcp-oauth' });
  });
});

describe('McpAdapter.healthCheck (US-IMP-011)', () => {
  it('returns reachable:true on a 2xx (lightweight ping)', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    }));
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn) });

    await expect(adapter.healthCheck(URL_)).resolves.toEqual({ reachable: true });
    expect(methodOf(fetchFn.mock.calls[0][1])).toBe('ping');
  });

  it('returns reachable:false on a non-2xx WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 500, text: async () => '' }));
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn) });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('500');
  });

  it('returns reachable:false on a network error WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const adapter = new McpAdapter({ fetchFn: asFetch(fetchFn) });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('ETIMEDOUT');
  });
});

describe('McpAdapter.vendCredentials (still a stub)', () => {
  it('throws NotImplementedError', async () => {
    const adapter = new McpAdapter();
    await expect(adapter.vendCredentials(URL_)).rejects.toBeInstanceOf(NotImplementedError);
  });
});
