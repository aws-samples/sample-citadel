/**
 * Gateway Target Manager
 *
 * Manages AgentCore Gateway targets for Lambda, Smithy, and MCP Server integrations.
 *
 * P3.A refactor (2026-05-27):
 *   - Removed the legacy synchronous `createTarget` orchestrator. Target
 *     creation now lives in `gateway-registration-handler.ts`, dispatched
 *     via the EventBridge `integration.connect.requested` event emitted by
 *     `integration-resolver.ts`. The two Phase-2 paths (CONFLUENCE async
 *     via the handler, AGENTCORE_TYPES sync inside the resolver) have
 *     converged onto a single async-via-EventBridge flow.
 *   - `deleteTarget` is now an internal helper used only by
 *     `deleteTargetAndProvider`. The handler emits its own
 *     `DeleteGatewayTargetCommand` to manage idempotency + DDB updates in
 *     the same code path.
 *
 * P2.B legacy (still in force):
 *   - `provisionCredentialProvider` adapts over the real
 *     `credential-provider-manager` (Phase 1).
 *   - Target payload builders (`buildLambdaTargetPayload`,
 *     `buildSmithyTargetPayload`, `buildMCPServerTargetPayload`) consume a
 *     pre-provisioned `credentialProviderArn`.
 *   - The `OAUTH_DEFAULT_RETURN_URL` env var is read by
 *     `provisionCredentialProvider`. Phase 3 will populate it from SSM.
 *   - Lambda/Smithy continue to use `GATEWAY_IAM_ROLE`; no credential
 *     provider provisioning is performed for those connector types.
 */

import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommandInput,
  DeleteGatewayTargetCommand,
  GetGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { McpServerOauth2Config } from './connector-registry';
import {
  createOrUpsertApiKeyProvider,
  createOrUpsertOauth2Provider,
  deleteApiKeyProvider,
  deleteOauth2Provider,
  type CredentialProviderResult,
  type ResolvedOauth2Endpoints,
} from './credential-provider-manager';
import { discoverOAuthEndpoints } from './oauth-metadata';

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

