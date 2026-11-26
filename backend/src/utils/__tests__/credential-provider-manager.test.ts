/**
 * Unit tests for credential-provider-manager.
 *
 * Covers:
 *  - OAuth2 create-or-upsert (idempotent on ConflictException)
 *  - OAuth2 race handling (Conflict → Update RNF → Re-Create)
 *  - API_KEY create-or-upsert
 *  - Retry-with-jitter on ThrottlingException (max 4 retries → 5 total attempts)
 *  - Idempotent delete (ResourceNotFoundException = success)
 *  - Input validation (AUTHORIZATION_CODE without authorizationEndpoint)
 *  - SDK request shape (vendor, authorizationServerMetadata, clientAuthenticationMethod)
 */
import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  UpdateOauth2CredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  CreateApiKeyCredentialProviderCommand,
  UpdateApiKeyCredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import {
  createOrUpsertOauth2Provider,
  createOrUpsertApiKeyProvider,
  deleteOauth2Provider,
  deleteApiKeyProvider,
  CredentialProviderError,
  __setSleepForTesting,
  __resetClientForTesting,
} from '../credential-provider-manager';

const bedrockMock = mockClient(BedrockAgentCoreControlClient);

// Helper to build a named SDK error (the SDK detects exceptions by `.name`).
function sdkError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const baseOauthInput = {
  integrationId: 'int-123',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  endpoints: {
    tokenEndpoint: 'https://idp.example.com/oauth/token',
    authorizationEndpoint: 'https://idp.example.com/oauth/authorize',
    issuer: 'https://idp.example.com',
  },
  scopes: ['read', 'write'],
  grantType: 'CLIENT_CREDENTIALS' as const,
};

const baseApiKeyInput = {
  integrationId: 'int-456',
  apiKey: 'sk_live_xxx',
};

