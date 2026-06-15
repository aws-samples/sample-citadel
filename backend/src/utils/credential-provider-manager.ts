/**
 * credential-provider-manager
 *
 * Wraps AgentCore Identity SDK to provide idempotent CRUD on OAuth2 and
 * API_KEY credential providers, with retry-with-jitter for the 5 TPS
 * account-level rate limit.
 *
 * Replaces the stub at backend/src/utils/gateway-target-manager.ts
 * (createCredentialProvider returning fake ARNs).
 *
 * Idempotency contract:
 *   create-or-upsert  → CreateX; on ConflictException → UpdateX;
 *                       on UpdateX ResourceNotFoundException → retry CreateX once.
 *   delete            → DeleteX; ResourceNotFoundException is treated as success.
 *
 * Retry contract:
 *   ThrottlingException is retried up to 4 times with exponential back-off
 *   (200ms, 400ms, 800ms, 1600ms) and full jitter. After the 5th throttle,
 *   we throw CredentialProviderError(THROTTLED).
 *
 * SDK preflight notes (verified against
 * @aws-sdk/client-bedrock-agentcore-control dist-types):
 *   • CreateOauth2CredentialProviderRequest is NESTED:
 *       { name, credentialProviderVendor: 'CustomOauth2',
 *         oauth2ProviderConfigInput: { customOauth2ProviderConfig: {
 *           oauthDiscovery: { authorizationServerMetadata: {
 *             issuer, authorizationEndpoint, tokenEndpoint  // ALL required
 *           }},
 *           clientId, clientSecret, clientAuthenticationMethod
 *         }}
 *       }
 *   • The architect's input interface accepts `scopes`, `grantType`, and
 *     `defaultReturnUrl`. None of these have a corresponding field in the
 *     SDK CreateOauth2CredentialProviderRequest. They are validated at the
 *     manager layer (defence-in-depth) but NOT forwarded to the SDK.
 *     See TODOs below.
 *   • Response shapes are nested: `clientSecretArn: { secretArn: string }`
 *     and `apiKeySecretArn: { secretArn: string }`.
 *
 * Project conventions:
 *   - Lazy module-scope SDK client (configurable region from AWS_REGION env).
 *   - DI override via the optional `client` parameter for tests.
 *   - Typed errors via `CredentialProviderError`.
 *   - Structured logs via `logger`.
 */

import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  CreateOauth2CredentialProviderCommandInput,
  CreateOauth2CredentialProviderCommandOutput,
  UpdateOauth2CredentialProviderCommand,
  UpdateOauth2CredentialProviderCommandInput,
  UpdateOauth2CredentialProviderCommandOutput,
  DeleteOauth2CredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  CreateApiKeyCredentialProviderCommandOutput,
  UpdateApiKeyCredentialProviderCommand,
  UpdateApiKeyCredentialProviderCommandOutput,
  DeleteApiKeyCredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import { logger } from './logger';

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

/**
 * Pre-resolved OAuth2 endpoints. Phase 2's integration-resolver populates
 * these via `oauth-metadata.discoverOAuthEndpoints` (with explicit URLs
 * as fallback). All values arriving here MUST already be concrete URLs.
 */
export interface ResolvedOauth2Endpoints {
  /** Always required. */
  tokenEndpoint: string;
  /** Required if grantType === 'AUTHORIZATION_CODE'. */
  authorizationEndpoint?: string;
  /** Optional issuer; falls back to the tokenEndpoint origin if absent. */
  issuer?: string;
}

export interface CreateOauth2ProviderInput {
  integrationId: string;
  clientId: string;
  clientSecret: string;
  endpoints: ResolvedOauth2Endpoints;
  scopes: string[];
  grantType: 'CLIENT_CREDENTIALS' | 'AUTHORIZATION_CODE' | 'TOKEN_EXCHANGE';
  /** Default: CLIENT_SECRET_BASIC. */
  clientAuthenticationMethod?: 'CLIENT_SECRET_BASIC' | 'CLIENT_SECRET_POST';
  /** For 3LO; supplied by Phase 2 from SSM. Currently informational only — see TODO. */
  defaultReturnUrl?: string;
}