export interface GatewayTargetConfig {
  gatewayId: string;
  targetType: 'lambda' | 'smithyModel' | 'mcpServer';
  targetPayload: any;
  credentials?: any;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

/**
 * Input for the target payload builders.
 *
 * For MCP_SERVER:
 *   - `credentialProviderArn` and `credentialProviderType` are required when
 *     the auth method is API_KEY or OAUTH2.
 *   - `oauthSettings` is required for OAUTH2 (carries the values that go on
 *     the gateway-target-level `oauthCredentialProvider`, NOT on the
 *     credential-provider entity itself).
 *
 * For AWS_LAMBDA / AWS_SMITHY:
 *   - The credential fields are ignored; these connectors always use
 *     `GATEWAY_IAM_ROLE` and need no credential provisioning.
 */
export interface BuildTargetPayloadInput {
  integrationId: string;
  config: any;
  /** Required for MCP_SERVER (API_KEY or OAUTH2). Ignored by Lambda/Smithy. */
  credentialProviderArn?: string;
  /** Required for MCP_SERVER. Ignored by Lambda/Smithy. */
  credentialProviderType?: 'API_KEY' | 'OAUTH2';
  /** Required for MCP_SERVER + OAUTH2. */
  oauthSettings?: {
    scopes: string[];
    grantType: 'CLIENT_CREDENTIALS' | 'AUTHORIZATION_CODE' | 'TOKEN_EXCHANGE';
    defaultReturnUrl?: string;
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tool schema validation (unchanged from pre-P2.B)
// ────────────────────────────────────────────────────────────────────────

/**
 * Validate tool schema structure.
 */
export function validateToolSchema(schema: any): void {
  if (!schema.name || typeof schema.name !== 'string') {
    throw new Error('Tool schema must include "name" field');
  }

  if (!schema.description || typeof schema.description !== 'string') {
    throw new Error('Tool schema must include "description" field');
  }

  if (!schema.inputSchema || typeof schema.inputSchema !== 'object') {
    throw new Error('Tool schema must include "inputSchema" field');
  }

  if (schema.inputSchema.type !== 'object') {
    throw new Error('Tool schema inputSchema must be of type "object"');
  }
}

// ────────────────────────────────────────────────────────────────────────
// OAuth2 endpoint resolution (NEW)
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve concrete OAuth2 endpoints for the manager:
 *   - If `discoveryUrl` is set, fetch RFC 8414 metadata.
 *     - On 404 (`null` return), fall back to explicit `tokenUrl` /
 *       `authorizationUrl`.
 *     - On any other error, propagate (e.g. PKCE_S256_REQUIRED).
 *   - Else use explicit `tokenUrl` / `authorizationUrl` directly.
 *
 * Throws when neither path produces a valid `tokenEndpoint`, or when the
 * AUTHORIZATION_CODE grant lacks an `authorizationEndpoint`.
 *
 * @internal — exported only for unit testing.
 */
export async function resolveOauth2Endpoints(
  config: McpServerOauth2Config,
): Promise<ResolvedOauth2Endpoints> {
  const requirePKCE = config.grantType === 'AUTHORIZATION_CODE';

  let resolved: ResolvedOauth2Endpoints | null = null;

  if (config.discoveryUrl) {
    const metadata = await discoverOAuthEndpoints(config.discoveryUrl, {
      requireAuthorizationCodePKCE: requirePKCE,
    });

    if (metadata) {
      resolved = {
        tokenEndpoint: metadata.tokenEndpoint,
        authorizationEndpoint: metadata.authorizationEndpoint,
        issuer: metadata.issuer,
      };
    }
    // metadata === null → 404 path: fall through to explicit URL fallback below.
  }

  if (!resolved) {
    if (!config.tokenUrl) {
      throw new Error(
        'Cannot resolve OAuth endpoints: discovery returned no metadata and no explicit tokenUrl was provided',
      );
    }
    resolved = {
      tokenEndpoint: config.tokenUrl,
    };
    if (config.authorizationUrl) {
      resolved.authorizationEndpoint = config.authorizationUrl;
    }
  }

  if (requirePKCE && !resolved.authorizationEndpoint) {
    throw new Error(
      'Cannot resolve OAuth endpoints: AUTHORIZATION_CODE grant requires an authorizationEndpoint (set authorizationUrl or use a discoveryUrl that exposes one)',
    );
  }

  return resolved;
}

// ────────────────────────────────────────────────────────────────────────
// Credential provisioning adapter (NEW)
// ────────────────────────────────────────────────────────────────────────

/**
 * Create or upsert the AgentCore Identity credential provider for an
 * integration. Returns the real ARN (and OAuth2 callbackUrl) — this replaces
 * the pre-P2.B stub that returned fabricated ARNs.
 *
 * @param integrationId  The integration record id (DDB partition key suffix).
 * @param type           'API_KEY' | 'OAUTH2'.
 * @param credentials    For API_KEY: `{apiKey}`. For OAUTH2: a fully-validated
 *                       `McpServerOauth2Config` (or compatible shape).
 *
 * Reads `OAUTH_DEFAULT_RETURN_URL` from the environment for OAUTH2 flows; if
 * unset, the field is omitted (Phase 3 will populate this via SSM).
 */
export async function provisionCredentialProvider(
  integrationId: string,
  type: 'API_KEY' | 'OAUTH2',
  credentials: any,
): Promise<CredentialProviderResult> {
  if (type === 'API_KEY') {
    if (!credentials || typeof credentials.apiKey !== 'string' || credentials.apiKey.length === 0) {
      throw new Error('provisionCredentialProvider(API_KEY): credentials.apiKey is required');
    }
    return createOrUpsertApiKeyProvider({
      integrationId,
      apiKey: credentials.apiKey,
    });
  }

  // OAUTH2
  const oauthCfg = credentials as McpServerOauth2Config;
  const endpoints = await resolveOauth2Endpoints(oauthCfg);

  const defaultReturnUrl = process.env.OAUTH_DEFAULT_RETURN_URL;

  return createOrUpsertOauth2Provider({
    integrationId,
    clientId: oauthCfg.clientId,
    clientSecret: oauthCfg.clientSecret,
    endpoints,
    scopes: Array.isArray(oauthCfg.scopes) ? [...oauthCfg.scopes] : [],
    grantType: oauthCfg.grantType,
    clientAuthenticationMethod: oauthCfg.clientAuthenticationMethod,
    ...(defaultReturnUrl ? { defaultReturnUrl } : {}),
  });
}

/**
 * Delete the AgentCore Identity credential provider for an integration. Both
 * underlying delete operations are idempotent on `ResourceNotFoundException`,
 * so this helper can safely be called even if the provider is already gone.
 *
 * Caller decides ordering — for full integration teardown, use
 * `deleteTargetAndProvider` which deletes the gateway target FIRST so the
 * provider is never orphaned in front of a working target.
 */
export async function deprovisionCredentialProvider(
  integrationId: string,
  type: 'API_KEY' | 'OAUTH2',
): Promise<void> {
  if (type === 'OAUTH2') {
    await deleteOauth2Provider(integrationId);
    return;
  }
  await deleteApiKeyProvider(integrationId);
}

// ────────────────────────────────────────────────────────────────────────
// Target payload builders (refactored signatures)
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a Lambda gateway-target payload. Lambda always uses
 * `GATEWAY_IAM_ROLE`; the `credentialProviderArn` / `oauthSettings` fields on
 * `BuildTargetPayloadInput` are ignored.
 */
export function buildLambdaTargetPayload(
  input: BuildTargetPayloadInput,
): CreateGatewayTargetCommandInput {
  const config = input.config ?? {};
  const toolSchema = JSON.parse(config.toolSchema);
  validateToolSchema(toolSchema);

  return {
    gatewayIdentifier: getRequiredGatewayId(),
    name: targetName(input.integrationId),
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn: config.lambdaArn,
          toolSchema: {
            inlinePayload: [toolSchema],
          },
        },
      },
    } as any,
    credentialProviderConfigurations: [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' as const },
    ],
  };
}

