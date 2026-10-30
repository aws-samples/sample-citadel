/**
 * OAuth 2.0 Authorization Server Metadata discovery (RFC 8414).
 *
 * Phase 2 of MCP_SERVER OAuth2 integration registration uses this helper to
 * resolve a user-provided `discoveryUrl` (e.g.
 * `https://auth.example.com/.well-known/oauth-authorization-server`) into
 * concrete `tokenEndpoint` / `authorizationEndpoint` URLs before calling
 * AgentCore Identity.
 *
 * Behaviour:
 *  - On HTTP 200, fetches the JSON metadata, validates required RFC 8414
 *    fields, converts snake_case → camelCase, and caches the parsed
 *    metadata in-memory for 15 minutes (Lambda warm-container scope).
 *  - On HTTP 404, returns `null` so the caller can fall back to explicit
 *    user-provided `tokenUrl` / `authorizationUrl`.
 *  - On any other failure (non-200, JSON parse error, missing required
 *    fields, missing PKCE S256 when required, network error, timeout)
 *    throws `OAuthMetadataError` with a typed `code`.
 *
 * Reference: RFC 8414 §3 (Authorization Server Metadata).
 *
 * // TODO: verify against MCP 2025-11-25 spec §X.Y
 *   The MCP 2025-11-25 spec references RFC 8414 for OAuth-protected MCP
 *   servers. Confirm the exact section number for the metadata exposure
 *   requirement before merging Phase 2.
 */

import {
  parsePublicHttpsUrl,
  emitUrlRefused,
  safeFetch,
  UrlRejectedError,
} from "./url-safety";
import type { DnsLookupFn, SafeFetchTransport } from "./url-safety";

export interface OAuthAuthorizationServerMetadata {
  /** Required by RFC 8414 §2 — issuer identifier URL. */
  issuer: string;
  /** Required only for AUTHORIZATION_CODE flow. */
  authorizationEndpoint?: string;
  /** Always required for any flow that obtains tokens. */
  tokenEndpoint: string;
  scopesSupported?: string[];
  /** PKCE — see RFC 7636. */
  codeChallengeMethodsSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  /**
   * The full original JSON body, preserved verbatim so callers can read
   * fields not yet mapped to typed properties (forward-compat).
   */
  raw: Record<string, unknown>;
}

export interface DiscoverOptions {
  /**
   * Required if the caller is configuring the AUTHORIZATION_CODE flow —
   * the metadata MUST advertise `S256` in
   * `code_challenge_methods_supported`. Set to `false` (or omit) for
   * CLIENT_CREDENTIALS flows.
   */
  requireAuthorizationCodePKCE?: boolean;
  /** Override the in-memory cache TTL (default 15 minutes). For tests. */
  cacheTtlMs?: number;
  /**
   * Transport override injected into safeFetch (for tests).
   * In production safeFetch uses its default HTTPS transport.
   */
  transport?: SafeFetchTransport;
  /** Time source override for cache expiry tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable DNS lookup for SSRF-safe address resolution (test seam). */
  dnsLookup?: DnsLookupFn;
}

export class OAuthMetadataError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NETWORK_ERROR"
      | "NOT_FOUND"
      | "INVALID_JSON"
      | "INVALID_METADATA"
      | "PKCE_S256_REQUIRED"
      | "URL_REJECTED",
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OAuthMetadataError";
  }
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  value: OAuthAuthorizationServerMetadata;
  expiresAt: number;
}

// Module-scope cache. Persists across Lambda invocations on a warm container.
const metadataCache: Map<string, CacheEntry> = new Map();

/**
 * Canonicalise the discovery URL for cache keying. Whitespace-trim and
 * resolve through the URL parser to normalise host casing and drop
 * fragments. Falls back to the raw string if the URL is unparseable —
 * `discoverOAuthEndpoints` will surface the underlying fetch failure.
 */
function canonicaliseUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    return u.toString();
  } catch {
    return trimmed;
  }
}

function logInfo(message: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "INFO",
      source: "oauth-metadata",
      message,
      ...fields,
    }),
  );
}

function logError(message: string, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "ERROR",
      source: "oauth-metadata",
      message,
      ...fields,
    }),
  );
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

/**
 * Validate and project the raw JSON metadata onto the typed
 * camelCase shape. PKCE S256 enforcement runs separately.
 */