export interface CreateApiKeyProviderInput {
  integrationId: string;
  apiKey: string;
}

export interface CredentialProviderResult {
  credentialProviderArn: string;
  /** Populated only for OAUTH2 (returned by SDK). */
  callbackUrl?: string;
  /** AgentCore-managed Secrets Manager ARN where the credential is stored. */
  internalSecretArn?: string;
  /** Raw SDK response, for debugging. */
  rawResponse: unknown;
}

export type CredentialProviderErrorCode =
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'THROTTLED'
  | 'VALIDATION'
  | 'INTERNAL'
  | 'SDK_SHAPE_MISMATCH';

export class CredentialProviderError extends Error {
  constructor(
    message: string,
    public readonly code: CredentialProviderErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CredentialProviderError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internals: lazy client + sleep (both DI-overridable for tests)
// ────────────────────────────────────────────────────────────────────────

let _client: BedrockAgentCoreControlClient | null = null;

function getClient(override?: BedrockAgentCoreControlClient): BedrockAgentCoreControlClient {
  if (override) return override;
  return (_client ??= new BedrockAgentCoreControlClient({ region: process.env.AWS_REGION }));
}

/** @internal — test hook to drop the cached client. */
export function __resetClientForTesting(): void {
  _client = null;
}

let _sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** @internal — test hook to replace setTimeout-based sleep with a no-op or controllable stub. */
export function __setSleepForTesting(fn: (ms: number) => Promise<void>): void {
  _sleep = fn;
}

// ────────────────────────────────────────────────────────────────────────
// Retry-with-jitter
// ────────────────────────────────────────────────────────────────────────

const MAX_THROTTLE_RETRIES = 4;
const THROTTLE_BASE_MS = 200;

function isThrottling(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ThrottlingException';
}
function isConflict(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConflictException';
}
function isNotFound(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ResourceNotFoundException';
}
function isValidation(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ValidationException';
}

/** Run `fn`; on ThrottlingException retry up to MAX_THROTTLE_RETRIES times with exp+jitter. */
async function withThrottlingRetry<T>(fn: () => Promise<T>, opName: string): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isThrottling(err)) throw err;
      if (attempt >= MAX_THROTTLE_RETRIES) {
        logger.error(
          'credential-provider-manager throttled after retries',
          { opName, attempts: attempt + 1 },
          err as Error,
        );
        throw new CredentialProviderError(
          `AgentCore Identity API throttled after ${attempt + 1} attempts`,
          'THROTTLED',
          err,
        );
      }
      // Exponential back-off with full jitter: 200ms, 400ms, 800ms, 1600ms (× random ∈ [0,1)).
      const exp = THROTTLE_BASE_MS * Math.pow(2, attempt);
      const delay = Math.random() * exp;
      logger.warn('credential-provider-manager throttled — backing off', {
        opName,
        attempt: attempt + 1,
        delayMs: Math.round(delay),
      });
      await _sleep(delay);
      attempt += 1;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// OAuth2: input validation, request building, response mapping
// ────────────────────────────────────────────────────────────────────────

function oauth2ProviderName(integrationId: string): string {
  return `integration-${integrationId}-oauth`;
}

function apiKeyProviderName(integrationId: string): string {
  return `integration-${integrationId}-api-key`;
}

function deriveIssuer(endpoints: ResolvedOauth2Endpoints): string {
  if (endpoints.issuer) return endpoints.issuer;
  // TODO: verify against actual SDK behavior — falling back to the
  // tokenEndpoint origin lets the SDK's required `issuer` field be
  // satisfied when callers omit it. Phase 2's discoverOAuthEndpoints
  // should normally populate `issuer` from the IdP's OIDC discovery doc.
  try {
    return new URL(endpoints.tokenEndpoint).origin;
  } catch {
    throw new CredentialProviderError(
      `endpoints.tokenEndpoint is not a valid URL: ${endpoints.tokenEndpoint}`,
      'VALIDATION',
    );
  }
}

function validateOauth2Input(input: CreateOauth2ProviderInput): void {
  if (!input.integrationId) {
    throw new CredentialProviderError('integrationId is required', 'VALIDATION');
  }
  if (!input.clientId || !input.clientSecret) {
    throw new CredentialProviderError(
      'clientId and clientSecret are required for OAuth2',
      'VALIDATION',
    );
  }
  if (!input.endpoints?.tokenEndpoint) {
    throw new CredentialProviderError('endpoints.tokenEndpoint is required', 'VALIDATION');
  }
  if (input.grantType === 'AUTHORIZATION_CODE' && !input.endpoints.authorizationEndpoint) {
    throw new CredentialProviderError(
      'AUTHORIZATION_CODE grantType requires endpoints.authorizationEndpoint',
      'VALIDATION',
    );
  }
}

function buildOauth2RequestInput(
  input: CreateOauth2ProviderInput,
): CreateOauth2CredentialProviderCommandInput {
  // The SDK requires `authorizationEndpoint` even for non-AUTHORIZATION_CODE
  // flows (CLIENT_CREDENTIALS, TOKEN_EXCHANGE). When absent, fall back to the
  // tokenEndpoint so the request shape is well-formed; the field is still
  // unused by the IdP at runtime for these flows.
  // TODO: verify against actual SDK behavior — confirm the IdP-side ignores
  // authorizationEndpoint for CLIENT_CREDENTIALS and TOKEN_EXCHANGE flows.
  const authorizationEndpoint =
    input.endpoints.authorizationEndpoint ?? input.endpoints.tokenEndpoint;
  const issuer = deriveIssuer(input.endpoints);

  // TODO: verify against actual SDK behavior — the manager-level fields
  // `scopes`, `grantType` (CLIENT_CREDENTIALS/AUTHORIZATION_CODE), and
  // `defaultReturnUrl` are NOT present in the SDK
  // CreateOauth2CredentialProviderRequest as of @aws-sdk/client-bedrock-
  // agentcore-control 3.1036.0. They are accepted on the manager input for
  // caller convenience and validation, but cannot currently be forwarded
  // to AgentCore Identity. Phase 2 callers (gateway-target-manager) will
  // attach `scopes` to the gateway-target-level oauthCredentialProvider
  // payload, which IS where AgentCore expects scopes. `grantType` and
  // `defaultReturnUrl` are advisory metadata until/unless the SDK exposes
  // them.

  return {
    name: oauth2ProviderName(input.integrationId),
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        oauthDiscovery: {
          authorizationServerMetadata: {
            issuer,
            authorizationEndpoint,
            tokenEndpoint: input.endpoints.tokenEndpoint,
          },
        },
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        clientAuthenticationMethod: input.clientAuthenticationMethod ?? 'CLIENT_SECRET_BASIC',
      },
    },
  };
}

