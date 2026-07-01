/**
 * Discovery / describe / healthCheck tests for the HTTP endpoint adapter
 * (US-IMP-011). Discovery is by PASTED ENDPOINT; global fetch is injected as a
 * fake — no live network.
 */
import { HttpEndpointAdapter } from '../http-endpoint-adapter';
import type { AgentInvocationBlock } from '../base';

const URL_ = 'https://api.example.com/agent';

const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;

describe('HttpEndpointAdapter.discover (US-IMP-011)', () => {
  it('returns a single candidate for a pasted endpoint (substrate http, no sourceArn)', async () => {
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(jest.fn()) });
    const candidates = await adapter.discover({ endpoint: URL_, name: 'Orders' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      reference: URL_,
      displayName: 'Orders',
      origin: { substrate: 'http', ownership: 'external' },
    });
    expect(candidates[0].origin.sourceArn).toBeUndefined();
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');
  });

  it('returns [] when no endpoint is present in scope', async () => {
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(jest.fn()) });
    await expect(adapter.discover({})).resolves.toEqual([]);
    await expect(adapter.discover(undefined)).resolves.toEqual([]);
  });
});

describe('HttpEndpointAdapter.describe (US-IMP-011)', () => {
  const reqSchema = { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] };
  const resSchema = { type: 'object', properties: { orderId: { type: 'string' } } };
  const openApiDoc = {
    openapi: '3.0.0',
    info: { title: 'Orders API', description: 'Order operations', version: '2.1.0' },
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          requestBody: { content: { 'application/json': { schema: reqSchema } } },
          responses: { '200': { content: { 'application/json': { schema: resSchema } } } },
        },
      },
    },
  };

  it('maps an available OpenAPI document into schemas at high confidence', async () => {
    const fetchFn = jest.fn(async (url: unknown) => {
      if (String(url).endsWith('/openapi.json')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(openApiDoc) };
      }
      return { ok: false, status: 404, text: async () => 'nf' };
    });
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) });

    const d = await adapter.describe(URL_);

    expect(String(fetchFn.mock.calls[0][0])).toBe('https://api.example.com/agent/openapi.json');
    expect(d.name).toBe('Orders API');
    expect(d.description).toBe('Order operations');
    expect(d.version).toBe('2.1.0');
    expect(d.skills).toContain('createOrder');
    expect(d.inputSchema).toEqual({ type: 'object', properties: { createOrder: reqSchema } });
    expect(d.outputSchema).toEqual({ type: 'object', properties: { createOrder: resSchema } });
    expect(d.fieldConfidence?.inputSchema).toBe('high');
    expect(d.invocation).toMatchObject({
      protocol: 'HTTP_ENDPOINT',
      target: URL_,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
    });
    expect(d.origin.substrate).toBe('http');
  });

  it('returns a minimal low-confidence descriptor when no OpenAPI is available', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 404, text: async () => 'nf' }));
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) });

    const d = await adapter.describe(URL_);

    expect(d.name).toBe('api.example.com');
    expect(d.inputSchema).toEqual({});
    expect(d.outputSchema).toEqual({});
    expect(d.skills).toEqual([]);
    expect(d.fieldConfidence?.inputSchema).toBe('low');
    expect(d.invocation.target).toBe(URL_);
  });

  it('reflects scope auth (API_KEY + secretRef) in the invocation block', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' }));
    const adapter = new HttpEndpointAdapter({
      fetchFn: asFetch(fetchFn),
      auth: { mode: 'API_KEY', secretRef: 'secret/http-key' },
    });

    const d = await adapter.describe(URL_);

    expect(d.invocation.auth).toEqual({ mode: 'API_KEY', secretRef: 'secret/http-key' });
  });
});

describe('HttpEndpointAdapter.healthCheck (US-IMP-011)', () => {
  it('returns reachable:true on a 2xx', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) });
    await expect(adapter.healthCheck(URL_)).resolves.toEqual({ reachable: true });
  });

  it('returns reachable:false (with detail) on a non-2xx WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 503 }));
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('503');
  });

  it('returns reachable:false on a network error WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('ECONNREFUSED');
  });
});

describe('HttpEndpointAdapter.vendCredentials', () => {
  it('returns minimal credentials (no roleArn ⇒ no assume) instead of throwing', async () => {
    const adapter = new HttpEndpointAdapter();
    const invocation: AgentInvocationBlock = {
      protocol: 'HTTP_ENDPOINT',
      target: URL_,
      auth: { mode: 'NONE' },
      mode: 'sync',
    };
    await expect(adapter.vendCredentials(invocation)).resolves.toEqual({});
  });
});