function projectMetadata(
  raw: Record<string, unknown>,
): OAuthAuthorizationServerMetadata {
  if (!isNonEmptyString(raw["issuer"])) {
    throw new OAuthMetadataError(
      "Invalid OAuth metadata: 'issuer' is required and must be a non-empty string",
      "INVALID_METADATA",
    );
  }
  if (!isNonEmptyString(raw["token_endpoint"])) {
    throw new OAuthMetadataError(
      "Invalid OAuth metadata: 'token_endpoint' is required and must be a non-empty string",
      "INVALID_METADATA",
    );
  }

  const result: OAuthAuthorizationServerMetadata = {
    issuer: raw["issuer"],
    tokenEndpoint: raw["token_endpoint"],
    raw,
  };

  if (isNonEmptyString(raw["authorization_endpoint"])) {
    result.authorizationEndpoint = raw["authorization_endpoint"];
  }

  const scopes = asStringArray(raw["scopes_supported"]);
  if (scopes !== undefined) result.scopesSupported = scopes;

  const pkce = asStringArray(raw["code_challenge_methods_supported"]);
  if (pkce !== undefined) result.codeChallengeMethodsSupported = pkce;

  const grants = asStringArray(raw["grant_types_supported"]);
  if (grants !== undefined) result.grantTypesSupported = grants;

  const authMethods = asStringArray(
    raw["token_endpoint_auth_methods_supported"],
  );
  if (authMethods !== undefined) {
    result.tokenEndpointAuthMethodsSupported = authMethods;
  }

  return result;
}

function enforcePKCE(metadata: OAuthAuthorizationServerMetadata): void {
  const methods = metadata.codeChallengeMethodsSupported;
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    throw new OAuthMetadataError(
      "OAuth Authorization Code flow requires 'S256' in code_challenge_methods_supported",
      "PKCE_S256_REQUIRED",
    );
  }
}

/**
 * Fetch OAuth 2.0 Authorization Server Metadata per RFC 8414.
 *
 * Returns NULL on 404 so the caller can fall back to user-provided
 * explicit endpoints. All other failures throw OAuthMetadataError.
 *
 * Cached in-memory for 15 minutes (Lambda warm-container scope) keyed
 * by the canonicalised discoveryUrl.
 */
export async function discoverOAuthEndpoints(
  discoveryUrl: string,
  opts: DiscoverOptions = {},
): Promise<OAuthAuthorizationServerMetadata | null> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const requirePKCE = opts.requireAuthorizationCodePKCE === true;

  const key = canonicaliseUrl(discoveryUrl);

  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > now()) {
    if (requirePKCE) enforcePKCE(cached.value);
    return cached.value;
  }

  logInfo("oauth metadata cache miss; fetching", { discoveryUrl: key });

  // SSRF gate: validate the discoveryUrl before any network I/O.
  try {
    parsePublicHttpsUrl(discoveryUrl);
  } catch (err) {
    emitUrlRefused("oauth-metadata:discovery");
    const detail = err instanceof Error ? err.message : String(err);
    logError("oauth metadata URL rejected", {
      discoveryUrl: key,
      error: detail,
    });
    throw new OAuthMetadataError(
      `OAuth discovery URL rejected: ${detail}`,
      "URL_REJECTED",
    );
  }

  let response;
  try {
    response = await safeFetch(
      discoveryUrl,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      {
        lookup: opts.dnsLookup,
        transport: opts.transport,
        timeoutMs: FETCH_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (err instanceof UrlRejectedError) {
      emitUrlRefused("oauth-metadata:discovery");
      logError("oauth metadata fetch SSRF-rejected", {
        discoveryUrl: key,
        error: (err as Error).message,
      });
      throw new OAuthMetadataError(
        `OAuth metadata fetch rejected: ${(err as Error).message}`,
        "URL_REJECTED",
      );
    }
    const message = `OAuth metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    logError("oauth metadata fetch failed", {
      discoveryUrl: key,
      error: message,
    });
    throw new OAuthMetadataError(message, "NETWORK_ERROR");
  }

  if (response.status === 404) {
    logInfo("oauth metadata 404 — caller should use explicit URLs", {
      discoveryUrl: key,
    });
    return null;
  }

  if (response.status < 200 || response.status >= 300) {
    const message = `OAuth metadata fetch returned non-success status ${response.status}`;
    logError("oauth metadata non-success status", {
      discoveryUrl: key,
      statusCode: response.status,
    });
    throw new OAuthMetadataError(message, "NETWORK_ERROR", response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError("oauth metadata invalid JSON", {
      discoveryUrl: key,
      error: detail,
    });
    throw new OAuthMetadataError(
      `OAuth metadata response is not valid JSON: ${detail}`,
      "INVALID_JSON",
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    logError("oauth metadata not a JSON object", { discoveryUrl: key });
    throw new OAuthMetadataError(
      "OAuth metadata response is not a JSON object",
      "INVALID_METADATA",
    );
  }

  let metadata: OAuthAuthorizationServerMetadata;
  try {
    metadata = projectMetadata(body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof OAuthMetadataError) {
      logError("oauth metadata validation failed", {
        discoveryUrl: key,
        code: err.code,
        error: err.message,
      });
    }
    throw err;
  }

  if (requirePKCE) {
    try {
      enforcePKCE(metadata);
    } catch (err) {
      if (err instanceof OAuthMetadataError) {
        logError("oauth metadata pkce check failed", {
          discoveryUrl: key,
          code: err.code,
          error: err.message,
        });
      }
      throw err;
    }
  }

  metadataCache.set(key, { value: metadata, expiresAt: now() + ttlMs });
  return metadata;
}

/** Test-only: clear the in-memory cache. Not part of the public API. */
export function __resetOAuthMetadataCacheForTest(): void {
  metadataCache.clear();
}