describe('credential-provider-manager', () => {
  beforeEach(() => {
    bedrockMock.reset();
    __resetClientForTesting();
    // Replace sleep with a no-op so retry tests don't actually wait.
    __setSleepForTesting(async () => undefined);
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
  });

  // ──────────────────────────────────────────────────────────────────────
  // OAuth2 create / upsert
  // ──────────────────────────────────────────────────────────────────────
  describe('createOrUpsertOauth2Provider', () => {
    test('happy path Create → returns ARN + callbackUrl', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        name: 'integration-int-123-oauth',
        credentialProviderArn:
          'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-int-123-oauth',
        callbackUrl: 'https://agentcore.aws/oauth/callback/abc',
        clientSecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:agentcore/oauth/abc' },
      });

      const result = await createOrUpsertOauth2Provider(baseOauthInput);

      expect(result.credentialProviderArn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/integration-int-123-oauth',
      );
      expect(result.callbackUrl).toBe('https://agentcore.aws/oauth/callback/abc');
      expect(result.internalSecretArn).toBe(
        'arn:aws:secretsmanager:us-east-1:111:secret:agentcore/oauth/abc',
      );
      expect(result.rawResponse).toBeDefined();
    });

    test('ConflictException → falls through to Update → returns ARN', async () => {
      bedrockMock
        .on(CreateOauth2CredentialProviderCommand)
        .rejectsOnce(sdkError('ConflictException', 'already exists'));
      bedrockMock.on(UpdateOauth2CredentialProviderCommand).resolves({
        name: 'integration-int-123-oauth',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/x',
        callbackUrl: 'https://agentcore.aws/oauth/callback/xyz',
        clientSecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:s' },
      });

      const result = await createOrUpsertOauth2Provider(baseOauthInput);

      expect(result.credentialProviderArn).toContain(
        'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/x',
      );
      expect(bedrockMock.commandCalls(UpdateOauth2CredentialProviderCommand)).toHaveLength(1);
    });

    test('Conflict then Update RNF (race) → retries Create once → succeeds', async () => {
      bedrockMock
        .on(CreateOauth2CredentialProviderCommand)
        .rejectsOnce(sdkError('ConflictException'))
        .resolves({
          name: 'integration-int-123-oauth',
          credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/y',
          clientSecretArn: { secretArn: 'arn:s' },
        });
      bedrockMock
        .on(UpdateOauth2CredentialProviderCommand)
        .rejectsOnce(sdkError('ResourceNotFoundException'));

      const result = await createOrUpsertOauth2Provider(baseOauthInput);

      expect(result.credentialProviderArn).toContain('oauth2-credential-provider/y');
      expect(bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)).toHaveLength(2);
      expect(bedrockMock.commandCalls(UpdateOauth2CredentialProviderCommand)).toHaveLength(1);
    });

    test('ThrottlingException once then success → retries with jitter → returns ARN', async () => {
      bedrockMock
        .on(CreateOauth2CredentialProviderCommand)
        .rejectsOnce(sdkError('ThrottlingException'))
        .resolves({
          name: 'integration-int-123-oauth',
          credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111:oauth2-credential-provider/z',
          clientSecretArn: { secretArn: 'arn:s' },
        });

      const result = await createOrUpsertOauth2Provider(baseOauthInput);

      expect(result.credentialProviderArn).toContain('z');
      expect(bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)).toHaveLength(2);
    });

    test('ThrottlingException 5x → throws CredentialProviderError(THROTTLED)', async () => {
      bedrockMock
        .on(CreateOauth2CredentialProviderCommand)
        .rejectsOnce(sdkError('ThrottlingException'))
        .rejectsOnce(sdkError('ThrottlingException'))
        .rejectsOnce(sdkError('ThrottlingException'))
        .rejectsOnce(sdkError('ThrottlingException'))
        .rejectsOnce(sdkError('ThrottlingException'))
        .resolves({ credentialProviderArn: 'should-not-reach' });

      await expect(createOrUpsertOauth2Provider(baseOauthInput)).rejects.toMatchObject({
        name: 'CredentialProviderError',
        code: 'THROTTLED',
      });
      // 1 initial + 4 retries = 5 calls before THROTTLED is thrown.
      expect(bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)).toHaveLength(5);
    });

    test('sends vendor=CustomOauth2 and provider name=integration-${id}-oauth', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:x',
        clientSecretArn: { secretArn: 'arn:s' },
      });

      await createOrUpsertOauth2Provider(baseOauthInput);

      const sent = bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)[0]?.args[0]?.input;
      expect(sent).toBeDefined();
      expect(sent!.credentialProviderVendor).toBe('CustomOauth2');
      expect(sent!.name).toBe('integration-int-123-oauth');
    });

    test('sends oauthDiscovery.authorizationServerMetadata with issuer/tokenEndpoint/authorizationEndpoint', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:x',
        clientSecretArn: { secretArn: 'arn:s' },
      });

      await createOrUpsertOauth2Provider(baseOauthInput);

      const sent = bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)[0]?.args[0]?.input;
      const meta =
        sent?.oauth2ProviderConfigInput?.customOauth2ProviderConfig?.oauthDiscovery
          ?.authorizationServerMetadata;
      expect(meta).toBeDefined();
      expect(meta!.issuer).toBe('https://idp.example.com');
      expect(meta!.tokenEndpoint).toBe('https://idp.example.com/oauth/token');
      expect(meta!.authorizationEndpoint).toBe('https://idp.example.com/oauth/authorize');
      // Make sure the discoveryUrl arm of the union is NOT used.
      expect(
        sent?.oauth2ProviderConfigInput?.customOauth2ProviderConfig?.oauthDiscovery?.discoveryUrl,
      ).toBeUndefined();
    });

    test('default clientAuthenticationMethod is CLIENT_SECRET_BASIC when omitted', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:x',
        clientSecretArn: { secretArn: 'arn:s' },
      });

      await createOrUpsertOauth2Provider(baseOauthInput);

      const sent = bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)[0]?.args[0]?.input;
      expect(
        sent?.oauth2ProviderConfigInput?.customOauth2ProviderConfig?.clientAuthenticationMethod,
      ).toBe('CLIENT_SECRET_BASIC');
    });

    test('explicit clientAuthenticationMethod=CLIENT_SECRET_POST is preserved', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:x',
        clientSecretArn: { secretArn: 'arn:s' },
      });

      await createOrUpsertOauth2Provider({
        ...baseOauthInput,
        clientAuthenticationMethod: 'CLIENT_SECRET_POST',
      });

      const sent = bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)[0]?.args[0]?.input;
      expect(
        sent?.oauth2ProviderConfigInput?.customOauth2ProviderConfig?.clientAuthenticationMethod,
      ).toBe('CLIENT_SECRET_POST');
    });

    test('AUTHORIZATION_CODE grantType + missing authorizationEndpoint → throws VALIDATION', async () => {
      const bad = {
        ...baseOauthInput,
        grantType: 'AUTHORIZATION_CODE' as const,
        endpoints: { tokenEndpoint: 'https://idp.example.com/oauth/token' },
      };

      await expect(createOrUpsertOauth2Provider(bad)).rejects.toMatchObject({
        name: 'CredentialProviderError',
        code: 'VALIDATION',
      });
      expect(bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)).toHaveLength(0);
    });

    test('defaultReturnUrl is accepted on input and does not cause validation failure', async () => {
      bedrockMock.on(CreateOauth2CredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:x',
        clientSecretArn: { secretArn: 'arn:s' },
      });

      await expect(
        createOrUpsertOauth2Provider({
          ...baseOauthInput,
          grantType: 'AUTHORIZATION_CODE',
          defaultReturnUrl: 'https://app.example.com/callback',
        }),
      ).resolves.toBeDefined();
      expect(bedrockMock.commandCalls(CreateOauth2CredentialProviderCommand)).toHaveLength(1);
    });

    test('non-throttling, non-conflict SDK error maps to INTERNAL', async () => {
      bedrockMock
        .on(CreateOauth2CredentialProviderCommand)
        .rejects(sdkError('AccessDeniedException', 'denied'));

      await expect(createOrUpsertOauth2Provider(baseOauthInput)).rejects.toMatchObject({
        name: 'CredentialProviderError',
        code: 'INTERNAL',
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // API_KEY create / upsert
  // ──────────────────────────────────────────────────────────────────────
  describe('createOrUpsertApiKeyProvider', () => {
    test('happy path Create → returns ARN, name=integration-${id}-api-key', async () => {
      bedrockMock.on(CreateApiKeyCredentialProviderCommand).resolves({
        name: 'integration-int-456-api-key',
        credentialProviderArn:
          'arn:aws:bedrock-agentcore:us-east-1:111:api-key-credential-provider/integration-int-456-api-key',
        apiKeySecretArn: { secretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:apikey/abc' },
      });

      const result = await createOrUpsertApiKeyProvider(baseApiKeyInput);

      expect(result.credentialProviderArn).toContain('integration-int-456-api-key');
      expect(result.internalSecretArn).toBe(
        'arn:aws:secretsmanager:us-east-1:111:secret:apikey/abc',
      );
      const sent = bedrockMock.commandCalls(CreateApiKeyCredentialProviderCommand)[0]?.args[0]?.input;
      expect(sent!.name).toBe('integration-int-456-api-key');
      expect(sent!.apiKey).toBe('sk_live_xxx');
    });

    test('ConflictException → Update → returns ARN', async () => {
      bedrockMock
        .on(CreateApiKeyCredentialProviderCommand)
        .rejectsOnce(sdkError('ConflictException'));
      bedrockMock.on(UpdateApiKeyCredentialProviderCommand).resolves({
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111:api-key/x',
        apiKeySecretArn: { secretArn: 'arn:s' },
      });

      const result = await createOrUpsertApiKeyProvider(baseApiKeyInput);

      expect(result.credentialProviderArn).toContain('api-key/x');
      expect(bedrockMock.commandCalls(UpdateApiKeyCredentialProviderCommand)).toHaveLength(1);
    });

    test('ThrottlingException retry → success', async () => {
      bedrockMock
        .on(CreateApiKeyCredentialProviderCommand)
        .rejectsOnce(sdkError('ThrottlingException'))
        .resolves({
          credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111:api-key/y',
          apiKeySecretArn: { secretArn: 'arn:s' },
        });

      const result = await createOrUpsertApiKeyProvider(baseApiKeyInput);

      expect(result.credentialProviderArn).toContain('api-key/y');
      expect(bedrockMock.commandCalls(CreateApiKeyCredentialProviderCommand)).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Delete
  // ──────────────────────────────────────────────────────────────────────
  describe('delete', () => {
    test('deleteOauth2Provider happy path → resolves no-op', async () => {
      bedrockMock.on(DeleteOauth2CredentialProviderCommand).resolves({});
      await expect(deleteOauth2Provider('int-123')).resolves.toBeUndefined();
      const sent = bedrockMock.commandCalls(DeleteOauth2CredentialProviderCommand)[0]?.args[0]?.input;
      expect(sent!.name).toBe('integration-int-123-oauth');
    });

    test('deleteOauth2Provider ResourceNotFoundException → resolves (idempotent)', async () => {
      bedrockMock
        .on(DeleteOauth2CredentialProviderCommand)
        .rejects(sdkError('ResourceNotFoundException'));
      await expect(deleteOauth2Provider('int-123')).resolves.toBeUndefined();
    });

    test('deleteOauth2Provider ConflictException → throws CONFLICT', async () => {
      bedrockMock
        .on(DeleteOauth2CredentialProviderCommand)
        .rejects(sdkError('ConflictException', 'still in use'));
      await expect(deleteOauth2Provider('int-123')).rejects.toMatchObject({
        name: 'CredentialProviderError',
        code: 'CONFLICT',
      });
    });

    test('deleteApiKeyProvider happy path → resolves no-op', async () => {
      bedrockMock.on(DeleteApiKeyCredentialProviderCommand).resolves({});
      await expect(deleteApiKeyProvider('int-456')).resolves.toBeUndefined();
      const sent = bedrockMock.commandCalls(DeleteApiKeyCredentialProviderCommand)[0]?.args[0]?.input;
      expect(sent!.name).toBe('integration-int-456-api-key');
    });

    test('deleteApiKeyProvider ResourceNotFoundException → resolves (idempotent)', async () => {
      bedrockMock
        .on(DeleteApiKeyCredentialProviderCommand)
        .rejects(sdkError('ResourceNotFoundException'));
      await expect(deleteApiKeyProvider('int-456')).resolves.toBeUndefined();
    });

    test('deleteApiKeyProvider throttle then success', async () => {
      bedrockMock
        .on(DeleteApiKeyCredentialProviderCommand)
        .rejectsOnce(sdkError('ThrottlingException'))
        .resolves({});
      await expect(deleteApiKeyProvider('int-456')).resolves.toBeUndefined();
      expect(bedrockMock.commandCalls(DeleteApiKeyCredentialProviderCommand)).toHaveLength(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CredentialProviderError shape
  // ──────────────────────────────────────────────────────────────────────
  describe('CredentialProviderError', () => {
    test('preserves cause chain', async () => {
      const root = sdkError('AccessDeniedException', 'no perms');
      bedrockMock.on(CreateApiKeyCredentialProviderCommand).rejects(root);
      try {
        await createOrUpsertApiKeyProvider(baseApiKeyInput);
        fail('expected to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(CredentialProviderError);
        expect((e as CredentialProviderError).code).toBe('INTERNAL');
        expect((e as CredentialProviderError).cause).toBe(root);
      }
    });
  });
});
