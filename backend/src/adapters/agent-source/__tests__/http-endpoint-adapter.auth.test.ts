/**
 * Invoke-side auth-secret resolution tests for the HTTP endpoint adapter
 * (completes the US-IMP 003 auth TODO). An injected `resolveSecret` dep turns
 * an invocation `auth.secretRef` into an Authorization header:
 *   API_KEY        -> Authorization: <value>        (sent verbatim)
 *   OAUTH2/COGNITO -> Authorization: Bearer <value> (bearer-token modes)
 *   SIGV4 / NONE / no secretRef / no resolver -> no secret resolved (unchanged)
 *
 * NOTE: the task spec's "BEARER" mode is realized by the OAUTH2/COGNITO bearer
 * modes — the AgentInvocationAuthMode union (registry-service, out of scope to
 * modify) has no BEARER literal. global fetch is injected as a fake.
 */
import { HttpEndpointAdapter } from '../http-endpoint-adapter';
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from '../base';

const TARGET = 'https://api.example.com/agent';
const SECRET_VALUE = 'sk-super-secret-token-DO-NOT-LOG';

interface FetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}
const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;

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

function makeFetch(): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ output: 'ok' }),
  }));
}

function headersOf(fetchFn: jest.Mock): Record<string, string> {
  return (fetchFn.mock.calls[0][1] as FetchInit).headers ?? {};
}

describe('HttpEndpointAdapter.invoke — secret-backed auth headers', () => {
  it('OAUTH2 + secretRef: resolves the secret and sends Authorization: Bearer <value>', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/oauth' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith('secret/oauth');
    expect(headersOf(fetchFn).authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('API_KEY + secretRef: sends the raw value as the Authorization header', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/key' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/key');
    expect(headersOf(fetchFn).authorization).toBe(SECRET_VALUE);
  });

  it('COGNITO + secretRef: sends Authorization: Bearer <value>', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'COGNITO', secretRef: 'secret/cog' },
        mode: 'sync',
      }),
    );

    expect(headersOf(fetchFn).authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('BEARER + secretRef: resolves the secret and sends Authorization: Bearer <value>', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'BEARER', secretRef: 'secret/bearer' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith('secret/bearer');
    expect(headersOf(fetchFn).authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it('API_KEY + custom header: applies the custom header name carrying the raw value', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/key', header: 'x-api-key' },
        mode: 'sync',
      }),
    );

    const headers = headersOf(fetchFn);
    expect(headers['x-api-key']).toBe(SECRET_VALUE);
    // The default Authorization header is NOT set when a custom header is used.
    expect(headers.authorization).toBeUndefined();
  });

  it('mode NONE: does not resolve a secret and sends no Authorization header', async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'NONE' },
        mode: 'sync',
      }),
    );

    expect(resolveSecret).not.toHaveBeenCalled();
    expect(headersOf(fetchFn).authorization).toBeUndefined();
  });

  it('SIGV4: signs the request and never resolves a secret', async () => {
    const sign = jest.fn(async () => ({ headers: { authorization: 'AWS4-SIGNED' } }));
    const signerFactory = jest.fn(() => ({ sign }));
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({
      fetchFn: asFetch(fetchFn),
      signerFactory,
      resolveSecret,
    });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('secretRef present but no resolver wired: behaves as before (no auth header)', async () => {
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn) }); // no resolveSecret

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'API_KEY', secretRef: 'secret/key' },
        mode: 'sync',
      }),
    );

    expect(headersOf(fetchFn).authorization).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('NEVER logs the resolved secret value', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = makeFetch();
    const adapter = new HttpEndpointAdapter({ fetchFn: asFetch(fetchFn), resolveSecret });

    await adapter.invoke(
      baseReq,
      descriptorFor({
        protocol: 'HTTP_ENDPOINT',
        target: TARGET,
        auth: { mode: 'OAUTH2', secretRef: 'secret/oauth' },
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