function mapOauth2Response(
  resp: CreateOauth2CredentialProviderCommandOutput | UpdateOauth2CredentialProviderCommandOutput,
): CredentialProviderResult {
  if (!resp.credentialProviderArn) {
    throw new CredentialProviderError(
      'AgentCore Identity returned no credentialProviderArn',
      'SDK_SHAPE_MISMATCH',
      resp,
    );
  }
  const internalSecretArn = (resp as CreateOauth2CredentialProviderCommandOutput).clientSecretArn
    ?.secretArn;
  return {
    credentialProviderArn: resp.credentialProviderArn,
    callbackUrl: (resp as CreateOauth2CredentialProviderCommandOutput).callbackUrl,
    internalSecretArn,
    rawResponse: resp,
  };
}

function mapApiKeyResponse(
  resp: CreateApiKeyCredentialProviderCommandOutput | UpdateApiKeyCredentialProviderCommandOutput,
): CredentialProviderResult {
  if (!resp.credentialProviderArn) {
    throw new CredentialProviderError(
      'AgentCore Identity returned no credentialProviderArn',
      'SDK_SHAPE_MISMATCH',
      resp,
    );
  }
  return {
    credentialProviderArn: resp.credentialProviderArn,
    internalSecretArn: resp.apiKeySecretArn?.secretArn,
    rawResponse: resp,
  };
}