/**
 * Build a Smithy gateway-target payload. Smithy always uses
 * `GATEWAY_IAM_ROLE`.
 */
export function buildSmithyTargetPayload(
  input: BuildTargetPayloadInput,
): CreateGatewayTargetCommandInput {
  const config = input.config ?? {};
  return {
    gatewayIdentifier: getRequiredGatewayId(),
    name: targetName(input.integrationId),
    targetConfiguration: {
      mcp: {
        smithyModel: {
          serviceType: config.serviceType,
        },
      },
    } as any,
    credentialProviderConfigurations: [
      { credentialProviderType: 'GATEWAY_IAM_ROLE' as const },
    ],
  };
}

/**
 * Build an MCP_SERVER gateway-target payload using a pre-provisioned
 * credential-provider ARN. The caller (P2.A or `createTarget`) is responsible
 * for calling `provisionCredentialProvider` first.
 *
 * For OAUTH2: scopes / grantType / defaultReturnUrl live on the gateway-target's
 * `credentialProviderConfigurations[].credentialProvider.oauthCredentialProvider`,
 * NOT on the credential-provider entity itself — see Phase 1's
 * `credential-provider-manager.ts` for why those fields are not sent to
 * AgentCore Identity.
 */
export function buildMCPServerTargetPayload(
  input: BuildTargetPayloadInput,
): CreateGatewayTargetCommandInput {
  const config = input.config ?? {};

  const targetConfiguration: any = {
    mcp: {
      mcpServer: {
        serverUrl: config.serverUrl,
      },
    },
  };

  let credentialProviderConfigurations: any[];

  if (input.credentialProviderType === 'OAUTH2') {
    if (!input.credentialProviderArn) {
      throw new Error(
        'buildMCPServerTargetPayload(OAUTH2): credentialProviderArn is required',
      );
    }
    if (!input.oauthSettings) {
      throw new Error('buildMCPServerTargetPayload(OAUTH2): oauthSettings is required');
    }
    const oauthCredentialProvider: any = {
      providerArn: input.credentialProviderArn,
      scopes: [...input.oauthSettings.scopes],
      grantType: input.oauthSettings.grantType,
    };
    if (input.oauthSettings.defaultReturnUrl) {
      oauthCredentialProvider.defaultReturnUrl = input.oauthSettings.defaultReturnUrl;
    }
    credentialProviderConfigurations = [
      {
        credentialProviderType: 'OAUTH',
        credentialProvider: { oauthCredentialProvider },
      },
    ];
  } else if (input.credentialProviderType === 'API_KEY') {
    if (!input.credentialProviderArn) {
      throw new Error(
        'buildMCPServerTargetPayload(API_KEY): credentialProviderArn is required',
      );
    }
    credentialProviderConfigurations = [
      {
        credentialProviderType: 'API_KEY',
        credentialProvider: {
          apiKeyCredentialProvider: {
            providerArn: input.credentialProviderArn,
            credentialLocation: 'HEADER',
            credentialParameterName: 'Authorization',
            credentialPrefix: 'Bearer',
          },
        },
      },
    ];
  } else {
    // CUSTOM auth method — no credential provider configurations on the target.
    credentialProviderConfigurations = [];
  }

  return {
    gatewayIdentifier: getRequiredGatewayId(),
    name: targetName(input.integrationId),
    targetConfiguration,
    credentialProviderConfigurations,
  };
}

