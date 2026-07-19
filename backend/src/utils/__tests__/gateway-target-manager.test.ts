/**
 * Unit Tests for Gateway Target Manager (P2.B refactor)
 *
 * Covers the new orchestration introduced when the stub
 * `createCredentialProvider` was replaced with the real
 * `credential-provider-manager` adapter:
 *   - provisionCredentialProvider / deprovisionCredentialProvider
 *   - resolveOauth2Endpoints (via provisionCredentialProvider OAUTH2 paths)
 *   - buildLambdaTargetPayload / buildSmithyTargetPayload / buildMCPServerTargetPayload
 *     (now consume a pre-provisioned credentialProviderArn instead of calling the stub)
 *   - createTarget / deleteTarget back-compat orchestration
 *   - deleteTargetAndProvider ordering and partial-failure semantics
 */

import {
  BedrockAgentCoreControlClient,
  DeleteGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { mockClient } from 'aws-sdk-client-mock';

// Mock the credential-provider-manager and oauth-metadata modules BEFORE importing
// gateway-target-manager so the SUT picks up the mocks.
jest.mock('../credential-provider-manager');
jest.mock('../oauth-metadata', () => {
  const actual = jest.requireActual('../oauth-metadata');
  return {
    // Keep the real OAuthMetadataError class so `new OAuthMetadataError(...)`
    // produces a real instance with `code` and `name` set correctly.
    ...actual,
    // Replace the network-side function with a jest mock.
    discoverOAuthEndpoints: jest.fn(),
  };
});

import {
  createOrUpsertApiKeyProvider,
  createOrUpsertOauth2Provider,
  deleteApiKeyProvider,
  deleteOauth2Provider,
} from '../credential-provider-manager';
import { discoverOAuthEndpoints, OAuthMetadataError } from '../oauth-metadata';

type McpTargetConfigView = {
  mcp: {
    lambda?: { lambdaArn?: string; toolSchema?: { inlinePayload?: unknown[] } };
    smithyModel?: { serviceType?: string };
    mcpServer?: { serverUrl?: string };
  };
};

type CredentialProviderView = {
  oauthCredentialProvider?: {
    providerArn?: string;
    scopes?: string[];
    grantType?: string;
    defaultReturnUrl?: string;
  };
  apiKeyCredentialProvider?: {
    providerArn?: string;
    credentialLocation?: string;
    credentialParameterName?: string;
    credentialPrefix?: string;
  };
};

import {
  deleteTargetAndProvider,
  getTarget,
  validateToolSchema,
  provisionCredentialProvider,
  deprovisionCredentialProvider,
  buildLambdaTargetPayload,
  buildMCPServerTargetPayload,
  buildSmithyTargetPayload,
} from '../gateway-target-manager';

const bedrockAgentMock = mockClient(BedrockAgentCoreControlClient);

const mockedCreateOauth2 = createOrUpsertOauth2Provider as jest.MockedFunction<
  typeof createOrUpsertOauth2Provider
>;
const mockedCreateApiKey = createOrUpsertApiKeyProvider as jest.MockedFunction<
  typeof createOrUpsertApiKeyProvider
>;
const mockedDeleteOauth2 = deleteOauth2Provider as jest.MockedFunction<
  typeof deleteOauth2Provider
>;
const mockedDeleteApiKey = deleteApiKeyProvider as jest.MockedFunction<
  typeof deleteApiKeyProvider
>;
const mockedDiscover = discoverOAuthEndpoints as jest.MockedFunction<
  typeof discoverOAuthEndpoints
>;

const FAKE_OAUTH_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-int-1-oauth';
const FAKE_APIKEY_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:111:api-key-credential-provider/integration-int-2-api-key';
const FAKE_CALLBACK_URL = 'https://agentcore.aws/oauth/callback/abc';

describe('Gateway Target Manager - Unit Tests', () => {
  beforeEach(() => {
    bedrockAgentMock.reset();
    mockedCreateOauth2.mockReset();
    mockedCreateApiKey.mockReset();
    mockedDeleteOauth2.mockReset();
    mockedDeleteApiKey.mockReset();
    mockedDiscover.mockReset();

    // Default success mocks for legacy tests that don't care about the
    // specific provider response.
    mockedCreateOauth2.mockResolvedValue({
      credentialProviderArn: FAKE_OAUTH_ARN,
      callbackUrl: FAKE_CALLBACK_URL,
      internalSecretArn: 'arn:aws:secretsmanager:...:oauth-secret',
      rawResponse: {},
    });
    mockedCreateApiKey.mockResolvedValue({
      credentialProviderArn: FAKE_APIKEY_ARN,
      internalSecretArn: 'arn:aws:secretsmanager:...:apikey-secret',
      rawResponse: {},
    });
    mockedDeleteOauth2.mockResolvedValue(undefined);
    mockedDeleteApiKey.mockResolvedValue(undefined);
    mockedDiscover.mockResolvedValue(null);

    process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
    process.env.AWS_REGION = 'us-east-1';
    process.env.ACCOUNT_ID = '123456789012';
    delete process.env.OAUTH_DEFAULT_RETURN_URL;
  });

  afterEach(() => {
    delete process.env.AGENTCORE_GATEWAY_ID;
    delete process.env.AWS_REGION;
    delete process.env.ACCOUNT_ID;
    delete process.env.OAUTH_DEFAULT_RETURN_URL;
  });

  // ──────────────────────────────────────────────────────────────────────
  // validateToolSchema (legacy, unchanged)
  // ──────────────────────────────────────────────────────────────────────
  describe('validateToolSchema', () => {
    test('accepts a valid tool schema', () => {
      const validSchema = {
        name: 'my_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: { param1: { type: 'string' } },
          required: ['param1'],
        },
      };
      expect(() => validateToolSchema(validSchema)).not.toThrow();
    });

    test('rejects schema missing name', () => {
      expect(() =>
        validateToolSchema({
          description: 'A test tool',
          inputSchema: { type: 'object' },
        }),
      ).toThrow('Tool schema must include "name" field');
    });

    test('rejects schema missing description', () => {
      expect(() =>
        validateToolSchema({ name: 'my_tool', inputSchema: { type: 'object' } }),
      ).toThrow('Tool schema must include "description" field');
    });

    test('rejects schema missing inputSchema', () => {
      expect(() => validateToolSchema({ name: 'my_tool', description: 'd' })).toThrow(
        'Tool schema must include "inputSchema" field',
      );
    });

    test('rejects schema with non-object inputSchema type', () => {
      expect(() =>
        validateToolSchema({
          name: 'my_tool',
          description: 'd',
          inputSchema: { type: 'string' },
        }),
      ).toThrow('Tool schema inputSchema must be of type "object"');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // provisionCredentialProvider (NEW)
  // ──────────────────────────────────────────────────────────────────────
  describe('provisionCredentialProvider', () => {
    test('OAUTH2 happy path with discoveryUrl resolves endpoints then creates provider', async () => {
      mockedDiscover.mockResolvedValueOnce({
        issuer: 'https://idp.example.com',
        tokenEndpoint: 'https://idp.example.com/oauth/token',
        authorizationEndpoint: 'https://idp.example.com/oauth/authorize',
        codeChallengeMethodsSupported: ['S256'],
        raw: {},
      });

      const result = await provisionCredentialProvider('int-1', 'OAUTH2', {
        authMethod: 'OAUTH2',
        clientId: 'cid',
        clientSecret: 'csec',
        grantType: 'CLIENT_CREDENTIALS',
        discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
        scopes: ['read'],
        clientAuthenticationMethod: 'CLIENT_SECRET_BASIC',
      });

      expect(mockedDiscover).toHaveBeenCalledWith(
        'https://idp.example.com/.well-known/oauth-authorization-server',
        expect.objectContaining({ requireAuthorizationCodePKCE: false }),
      );
      expect(mockedCreateOauth2).toHaveBeenCalledTimes(1);
      const sentArg = mockedCreateOauth2.mock.calls[0][0];
      expect(sentArg.integrationId).toBe('int-1');
      expect(sentArg.endpoints).toEqual(
        expect.objectContaining({
          tokenEndpoint: 'https://idp.example.com/oauth/token',
          authorizationEndpoint: 'https://idp.example.com/oauth/authorize',
          issuer: 'https://idp.example.com',
        }),
      );
      expect(sentArg.scopes).toEqual(['read']);
      expect(sentArg.grantType).toBe('CLIENT_CREDENTIALS');
      expect(sentArg.defaultReturnUrl).toBeUndefined();
      expect(result).toEqual(
        expect.objectContaining({
          credentialProviderArn: FAKE_OAUTH_ARN,
          callbackUrl: FAKE_CALLBACK_URL,
        }),
      );
    });

    test('OAUTH2 falls back to explicit URLs when discoveryUrl returns null (404)', async () => {
      mockedDiscover.mockResolvedValueOnce(null);

      const result = await provisionCredentialProvider('int-1', 'OAUTH2', {
        authMethod: 'OAUTH2',
        clientId: 'cid',
        clientSecret: 'csec',
        grantType: 'AUTHORIZATION_CODE',
        discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
        tokenUrl: 'https://idp.example.com/oauth/token',
        authorizationUrl: 'https://idp.example.com/oauth/authorize',
        scopes: ['read'],
      });

      expect(mockedDiscover).toHaveBeenCalledTimes(1);
      const sentArg = mockedCreateOauth2.mock.calls[0][0];
      expect(sentArg.endpoints.tokenEndpoint).toBe('https://idp.example.com/oauth/token');
      expect(sentArg.endpoints.authorizationEndpoint).toBe(
        'https://idp.example.com/oauth/authorize',
      );
      expect(sentArg.grantType).toBe('AUTHORIZATION_CODE');
      expect(result.credentialProviderArn).toBe(FAKE_OAUTH_ARN);
    });

    test('OAUTH2 throws when discoveryUrl returns null AND no explicit URLs are provided', async () => {
      mockedDiscover.mockResolvedValueOnce(null);

      await expect(
        provisionCredentialProvider('int-1', 'OAUTH2', {
          authMethod: 'OAUTH2',
          clientId: 'cid',
          clientSecret: 'csec',
          grantType: 'CLIENT_CREDENTIALS',
          discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
          scopes: ['read'],
        }),
      ).rejects.toThrow(/Cannot resolve OAuth endpoints/);

      expect(mockedCreateOauth2).not.toHaveBeenCalled();
    });

    test('OAUTH2 propagates OAuthMetadataError(PKCE_S256_REQUIRED) for AUTHORIZATION_CODE', async () => {
      const pkceErr = new OAuthMetadataError(
        "OAuth Authorization Code flow requires 'S256' in code_challenge_methods_supported",
        'PKCE_S256_REQUIRED',
      );
      mockedDiscover.mockRejectedValueOnce(pkceErr);

      await expect(
        provisionCredentialProvider('int-1', 'OAUTH2', {
          authMethod: 'OAUTH2',
          clientId: 'cid',
          clientSecret: 'csec',
          grantType: 'AUTHORIZATION_CODE',
          discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
          tokenUrl: 'https://idp.example.com/oauth/token',
          authorizationUrl: 'https://idp.example.com/oauth/authorize',
          scopes: ['read'],
        }),
      ).rejects.toMatchObject({
        name: 'OAuthMetadataError',
        code: 'PKCE_S256_REQUIRED',
      });

      expect(mockedDiscover).toHaveBeenCalledWith(
        'https://idp.example.com/.well-known/oauth-authorization-server',
        expect.objectContaining({ requireAuthorizationCodePKCE: true }),
      );
      expect(mockedCreateOauth2).not.toHaveBeenCalled();
    });

    test('OAUTH2 with no discoveryUrl uses explicit tokenUrl/authorizationUrl directly', async () => {
      const result = await provisionCredentialProvider('int-1', 'OAUTH2', {
        authMethod: 'OAUTH2',
        clientId: 'cid',
        clientSecret: 'csec',
        grantType: 'CLIENT_CREDENTIALS',
        tokenUrl: 'https://idp.example.com/oauth/token',
        scopes: ['read'],
      });

      expect(mockedDiscover).not.toHaveBeenCalled();
      expect(mockedCreateOauth2).toHaveBeenCalledTimes(1);
      const sent = mockedCreateOauth2.mock.calls[0][0];
      expect(sent.endpoints.tokenEndpoint).toBe('https://idp.example.com/oauth/token');
      expect(result.credentialProviderArn).toBe(FAKE_OAUTH_ARN);
    });

    test('OAUTH2 forwards OAUTH_DEFAULT_RETURN_URL when set', async () => {
      process.env.OAUTH_DEFAULT_RETURN_URL = 'https://app.example.com/callback';
      mockedDiscover.mockResolvedValueOnce(null);

      await provisionCredentialProvider('int-1', 'OAUTH2', {
        authMethod: 'OAUTH2',
        clientId: 'cid',
        clientSecret: 'csec',
        grantType: 'AUTHORIZATION_CODE',
        discoveryUrl: 'https://idp.example.com/.well-known/oauth-authorization-server',
        tokenUrl: 'https://idp.example.com/oauth/token',
        authorizationUrl: 'https://idp.example.com/oauth/authorize',
        scopes: ['read'],
      });

      expect(mockedCreateOauth2.mock.calls[0][0].defaultReturnUrl).toBe(
        'https://app.example.com/callback',
      );
    });

    test('API_KEY happy path returns ARN, no callbackUrl', async () => {
      const result = await provisionCredentialProvider('int-2', 'API_KEY', {
        authMethod: 'API_KEY',
        apiKey: 'sk_test_abc',
      });

      expect(mockedCreateApiKey).toHaveBeenCalledWith({
        integrationId: 'int-2',
        apiKey: 'sk_test_abc',
      });
      expect(result).toEqual(
        expect.objectContaining({
          credentialProviderArn: FAKE_APIKEY_ARN,
        }),
      );
      expect(result.callbackUrl).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // deprovisionCredentialProvider (NEW)
  // ──────────────────────────────────────────────────────────────────────
  describe('deprovisionCredentialProvider', () => {
    test('OAUTH2 calls deleteOauth2Provider', async () => {
      await deprovisionCredentialProvider('int-1', 'OAUTH2');
      expect(mockedDeleteOauth2).toHaveBeenCalledWith('int-1');
      expect(mockedDeleteApiKey).not.toHaveBeenCalled();
    });

    test('API_KEY calls deleteApiKeyProvider', async () => {
      await deprovisionCredentialProvider('int-2', 'API_KEY');
      expect(mockedDeleteApiKey).toHaveBeenCalledWith('int-2');
      expect(mockedDeleteOauth2).not.toHaveBeenCalled();
    });

    test('OAUTH2 idempotent: underlying delete absorbs ResourceNotFoundException', async () => {
      // The underlying credential-provider-manager.deleteOauth2Provider already
      // resolves on RNF, so deprovisionCredentialProvider just delegates.
      mockedDeleteOauth2.mockResolvedValueOnce(undefined);
      await expect(deprovisionCredentialProvider('int-1', 'OAUTH2')).resolves.toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // buildMCPServerTargetPayload (NEW signature)
  // ──────────────────────────────────────────────────────────────────────
  describe('buildMCPServerTargetPayload', () => {
    test('OAUTH2 emits OAuth credentialProviderConfigurations with scopes/grantType/defaultReturnUrl', () => {
      const cmdInput = buildMCPServerTargetPayload({
        integrationId: 'int-1',
        config: { serverUrl: 'https://mcp.example.com' },
        credentialProviderArn: FAKE_OAUTH_ARN,
        credentialProviderType: 'OAUTH2',
        oauthSettings: {
          scopes: ['read', 'write'],
          grantType: 'AUTHORIZATION_CODE',
          defaultReturnUrl: 'https://app.example.com/callback',
        },
      });

      expect(cmdInput.targetConfiguration).toEqual({
        mcp: { mcpServer: { serverUrl: 'https://mcp.example.com' } },
      });
      expect(cmdInput.credentialProviderConfigurations).toHaveLength(1);
      const cpc = cmdInput.credentialProviderConfigurations![0];
      expect(cpc.credentialProviderType).toBe('OAUTH');
      expect(cpc.credentialProvider).toBeDefined();
      const oauth = (cpc.credentialProvider as CredentialProviderView).oauthCredentialProvider!;
      expect(oauth).toBeDefined();
      expect(oauth.providerArn).toBe(FAKE_OAUTH_ARN);
      expect(oauth.scopes).toEqual(['read', 'write']);
      expect(oauth.grantType).toBe('AUTHORIZATION_CODE');
      expect(oauth.defaultReturnUrl).toBe('https://app.example.com/callback');
    });

    test('OAUTH2 omits defaultReturnUrl when not provided', () => {
      const cmdInput = buildMCPServerTargetPayload({
        integrationId: 'int-1',
        config: { serverUrl: 'https://mcp.example.com' },
        credentialProviderArn: FAKE_OAUTH_ARN,
        credentialProviderType: 'OAUTH2',
        oauthSettings: { scopes: ['read'], grantType: 'CLIENT_CREDENTIALS' },
      });
      const oauth = (
        cmdInput.credentialProviderConfigurations![0].credentialProvider as CredentialProviderView
      ).oauthCredentialProvider!;
      expect(oauth.defaultReturnUrl).toBeUndefined();
    });

    test('API_KEY emits ApiKey credentialProviderConfigurations with providerArn', () => {
      const cmdInput = buildMCPServerTargetPayload({
        integrationId: 'int-2',
        config: { serverUrl: 'https://mcp.example.com' },
        credentialProviderArn: FAKE_APIKEY_ARN,
        credentialProviderType: 'API_KEY',
      });

      expect(cmdInput.credentialProviderConfigurations).toHaveLength(1);
      const cpc = cmdInput.credentialProviderConfigurations![0];
      expect(cpc.credentialProviderType).toBe('API_KEY');
      const apiKey = (cpc.credentialProvider as CredentialProviderView).apiKeyCredentialProvider!;
      expect(apiKey.providerArn).toBe(FAKE_APIKEY_ARN);
      expect(apiKey.credentialLocation).toBe('HEADER');
      expect(apiKey.credentialParameterName).toBe('Authorization');
      expect(apiKey.credentialPrefix).toBe('Bearer');
    });

    test('OAUTH2 throws when oauthSettings is missing', () => {
      expect(() =>
        buildMCPServerTargetPayload({
          integrationId: 'int-1',
          config: { serverUrl: 'https://mcp.example.com' },
          credentialProviderArn: FAKE_OAUTH_ARN,
          credentialProviderType: 'OAUTH2',
        }),
      ).toThrow(/oauthSettings/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // buildLambdaTargetPayload / buildSmithyTargetPayload (NEW signature)
  // ──────────────────────────────────────────────────────────────────────
  describe('buildLambdaTargetPayload', () => {
    test('emits Lambda mcp.lambda payload with GATEWAY_IAM_ROLE credentials', () => {
      const cmdInput = buildLambdaTargetPayload({
        integrationId: 'int-3',
        config: {
          lambdaArn: 'arn:aws:lambda:us-east-1:111:function:Foo',
          toolSchema: JSON.stringify({
            name: 'my_tool',
            description: 'A test tool',
            inputSchema: { type: 'object' },
          }),
          region: 'us-east-1',
        },
      });

      expect((cmdInput.targetConfiguration as McpTargetConfigView).mcp.lambda!.lambdaArn).toBe(
        'arn:aws:lambda:us-east-1:111:function:Foo',
      );
      expect(
        (cmdInput.targetConfiguration as McpTargetConfigView).mcp.lambda!.toolSchema!.inlinePayload,
      ).toHaveLength(1);
      expect(cmdInput.credentialProviderConfigurations).toEqual([
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ]);
    });

    test('throws on invalid tool schema JSON', () => {
      expect(() =>
        buildLambdaTargetPayload({
          integrationId: 'int-3',
          config: {
            lambdaArn: 'arn:aws:lambda:us-east-1:111:function:Foo',
            toolSchema: 'not-json',
          },
        }),
      ).toThrow();
    });
  });

  describe('buildSmithyTargetPayload', () => {
    test('emits smithyModel mcp payload with GATEWAY_IAM_ROLE credentials', () => {
      const cmdInput = buildSmithyTargetPayload({
        integrationId: 'int-4',
        config: { serviceType: 'dynamodb', region: 'us-east-1' },
      });

      expect((cmdInput.targetConfiguration as McpTargetConfigView).mcp.smithyModel!.serviceType).toBe('dynamodb');
      expect(cmdInput.credentialProviderConfigurations).toEqual([
        { credentialProviderType: 'GATEWAY_IAM_ROLE' },
      ]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // P3.A: legacy `createTarget` orchestration was removed from
  // gateway-target-manager (target creation is now async via
  // gateway-registration-handler + EventBridge). The describe block that
  // tested it has been deleted; the new public surface is exercised by:
  //   - provisionCredentialProvider (above)
  //   - buildLambdaTargetPayload / buildSmithyTargetPayload /
  //     buildMCPServerTargetPayload (above)
  //   - deleteTargetAndProvider (below)
  // The end-to-end orchestration is tested in
  // gateway-registration-handler.test.ts.
  // ──────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────
  // P3.A: legacy `deleteTarget` standalone export was removed. The
  // remaining target-deletion surface is `deleteTargetAndProvider`
  // (covered below). Direct gateway-target deletion (without provider
  // teardown) is now done inline by gateway-registration-handler.
  // ──────────────────────────────────────────────────────────────────────



  // ──────────────────────────────────────────────────────────────────────
  // deleteTargetAndProvider (NEW: target-then-provider with safety)
  // ──────────────────────────────────────────────────────────────────────
  describe('deleteTargetAndProvider', () => {
    test('deletes target FIRST, then provider (OAUTH2)', async () => {
      const order: string[] = [];
      bedrockAgentMock.on(DeleteGatewayTargetCommand).callsFake(() => {
        order.push('DeleteGatewayTarget');
        return {};
      });
      mockedDeleteOauth2.mockImplementationOnce(async () => {
        order.push('deleteOauth2Provider');
      });

      await deleteTargetAndProvider({
        targetId: 'target-123',
        integrationId: 'int-1',
        credentialProviderType: 'OAUTH2',
      });

      expect(order).toEqual(['DeleteGatewayTarget', 'deleteOauth2Provider']);
    });

    test('deletes target FIRST, then provider (API_KEY)', async () => {
      const order: string[] = [];
      bedrockAgentMock.on(DeleteGatewayTargetCommand).callsFake(() => {
        order.push('DeleteGatewayTarget');
        return {};
      });
      mockedDeleteApiKey.mockImplementationOnce(async () => {
        order.push('deleteApiKeyProvider');
      });

      await deleteTargetAndProvider({
        targetId: 'target-456',
        integrationId: 'int-2',
        credentialProviderType: 'API_KEY',
      });

      expect(order).toEqual(['DeleteGatewayTarget', 'deleteApiKeyProvider']);
    });

    test('does NOT delete provider if target deletion fails', async () => {
      bedrockAgentMock.on(DeleteGatewayTargetCommand).rejects(new Error('target delete failed'));

      await expect(
        deleteTargetAndProvider({
          targetId: 'target-123',
          integrationId: 'int-1',
          credentialProviderType: 'OAUTH2',
        }),
      ).rejects.toThrow('target delete failed');

      expect(mockedDeleteOauth2).not.toHaveBeenCalled();
      expect(mockedDeleteApiKey).not.toHaveBeenCalled();
    });

    test('surfaces provider deletion error after successful target delete', async () => {
      bedrockAgentMock.on(DeleteGatewayTargetCommand).resolves({});
      mockedDeleteOauth2.mockRejectedValueOnce(new Error('provider delete failed'));

      await expect(
        deleteTargetAndProvider({
          targetId: 'target-123',
          integrationId: 'int-1',
          credentialProviderType: 'OAUTH2',
        }),
      ).rejects.toThrow('provider delete failed');

      // Target was still deleted (idempotent if caller retries).
      expect(bedrockAgentMock.commandCalls(DeleteGatewayTargetCommand)).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // getTarget (legacy, unchanged)
  // ──────────────────────────────────────────────────────────────────────
  describe('getTarget', () => {
    test('retrieves a gateway target', async () => {
      bedrockAgentMock.resolves({ targetId: 'target-123', name: 'integration-int' });
      const result = await getTarget('target-123');
      expect(result).toEqual(expect.objectContaining({ targetId: 'target-123' }));
    });

    test('throws when gateway ID not configured', async () => {
      delete process.env.AGENTCORE_GATEWAY_ID;
      await expect(getTarget('target-123')).rejects.toThrow('AgentCore Gateway not configured');
    });

    test('propagates SDK errors', async () => {
      bedrockAgentMock.rejects(new Error('Target not found'));
      await expect(getTarget('target-123')).rejects.toThrow('Target not found');
    });
  });
});
