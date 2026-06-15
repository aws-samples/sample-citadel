/**
 * Tests for OAuth 2.0 Authorization Server Metadata discovery (RFC 8414).
 *
 * Covers happy path, caching (hit/miss/expiry), HTTP failure modes,
 * JSON parsing, RFC 8414 metadata validation, snake_case→camelCase mapping,
 * PKCE S256 enforcement, and AbortController-based timeout.
 */

import {
  discoverOAuthEndpoints,
  __resetOAuthMetadataCacheForTest,
  OAuthMetadataError,
} from '../oauth-metadata';

const TEST_URL =
  'https://auth.example.com/.well-known/oauth-authorization-server';

const validBody = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  scopes_supported: ['openid', 'profile'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'client_credentials'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
  // Forward-compat field — should survive in `raw`
  registration_endpoint: 'https://auth.example.com/register',
};

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockInvalidJsonResponse(status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
    text: async () => '<!DOCTYPE html>',
  } as unknown as Response;
}

describe('discoverOAuthEndpoints', () => {
  beforeEach(() => {
    __resetOAuthMetadataCacheForTest();
  });

  it('happy path: 200 with valid metadata returns parsed object preserving raw', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, validBody));

    const result = await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).not.toBeNull();
    expect(result!.issuer).toBe('https://auth.example.com');
    expect(result!.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(result!.authorizationEndpoint).toBe(
      'https://auth.example.com/authorize',
    );
    expect(result!.scopesSupported).toEqual(['openid', 'profile']);
    expect(result!.codeChallengeMethodsSupported).toEqual(['S256']);
    expect(result!.grantTypesSupported).toEqual([
      'authorization_code',
      'client_credentials',
    ]);
    expect(result!.tokenEndpointAuthMethodsSupported).toEqual([
      'client_secret_basic',
    ]);
    expect(result!.raw).toEqual(validBody);
    // Forward-compat field preserved in raw
    expect(result!.raw['registration_endpoint']).toBe(
      'https://auth.example.com/register',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('snake_case keys are converted to camelCase in returned object', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, validBody));

    const result = await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).not.toBeNull();
    // camelCase fields exist on top-level result
    expect(result).toHaveProperty('tokenEndpoint');
    expect(result).toHaveProperty('authorizationEndpoint');
    expect(result).toHaveProperty('scopesSupported');
    expect(result).toHaveProperty('codeChallengeMethodsSupported');
    expect(result).toHaveProperty('grantTypesSupported');
    expect(result).toHaveProperty('tokenEndpointAuthMethodsSupported');
    // snake_case keys are NOT on top-level result (only inside raw)
    const top = result as unknown as Record<string, unknown>;
    expect(top['token_endpoint']).toBeUndefined();
    expect(top['authorization_endpoint']).toBeUndefined();
    expect(top['code_challenge_methods_supported']).toBeUndefined();
    expect(result!.raw['token_endpoint']).toBe('https://auth.example.com/token');
  });

  it('cache hit: second call within TTL fetches only once', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, validBody));
    let nowVal = 1_000_000;
    const opts = {
      fetchFn: fetchFn as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      now: () => nowVal,
    };

    await discoverOAuthEndpoints(TEST_URL, opts);
    nowVal += 30_000; // still within TTL
    await discoverOAuthEndpoints(TEST_URL, opts);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('cache miss after TTL expiry: third call after now() advances past TTL fetches twice', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, validBody));
    let nowVal = 1_000_000;
    const opts = {
      fetchFn: fetchFn as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      now: () => nowVal,
    };

    await discoverOAuthEndpoints(TEST_URL, opts); // call 1: miss → fetch
    nowVal += 30_000;
    await discoverOAuthEndpoints(TEST_URL, opts); // call 2: hit
    expect(fetchFn).toHaveBeenCalledTimes(1);

    nowVal += 60_001; // past TTL
    await discoverOAuthEndpoints(TEST_URL, opts); // call 3: miss → fetch again

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('404 response returns null (signal to fall back to explicit URLs)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(mockJsonResponse(404, { error: 'not_found' }));

    const result = await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });

  it('500 response throws OAuthMetadataError(NETWORK_ERROR, 500)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(mockJsonResponse(500, { error: 'internal' }));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'NETWORK_ERROR',
      statusCode: 500,
    });
  });

  it('fetch reject (network error) throws OAuthMetadataError(NETWORK_ERROR) without statusCode', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    let caught: unknown;
    try {
      await discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OAuthMetadataError);
    const err = caught as OAuthMetadataError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.statusCode).toBeUndefined();
  });

  it('invalid JSON body throws OAuthMetadataError(INVALID_JSON)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockInvalidJsonResponse());

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'INVALID_JSON',
    });
  });

  it('missing issuer throws OAuthMetadataError(INVALID_METADATA)', async () => {
    const body: Record<string, unknown> = {
      authorization_endpoint: validBody.authorization_endpoint,
      token_endpoint: validBody.token_endpoint,
      // no `issuer`
    };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'INVALID_METADATA',
    });
  });

  it('blank issuer throws OAuthMetadataError(INVALID_METADATA)', async () => {
    const body: Record<string, unknown> = { ...validBody, issuer: '   ' };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'INVALID_METADATA',
    });
  });

  it('missing token_endpoint throws OAuthMetadataError(INVALID_METADATA)', async () => {
    const body: Record<string, unknown> = {
      issuer: validBody.issuer,
      authorization_endpoint: validBody.authorization_endpoint,
      // no `token_endpoint`
    };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'INVALID_METADATA',
    });
  });

  it('requireAuthorizationCodePKCE + missing code_challenge_methods_supported throws PKCE_S256_REQUIRED', async () => {
    const body: Record<string, unknown> = {
      issuer: validBody.issuer,
      authorization_endpoint: validBody.authorization_endpoint,
      token_endpoint: validBody.token_endpoint,
      // no code_challenge_methods_supported
    };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
        requireAuthorizationCodePKCE: true,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'PKCE_S256_REQUIRED',
    });
  });

  it("requireAuthorizationCodePKCE + ['plain'] only throws PKCE_S256_REQUIRED", async () => {
    const body: Record<string, unknown> = {
      ...validBody,
      code_challenge_methods_supported: ['plain'],
    };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
        requireAuthorizationCodePKCE: true,
      }),
    ).rejects.toMatchObject({
      name: 'OAuthMetadataError',
      code: 'PKCE_S256_REQUIRED',
    });
  });

  it("requireAuthorizationCodePKCE + ['S256','plain'] succeeds", async () => {
    const body: Record<string, unknown> = {
      ...validBody,
      code_challenge_methods_supported: ['S256', 'plain'],
    };
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, body));

    const result = await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
      requireAuthorizationCodePKCE: true,
    });

    expect(result).not.toBeNull();
    expect(result!.codeChallengeMethodsSupported).toEqual(['S256', 'plain']);
  });

  it('timeout: fetch hangs >10s throws NETWORK_ERROR with timeout-related message', async () => {
    jest.useFakeTimers();
    try {
      const fetchFn = jest.fn(
        (_url: string, init: RequestInit): Promise<Response> =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const promise = discoverOAuthEndpoints(TEST_URL, {
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      // Advance past the 10-second timeout
      jest.advanceTimersByTime(10_001);

      let caught: unknown;
      try {
        await promise;
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(OAuthMetadataError);
      const err = caught as OAuthMetadataError;
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.message).toMatch(/time(d)? ?out/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('__resetOAuthMetadataCacheForTest clears the cache between tests', async () => {
    const fetchFn = jest.fn().mockResolvedValue(mockJsonResponse(200, validBody));

    await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    __resetOAuthMetadataCacheForTest();

    await discoverOAuthEndpoints(TEST_URL, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