// ────────────────────────────────────────────────────────────────────────
// High-level orchestration: deleteTargetAndProvider
// ────────────────────────────────────────────────────────────────────────

/**
 * Delete an AgentCore Gateway target by id (internal helper, target-only).
 *
 * P3.A: this is no longer exported — `gateway-registration-handler` issues
 * `DeleteGatewayTargetCommand` directly so it can manage idempotency + DDB
 * cleanup in a single async invocation. Kept here as the underlying call
 * for `deleteTargetAndProvider`.
 */
async function deleteTargetInternal(targetId: string): Promise<void> {
  const gatewayId = getRequiredGatewayId();

  const agentCoreClient = new BedrockAgentCoreControlClient({
    region: process.env.AWS_REGION,
  });

  await agentCoreClient.send(
    new DeleteGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      targetId,
    }),
  );

  console.log('Gateway target deleted:', { targetId });
}

/**
 * Delete an AgentCore Gateway target AND its associated credential provider
 * in the safe order: target first, then provider.
 *
 * Why this order:
 *   - If the target deletion fails, the provider is left intact so the target
 *     keeps working (no orphaned, useless target referring to a deleted
 *     provider).
 *   - If the provider deletion fails after the target is gone, the caller
 *     receives the error and can retry just the provider deletion (it is
 *     idempotent on RNF).
 */
export async function deleteTargetAndProvider(input: {
  targetId: string;
  integrationId: string;
  credentialProviderType: 'API_KEY' | 'OAUTH2';
}): Promise<void> {
  // 1. Delete the gateway target FIRST. If this throws, we do NOT proceed —
  //    the credential provider is still required by the live target.
  await deleteTargetInternal(input.targetId);

  // 2. Now that the target is gone, delete the credential provider.
  //    Errors here are surfaced to the caller (no silent swallow).
  await deprovisionCredentialProvider(input.integrationId, input.credentialProviderType);
}

/**
 * Get an AgentCore Gateway target by id.
 */
export async function getTarget(targetId: string): Promise<any> {
  const gatewayId = getRequiredGatewayId();

  const agentCoreClient = new BedrockAgentCoreControlClient({
    region: process.env.AWS_REGION,
  });

  const response = await agentCoreClient.send(
    new GetGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      targetId,
    }),
  );

  return response;
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

function getRequiredGatewayId(): string {
  const gatewayId = process.env.AGENTCORE_GATEWAY_ID;
  if (!gatewayId) {
    throw new Error(
      'AgentCore Gateway not configured. Please set AGENTCORE_GATEWAY_ID environment variable',
    );
  }
  return gatewayId;
}

function targetName(integrationId: string): string {
  return `integration-${integrationId}`;
}
