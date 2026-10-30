/**
 * Tests for OAuth 2.0 Authorization Server Metadata discovery (RFC 8414).
 *
 * Covers happy path, caching (hit/miss/expiry), HTTP failure modes,
 * JSON parsing, RFC 8414 metadata validation, snake_case→camelCase mapping,
 * PKCE S256 enforcement, and timeout.
 */

import {
  discoverOAuthEndpoints,
  __resetOAuthMetadataCacheForTest,
  OAuthMetadataError,
} from "../oauth-metadata";
import type { SafeFetchTransport, SafeResponse } from "../url-safety";

const TEST_URL =
  "https://auth.example.com/.well-known/oauth-authorization-server";

const validBody = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  scopes_supported: ["openid", "profile"],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "client_credentials"],
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
  // Forward-compat field — should survive in `raw`
  registration_endpoint: "https://auth.example.com/register",
};

function mockTransport(status: number, body: unknown): SafeFetchTransport {
  return jest.fn(async (): Promise<SafeResponse> => ({
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  }));
}

function mockInvalidJsonTransport(status = 200): SafeFetchTransport {
  return jest.fn(async (): Promise<SafeResponse> => ({
    status,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<!DOCTYPE html>"),
  }));
}

describe("discoverOAuthEndpoints", () => {
  beforeEach(() => {
    __resetOAuthMetadataCacheForTest();
  });

  it("happy path: 200 with valid metadata returns parsed object preserving raw", async () => {
    const transport = mockTransport(200, validBody);

    const result = await discoverOAuthEndpoints(TEST_URL, { transport });

    expect(result).not.toBeNull();
    expect(result!.issuer).toBe("https://auth.example.com");
    expect(result!.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(result!.authorizationEndpoint).toBe(
      "https://auth.example.com/authorize",
    );
    expect(result!.scopesSupported).toEqual(["openid", "profile"]);
    expect(result!.codeChallengeMethodsSupported).toEqual(["S256"]);
    expect(result!.grantTypesSupported).toEqual([
      "authorization_code",
      "client_credentials",
    ]);
    expect(result!.tokenEndpointAuthMethodsSupported).toEqual([
      "client_secret_basic",
    ]);
    expect(result!.raw).toEqual(validBody);
    // Forward-compat field preserved in raw
    expect(result!.raw["registration_endpoint"]).toBe(
      "https://auth.example.com/register",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("snake_case keys are converted to camelCase in returned object", async () => {
    const transport = mockTransport(200, validBody);

    const result = await discoverOAuthEndpoints(TEST_URL, { transport });

    expect(result).not.toBeNull();
    // camelCase fields exist on top-level result
    expect(result).toHaveProperty("tokenEndpoint");
    expect(result).toHaveProperty("authorizationEndpoint");
    expect(result).toHaveProperty("scopesSupported");
    expect(result).toHaveProperty("codeChallengeMethodsSupported");
    expect(result).toHaveProperty("grantTypesSupported");
    expect(result).toHaveProperty("tokenEndpointAuthMethodsSupported");
    // snake_case keys are NOT on top-level result (only inside raw)
    const top = result as unknown as Record<string, unknown>;
    expect(top["token_endpoint"]).toBeUndefined();
    expect(top["authorization_endpoint"]).toBeUndefined();
    expect(top["code_challenge_methods_supported"]).toBeUndefined();
    expect(result!.raw["token_endpoint"]).toBe(
      "https://auth.example.com/token",
    );
  });

  it("cache hit: second call within TTL fetches only once", async () => {
    const transport = mockTransport(200, validBody);
    let nowVal = 1_000_000;
    const opts = {
      transport,
      cacheTtlMs: 60_000,
      now: () => nowVal,
    };

    await discoverOAuthEndpoints(TEST_URL, opts);
    nowVal += 30_000; // still within TTL
    await discoverOAuthEndpoints(TEST_URL, opts);

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("cache miss after TTL expiry: third call after now() advances past TTL fetches twice", async () => {
    const transport = mockTransport(200, validBody);
    let nowVal = 1_000_000;
    const opts = {
      transport,
      cacheTtlMs: 60_000,
      now: () => nowVal,
    };

    await discoverOAuthEndpoints(TEST_URL, opts); // call 1: miss → fetch
    nowVal += 30_000;
    await discoverOAuthEndpoints(TEST_URL, opts); // call 2: hit
    expect(transport).toHaveBeenCalledTimes(1);

    nowVal += 60_001; // past TTL
    await discoverOAuthEndpoints(TEST_URL, opts); // call 3: miss → fetch again

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("404 response returns null (signal to fall back to explicit URLs)", async () => {
    const transport = mockTransport(404, { error: "not_found" });

    const result = await discoverOAuthEndpoints(TEST_URL, { transport });

    expect(result).toBeNull();
  });

  it("500 response throws OAuthMetadataError(NETWORK_ERROR, 500)", async () => {
    const transport = mockTransport(500, { error: "internal" });

    await expect(
      discoverOAuthEndpoints(TEST_URL, { transport }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "NETWORK_ERROR",
      statusCode: 500,
    });
  });

  it("transport reject (network error) throws OAuthMetadataError(NETWORK_ERROR) without statusCode", async () => {
    const transport: SafeFetchTransport = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    let caught: unknown;
    try {
      await discoverOAuthEndpoints(TEST_URL, { transport });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OAuthMetadataError);
    const err = caught as OAuthMetadataError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.statusCode).toBeUndefined();
  });

  it("invalid JSON body throws OAuthMetadataError(INVALID_JSON)", async () => {
    const transport = mockInvalidJsonTransport();

    await expect(
      discoverOAuthEndpoints(TEST_URL, { transport }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "INVALID_JSON",
    });
  });

  it("missing issuer throws OAuthMetadataError(INVALID_METADATA)", async () => {
    const body: Record<string, unknown> = {
      authorization_endpoint: validBody.authorization_endpoint,
      token_endpoint: validBody.token_endpoint,
      // no `issuer`
    };
    const transport = mockTransport(200, body);

    await expect(
      discoverOAuthEndpoints(TEST_URL, { transport }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "INVALID_METADATA",
    });
  });

  it("blank issuer throws OAuthMetadataError(INVALID_METADATA)", async () => {
    const body: Record<string, unknown> = { ...validBody, issuer: "   " };
    const transport = mockTransport(200, body);

    await expect(
      discoverOAuthEndpoints(TEST_URL, { transport }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "INVALID_METADATA",
    });
  });

  it("missing token_endpoint throws OAuthMetadataError(INVALID_METADATA)", async () => {
    const body: Record<string, unknown> = {
      issuer: validBody.issuer,
      authorization_endpoint: validBody.authorization_endpoint,
      // no `token_endpoint`
    };
    const transport = mockTransport(200, body);

    await expect(
      discoverOAuthEndpoints(TEST_URL, { transport }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "INVALID_METADATA",
    });
  });

  it("requireAuthorizationCodePKCE + missing code_challenge_methods_supported throws PKCE_S256_REQUIRED", async () => {
    const body: Record<string, unknown> = {
      issuer: validBody.issuer,
      authorization_endpoint: validBody.authorization_endpoint,
      token_endpoint: validBody.token_endpoint,
      // no code_challenge_methods_supported
    };
    const transport = mockTransport(200, body);

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        transport,
        requireAuthorizationCodePKCE: true,
      }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "PKCE_S256_REQUIRED",
    });
  });

  it("requireAuthorizationCodePKCE + ['plain'] only throws PKCE_S256_REQUIRED", async () => {
    const body: Record<string, unknown> = {
      ...validBody,
      code_challenge_methods_supported: ["plain"],
    };
    const transport = mockTransport(200, body);

    await expect(
      discoverOAuthEndpoints(TEST_URL, {
        transport,
        requireAuthorizationCodePKCE: true,
      }),
    ).rejects.toMatchObject({
      name: "OAuthMetadataError",
      code: "PKCE_S256_REQUIRED",
    });
  });

  it("requireAuthorizationCodePKCE + ['S256','plain'] succeeds", async () => {
    const body: Record<string, unknown> = {
      ...validBody,
      code_challenge_methods_supported: ["S256", "plain"],
    };
    const transport = mockTransport(200, body);

    const result = await discoverOAuthEndpoints(TEST_URL, {
      transport,
      requireAuthorizationCodePKCE: true,
    });

    expect(result).not.toBeNull();
    expect(result!.codeChallengeMethodsSupported).toEqual(["S256", "plain"]);
  });

  it("timeout: safeFetch transport times out throws OAuthMetadataError(NETWORK_ERROR)", async () => {
    const transport: SafeFetchTransport = jest.fn(async () => {
      throw new Error("request timed out");
    });

    let caught: unknown;
    try {
      await discoverOAuthEndpoints(TEST_URL, { transport });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OAuthMetadataError);
    const err = caught as OAuthMetadataError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toMatch(/time(d)? ?out/i);
  });

  it("__resetOAuthMetadataCacheForTest clears the cache between tests", async () => {
    const transport = mockTransport(200, validBody);

    await discoverOAuthEndpoints(TEST_URL, { transport });
    await discoverOAuthEndpoints(TEST_URL, { transport });
    expect(transport).toHaveBeenCalledTimes(1);

    __resetOAuthMetadataCacheForTest();

    await discoverOAuthEndpoints(TEST_URL, { transport });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
