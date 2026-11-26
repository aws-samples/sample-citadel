/**
 * Focused unit tests for the shared helpers extracted into invoke-support.ts:
 *   - collectOpenApi: OpenAPI doc -> input/output JSON schemas + operation keys
 *   - authHeaderScheme: auth.mode -> Authorization header scheme
 *
 * These cover the de-duplicated logic directly (the adapter tests prove the
 * call-sites are unchanged; these prove the extracted units in isolation).
 */
import { authHeaderScheme, collectOpenApi } from '../invoke-support';

describe('collectOpenApi (shared BEDROCK_AGENT + HTTP_ENDPOINT mapping)', () => {
  const reqSchema = { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] };
  const resSchema = { type: 'object', properties: { orderId: { type: 'string' } } };

  it('maps an operationId to its request/response schemas and lists the op', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Orders API', version: '2.1.0' },
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

    const { inputs, outputs, ops } = collectOpenApi(doc);

    expect(ops).toEqual(['createOrder']);
    expect(inputs).toEqual({ createOrder: reqSchema });
    expect(outputs).toEqual({ createOrder: resSchema });
  });

  it('falls back to "METHOD /path" as the op key when operationId is absent', () => {
    const doc = {
      paths: {
        '/ping': {
          get: {
            responses: { '200': { content: { 'application/json': { schema: resSchema } } } },
          },
        },
      },
    };

    const { outputs, ops } = collectOpenApi(doc);

    expect(ops).toEqual(['GET /ping']);
    expect(outputs).toEqual({ 'GET /ping': resSchema });
  });

  it('selects the first non-200 2xx response schema when no 200 is present', () => {
    const doc = {
      paths: {
        '/created': {
          post: {
            operationId: 'makeIt',
            responses: { '201': { content: { 'application/json': { schema: resSchema } } } },
          },
        },
      },
    };

    expect(collectOpenApi(doc).outputs).toEqual({ makeIt: resSchema });
  });

  it('returns empty maps/ops for a non-object doc or a doc without paths', () => {
    expect(collectOpenApi(undefined)).toEqual({ inputs: {}, outputs: {}, ops: [] });
    expect(collectOpenApi('not-a-doc')).toEqual({ inputs: {}, outputs: {}, ops: [] });
    expect(collectOpenApi({ info: {} })).toEqual({ inputs: {}, outputs: {}, ops: [] });
  });
});

describe('authHeaderScheme (shared HTTP_ENDPOINT + MCP mapping)', () => {
  const SECRET = 'resolved-secret-value';

  // mode → resolved {name,value} header (or null when the mode needs no
  // secret-derived header). BEARER joins the existing bearer-token modes;
  // API_KEY honours an optional custom header name.
  it.each([
    ['BEARER', undefined, { name: 'Authorization', value: `Bearer ${SECRET}` }],
    ['OAUTH2', undefined, { name: 'Authorization', value: `Bearer ${SECRET}` }],
    ['COGNITO', undefined, { name: 'Authorization', value: `Bearer ${SECRET}` }],
    ['API_KEY', undefined, { name: 'Authorization', value: SECRET }],
    ['API_KEY', 'x-api-key', { name: 'x-api-key', value: SECRET }],
  ] as const)('mode %s (customHeader=%s) → resolved header', (mode, customHeader, expected) => {
    expect(authHeaderScheme(mode, SECRET, customHeader)).toEqual(expected);
  });

  it('falls back to Authorization when the API_KEY custom header is blank/whitespace', () => {
    expect(authHeaderScheme('API_KEY', SECRET, '   ')).toEqual({
      name: 'Authorization',
      value: SECRET,
    });
  });

  it('returns null for SIGV4 and NONE — no secret-derived header', () => {
    expect(authHeaderScheme('NONE', SECRET)).toBeNull();
    expect(authHeaderScheme('SIGV4', SECRET)).toBeNull();
  });
});