/**
 * Map any non-CredentialProviderError, non-throttling SDK error to a typed
 * CredentialProviderError. Throttling is already handled by withThrottlingRetry.
 */
function mapSdkError(err: unknown, opName: string): CredentialProviderError {
  if (err instanceof CredentialProviderError) return err;
  if (isValidation(err)) {
    return new CredentialProviderError(
      `AgentCore Identity validation failed during ${opName}: ${(err as Error).message}`,
      'VALIDATION',
      err,
    );
  }
  if (isConflict(err)) {
    return new CredentialProviderError(
      `AgentCore Identity conflict during ${opName}: ${(err as Error).message}`,
      'CONFLICT',
      err,
    );
  }
  if (isNotFound(err)) {
    return new CredentialProviderError(
      `AgentCore Identity resource not found during ${opName}: ${(err as Error).message}`,
      'NOT_FOUND',
      err,
    );
  }
  return new CredentialProviderError(
    `AgentCore Identity SDK error during ${opName}: ${
      err instanceof Error ? err.message : String(err)
    }`,
    'INTERNAL',
    err,
  );
}

// ────────────────────────────────────────────────────────────────────────
// Public API: OAuth2
// ────────────────────────────────────────────────────────────────────────

/**
 * Idempotently create or update an OAuth2 credential provider.
 *
 * Behaviour:
 *  1. Try CreateOauth2CredentialProvider.
 *  2. On ConflictException, fall through to UpdateOauth2CredentialProvider.
 *  3. On UpdateOauth2 ResourceNotFoundException (race: deleted between
 *     Create-ConflictException and Update), retry Create once.
 *  4. ThrottlingException at any stage → exponential back-off + jitter,
 *     up to 4 retries (5 total attempts).
 */
export async function createOrUpsertOauth2Provider(
  input: CreateOauth2ProviderInput,
  client?: BedrockAgentCoreControlClient,
): Promise<CredentialProviderResult> {
  validateOauth2Input(input);
  const sdkInput = buildOauth2RequestInput(input);
  // Update accepts the same shape as Create.
  const updateInput: UpdateOauth2CredentialProviderCommandInput = sdkInput;
  const c = getClient(client);
  const opName = 'createOrUpsertOauth2Provider';

  try {
    return await withThrottlingRetry(async () => {
      try {
        const resp = await c.send(new CreateOauth2CredentialProviderCommand(sdkInput));
        logger.info('oauth2 credential provider created', {
          integrationId: input.integrationId,
          name: sdkInput.name,
        });
        return mapOauth2Response(resp);
      } catch (err) {
        if (!isConflict(err)) throw err;

        logger.info('oauth2 credential provider exists — updating', {
          integrationId: input.integrationId,
          name: sdkInput.name,
        });
        try {
          const resp = await c.send(new UpdateOauth2CredentialProviderCommand(updateInput));
          return mapOauth2Response(resp);
        } catch (updateErr) {
          if (!isNotFound(updateErr)) throw updateErr;
          // Race: provider was deleted between our create-conflict and update.
          logger.warn('oauth2 update raced with delete — retrying create', {
            integrationId: input.integrationId,
            name: sdkInput.name,
          });
          const retry = await c.send(new CreateOauth2CredentialProviderCommand(sdkInput));
          return mapOauth2Response(retry);
        }
      }
    }, opName);
  } catch (err) {
    if (err instanceof CredentialProviderError) throw err;
    throw mapSdkError(err, opName);
  }
}

export async function deleteOauth2Provider(
  integrationId: string,
  client?: BedrockAgentCoreControlClient,
): Promise<void> {
  if (!integrationId) {
    throw new CredentialProviderError('integrationId is required', 'VALIDATION');
  }
  const name = oauth2ProviderName(integrationId);
  const c = getClient(client);
  const opName = 'deleteOauth2Provider';

  try {
    await withThrottlingRetry(async () => {
      try {
        await c.send(new DeleteOauth2CredentialProviderCommand({ name }));
        logger.info('oauth2 credential provider deleted', { integrationId, name });
      } catch (err) {
        if (isNotFound(err)) {
          logger.info('oauth2 credential provider already absent — idempotent delete', {
            integrationId,
            name,
          });
          return;
        }
        throw err;
      }
    }, opName);
  } catch (err) {
    if (err instanceof CredentialProviderError) throw err;
    throw mapSdkError(err, opName);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Public API: API_KEY
// ────────────────────────────────────────────────────────────────────────

export async function createOrUpsertApiKeyProvider(
  input: CreateApiKeyProviderInput,
  client?: BedrockAgentCoreControlClient,
): Promise<CredentialProviderResult> {
  if (!input.integrationId) {
    throw new CredentialProviderError('integrationId is required', 'VALIDATION');
  }
  if (!input.apiKey) {
    throw new CredentialProviderError('apiKey is required', 'VALIDATION');
  }

  const name = apiKeyProviderName(input.integrationId);
  const c = getClient(client);
  const opName = 'createOrUpsertApiKeyProvider';

  try {
    return await withThrottlingRetry(async () => {
      try {
        const resp = await c.send(
          new CreateApiKeyCredentialProviderCommand({ name, apiKey: input.apiKey }),
        );
        logger.info('api_key credential provider created', {
          integrationId: input.integrationId,
          name,
        });
        return mapApiKeyResponse(resp);
      } catch (err) {
        if (!isConflict(err)) throw err;
        logger.info('api_key credential provider exists — updating', {
          integrationId: input.integrationId,
          name,
        });
        try {
          const resp = await c.send(
            new UpdateApiKeyCredentialProviderCommand({ name, apiKey: input.apiKey }),
          );
          return mapApiKeyResponse(resp);
        } catch (updateErr) {
          if (!isNotFound(updateErr)) throw updateErr;
          logger.warn('api_key update raced with delete — retrying create', {
            integrationId: input.integrationId,
            name,
          });
          const retry = await c.send(
            new CreateApiKeyCredentialProviderCommand({ name, apiKey: input.apiKey }),
          );
          return mapApiKeyResponse(retry);
        }
      }
    }, opName);
  } catch (err) {
    if (err instanceof CredentialProviderError) throw err;
    throw mapSdkError(err, opName);
  }
}

export async function deleteApiKeyProvider(
  integrationId: string,
  client?: BedrockAgentCoreControlClient,
): Promise<void> {
  if (!integrationId) {
    throw new CredentialProviderError('integrationId is required', 'VALIDATION');
  }
  const name = apiKeyProviderName(integrationId);
  const c = getClient(client);
  const opName = 'deleteApiKeyProvider';

  try {
    await withThrottlingRetry(async () => {
      try {
        await c.send(new DeleteApiKeyCredentialProviderCommand({ name }));
        logger.info('api_key credential provider deleted', { integrationId, name });
      } catch (err) {
        if (isNotFound(err)) {
          logger.info('api_key credential provider already absent — idempotent delete', {
            integrationId,
            name,
          });
          return;
        }
        throw err;
      }
    }, opName);
  } catch (err) {
    if (err instanceof CredentialProviderError) throw err;
    throw mapSdkError(err, opName);
  }
}
