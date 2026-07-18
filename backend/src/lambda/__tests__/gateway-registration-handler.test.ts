/**
 * Unit tests for `gateway-registration-handler.ts` (P3.A).
 *
 * Coverage targets:
 *  - Dispatch: handleConnect routes by integrationType; handleDisconnect runs.
 *  - IdempotencyGuard: duplicate event short-circuits sub-handler.
 *  - registerConfluence (gap-9): uses the AgentCore credentialProviderArn,
 *    NOT the Secrets Manager ARN, when calling CreateGatewayTargetCommand.
 *  - registerLambda / registerSmithy: GATEWAY_IAM_ROLE payloads.
 *  - registerMcpServer: 2LO (CLIENT_CREDENTIALS) and 3LO (AUTHORIZATION_CODE)
 *    paths persist gatewayTargetId, targetStatus, and authorizationUrl.
 *  - handleDisconnect strict ordering: target → provider → secret → SSM → DDB.
 *    Failures in earlier steps abort later steps where the contract demands;
 *    legacy records (no credentialProviderArn) skip the provider step cleanly.
 *
 * Mocking conventions match `integration-resolver.test.ts`:
 *   - aws-sdk-client-mock for AWS clients.
 *   - jest.mock() for IdempotencyGuard + deprovisionCredentialProvider so we
 *     can spy on side-effects without standing up real DynamoDB / AgentCore.
 */

// ---------------------------------------------------------------------------
// Env vars MUST be set BEFORE the handler module is imported — several module-
// load-time consts (INTEGRATIONS_TABLE, GATEWAY_ID_PARAM, ENVIRONMENT, etc.)
// are captured into closures.
// ---------------------------------------------------------------------------
process.env.IDEMPOTENCY_TABLE = 'test-idempotency-table';
process.env.INTEGRATIONS_TABLE = 'test-integrations-table';
process.env.GATEWAY_ID_PARAM = '/test/gateway-id';
process.env.AGENTCORE_GATEWAY_ID = 'test-gateway-id';
process.env.AWS_REGION = 'us-east-1';
process.env.ACCOUNT_ID = '123456789012';
process.env.ENVIRONMENT = 'test';

// ---------------------------------------------------------------------------
// Mock IdempotencyGuard so we can drive duplicate-event short-circuits from
// individual tests without a real DynamoDB conditional put.
// ---------------------------------------------------------------------------
const mockWithIdempotency = jest.fn();
jest.mock('../../utils/idempotency', () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: mockWithIdempotency,
  })),
}));

// ---------------------------------------------------------------------------
// Mock deprovisionCredentialProvider so the disconnect-ordering tests can
// spy on (and fail) the provider step independently of the AgentCore Identity
// SDK. Builders (buildLambdaTargetPayload / buildSmithyTargetPayload /
// buildMCPServerTargetPayload) are intentionally NOT mocked — they are pure
// functions and we want the real CreateGatewayTargetCommand inputs they
// produce so we can assert on credentialProviderType, providerArn, etc.
// ---------------------------------------------------------------------------
const mockDeprovisionCredentialProvider = jest.fn(async () => undefined);
jest.mock('../../utils/gateway-target-manager', () => {
  const actual = jest.requireActual('../../utils/gateway-target-manager');
  return {
    ...actual,
    deprovisionCredentialProvider: (
      ...args: Parameters<typeof actual.deprovisionCredentialProvider>
    ) => mockDeprovisionCredentialProvider(...args),
  };
});

import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  SSMClient,
  GetParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  DeleteSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { EventBridgeEvent } from 'aws-lambda';

import {
  handler,
  __resetGatewayIdCacheForTesting,
} from '../gateway-registration-handler';

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------
const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockAgentCoreControlClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const REAL_PROVIDER_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key-credential-provider/integration-conf-123-api-key';
const SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:integration/conf-123';

interface ConnectDetail {
  integrationId: string;
  integrationType: string;
  orgId: string;
  secretArn?: string;
  ssmParameterPrefix?: string;
  credentialProviderArn?: string;
  credentialProviderType?: 'API_KEY' | 'OAUTH2';
  gatewayTargetId?: string;
  keepResources?: boolean;
}

function makeEvent(
  detailType:
    | 'integration.connect.requested'
    | 'integration.disconnect.requested'
    | 'unrelated.detail-type',
  detail: ConnectDetail,
): EventBridgeEvent<string, ConnectDetail> {
  return {
    version: '0',
    id: `evt-${detail.integrationId}`,
    'detail-type': detailType,
    source: 'citadel.backend',
    account: '123456789012',
    time: '2026-05-28T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail,
  };
}

/**
 * Structural view of the CreateGatewayTarget input fields these tests assert
 * on. The SDK models `targetConfiguration` / `credentialProvider` as tagged
 * unions whose members are awkward to narrow in assertions; this interface
 * types exactly the paths the tests read (unknown+narrowing convention).
 */
interface CreateTargetInput {
  name?: string;
  targetConfiguration: {
    mcp: {
      openApiSchema?: unknown;
      lambda?: { lambdaArn?: string; toolSchema?: { inlinePayload: unknown[] } };
      smithyModel?: { serviceType?: string };
      mcpServer?: { serverUrl?: string };
    };
  };
  credentialProviderConfigurations: Array<{
    credentialProviderType: string;
    credentialProvider?: {
      apiKeyCredentialProvider?: {
        providerArn: string;
        credentialLocation?: string;
        credentialParameterName?: string;
        credentialPrefix?: string;
      };
      oauthCredentialProvider?: {
        providerArn: string;
        grantType?: string;
        scopes?: string[];
      };
    };
  }>;
}

function integrationItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    PK: 'ORG#org-1',
    SK: `INTEGRATION#${overrides.integrationType ?? 'CONFLUENCE'}#${overrides.integrationId ?? 'conf-123'}`,
    integrationId: 'conf-123',
    integrationType: 'CONFLUENCE',
    orgId: 'org-1',
    status: 'CONFIGURED',
    config: {
      baseUrl: 'https://example.atlassian.net',
    },
    secretArn: SECRET_ARN,
    ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-123',
    credentialProviderArn: REAL_PROVIDER_ARN,
    credentialProviderType: 'API_KEY',
    gatewayTargetId: undefined,
    metadata: {
      version: '1.0',
      protocol: 'REST',
      provider: 'Atlassian',
      authMethod: 'API_KEY',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  ddbMock.reset();
  bedrockMock.reset();
  ssmMock.reset();
  secretsMock.reset();
  mockWithIdempotency.mockReset();
  mockDeprovisionCredentialProvider.mockReset();
  __resetGatewayIdCacheForTesting();

  // Default: idempotency guard runs the inner fn and reports executed.
  mockWithIdempotency.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
    await fn();
    return { executed: true };
  });
  // Default: provider deprovision succeeds.
  mockDeprovisionCredentialProvider.mockResolvedValue(undefined);

  // Default: SSM `GetParameterCommand` returns the gateway id (used by
  // `getGatewayId()` for CONFLUENCE / disconnect). DeleteParameter returns OK.
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Name: '/test/gateway-id', Value: 'test-gateway-id' },
  });
  ssmMock.on(DeleteParameterCommand).resolves({});

  // Default: PutCommand (would be the IdempotencyGuard write — but it's
  // mocked, so this is just a safety net for any other unexpected put).
  ddbMock.on(PutCommand).resolves({});

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// 1. Dispatch — handler routes by detail-type and integrationType
// ===========================================================================
describe('gateway-registration-handler — connect dispatch', () => {
  test('routes CONFLUENCE → registerConfluence (CreateGatewayTargetCommand for confluence target)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [integrationItem()] });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-conf-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'conf-123',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        secretArn: SECRET_ARN,
        credentialProviderArn: REAL_PROVIDER_ARN,
        credentialProviderType: 'API_KEY',
      }),
    );

    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input as unknown as CreateTargetInput;
    expect(input.name).toBe('confluence-conf-123');
    // Confluence path uses the openApiSchema target shape, not lambda/smithy/mcpServer.
    expect(input.targetConfiguration.mcp.openApiSchema).toBeDefined();
  });

  test('routes AWS_LAMBDA → registerLambda (lambda target shape with GATEWAY_IAM_ROLE)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'lam-1',
          integrationType: 'AWS_LAMBDA',
          config: {
            lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:Fn',
            toolSchema: JSON.stringify({
              name: 't',
              description: 'd',
              inputSchema: { type: 'object', properties: {} },
            }),
            region: 'us-east-1',
          },
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-lam-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'lam-1',
        integrationType: 'AWS_LAMBDA',
        orgId: 'org-1',
      }),
    );

    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input as unknown as CreateTargetInput;
    expect(input.targetConfiguration.mcp.lambda).toBeDefined();
    expect(input.credentialProviderConfigurations[0].credentialProviderType).toBe(
      'GATEWAY_IAM_ROLE',
    );
  });

  test('routes AWS_SMITHY → registerSmithy (smithy target shape with GATEWAY_IAM_ROLE)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'sm-1',
          integrationType: 'AWS_SMITHY',
          config: { serviceType: 'dynamodb', region: 'us-east-1' },
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-sm-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'sm-1',
        integrationType: 'AWS_SMITHY',
        orgId: 'org-1',
      }),
    );

    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input as unknown as CreateTargetInput;
    expect(input.targetConfiguration.mcp.smithyModel).toBeDefined();
    expect(input.credentialProviderConfigurations[0].credentialProviderType).toBe(
      'GATEWAY_IAM_ROLE',
    );
  });

  test('routes MCP_SERVER → registerMcpServer (mcpServer target shape)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'mcp-1',
          integrationType: 'MCP_SERVER',
          config: { serverUrl: 'https://mcp.example.com' },
          credentialProviderArn:
            'arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key-credential-provider/integration-mcp-1-api-key',
          credentialProviderType: 'API_KEY',
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-mcp-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'mcp-1',
        integrationType: 'MCP_SERVER',
        orgId: 'org-1',
        credentialProviderType: 'API_KEY',
      }),
    );

    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input as unknown as CreateTargetInput;
    expect(input.targetConfiguration.mcp.mcpServer).toBeDefined();
    expect(input.targetConfiguration.mcp.mcpServer.serverUrl).toBe('https://mcp.example.com');
  });

  test('unknown integrationType → logs warn, no throw, no Bedrock call', async () => {
    const warnSpy = jest.spyOn(console, 'warn');
    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'unk-1',
        integrationType: 'UNKNOWN_TYPE',
        orgId: 'org-1',
      }),
    );
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand).length).toBe(0);
    const warned = warnSpy.mock.calls.some((c) =>
      String(c[0] ?? '').includes('not implemented for UNKNOWN_TYPE'),
    );
    expect(warned).toBe(true);
  });

  test('IdempotencyGuard: duplicate event → sub-handler not invoked', async () => {
    // Override the default guard impl to simulate "already processed".
    mockWithIdempotency.mockImplementationOnce(async () => ({ executed: false }));

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'dup-1',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
      }),
    );

    // None of the sub-handler side effects should have been triggered.
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand).length).toBe(0);
  });
});

// ===========================================================================
// 2. registerConfluence (gap-9 verification — CRITICAL)
// ===========================================================================
describe('gateway-registration-handler — registerConfluence (gap-9)', () => {
  test('uses credentialProviderArn from integration record (NOT detail.secretArn) as providerArn', async () => {
    // Detail intentionally has secretArn but NO credentialProviderArn — the
    // handler must fall back to the integration record's persisted ARN.
    ddbMock.on(QueryCommand).resolves({
      Items: [integrationItem({ credentialProviderArn: REAL_PROVIDER_ARN })],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-conf-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'conf-123',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        secretArn: SECRET_ARN, // present but must NOT be used as providerArn
      }),
    );

    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls.length).toBe(1);
    const input = calls[0].args[0].input as unknown as CreateTargetInput;
    const providerArn =
      input.credentialProviderConfigurations[0].credentialProvider.apiKeyCredentialProvider
        .providerArn;
    expect(providerArn).toBe(REAL_PROVIDER_ARN);
    expect(providerArn).not.toBe(SECRET_ARN);
    expect(providerArn.startsWith('arn:aws:bedrock-agentcore:')).toBe(true);
    expect(providerArn).not.toMatch(/^arn:aws:secretsmanager:/);
  });

  test('passes the bedrock:credential-provider/... ARN as apiKeyCredentialProvider.providerArn (header/Basic shape)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [integrationItem()] });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-conf-2' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'conf-123',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        // detail-level credentialProviderArn takes precedence over the record.
        credentialProviderArn: REAL_PROVIDER_ARN,
      }),
    );

    const input = bedrockMock.commandCalls(CreateGatewayTargetCommand)[0].args[0].input as unknown as CreateTargetInput;
    const apiKey =
      input.credentialProviderConfigurations[0].credentialProvider.apiKeyCredentialProvider;
    expect(apiKey.providerArn).toBe(REAL_PROVIDER_ARN);
    expect(apiKey.credentialLocation).toBe('HEADER');
    expect(apiKey.credentialParameterName).toBe('Authorization');
    expect(apiKey.credentialPrefix).toBe('Basic');
  });

  test('on success: updates integration record with gatewayTargetId + status CONNECTED', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [integrationItem()] });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-conf-3' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'conf-123',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        credentialProviderArn: REAL_PROVIDER_ARN,
      }),
    );

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates.length).toBe(1);
    const updateInput = updates[0].args[0].input;
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('CONNECTED');
    expect(updateInput.ExpressionAttributeValues![':gatewayTargetId']).toBe('tgt-conf-3');
    expect(updateInput.ExpressionAttributeValues![':agentCoreRegistered']).toBe(true);
  });

  test('on ConflictException: idempotent, falls back to existing gatewayTargetId', async () => {
    // Two QueryCommand calls happen in this path: one for the initial
    // getIntegration, one inside the catch block. Both return the record
    // with the existing gatewayTargetId so the handler can reconcile.
    const recordWithExistingTarget = integrationItem({
      gatewayTargetId: 'tgt-conf-existing',
    });
    ddbMock.on(QueryCommand).resolves({ Items: [recordWithExistingTarget] });
    ddbMock.on(UpdateCommand).resolves({});

    const conflict = new Error('Target already exists');
    conflict.name = 'ConflictException';
    bedrockMock.on(CreateGatewayTargetCommand).rejects(conflict);

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'conf-123',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        credentialProviderArn: REAL_PROVIDER_ARN,
      }),
    );

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates.length).toBe(1);
    const updateInput = updates[0].args[0].input;
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('CONNECTED');
    expect(updateInput.ExpressionAttributeValues![':gatewayTargetId']).toBe(
      'tgt-conf-existing',
    );
  });

  test('missing credentialProviderArn: writes CONNECTION_FAILED + throws', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [integrationItem({ credentialProviderArn: undefined })],
    });
    ddbMock.on(UpdateCommand).resolves({});

    await expect(
      handler(
        makeEvent('integration.connect.requested', {
          integrationId: 'conf-123',
          integrationType: 'CONFLUENCE',
          orgId: 'org-1',
        }),
      ),
    ).rejects.toThrow(/credentialProviderArn/);

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates.length).toBe(1);
    expect(updates[0].args[0].input.ExpressionAttributeValues![':status']).toBe(
      'CONNECTION_FAILED',
    );
    // Bedrock must not be called when the precondition fails.
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand).length).toBe(0);
  });
});

// ===========================================================================
// 3. registerLambda / registerSmithy — GATEWAY_IAM_ROLE payloads
// ===========================================================================
describe('gateway-registration-handler — registerLambda / registerSmithy', () => {
  test('Lambda: builds payload with GATEWAY_IAM_ROLE + lambda inlinePayload', async () => {
    const tool = {
      name: 'tool',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
    };
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'lam-1',
          integrationType: 'AWS_LAMBDA',
          config: {
            lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:Fn',
            toolSchema: JSON.stringify(tool),
            region: 'us-east-1',
          },
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-lam-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'lam-1',
        integrationType: 'AWS_LAMBDA',
        orgId: 'org-1',
      }),
    );

    const input = bedrockMock.commandCalls(CreateGatewayTargetCommand)[0].args[0]
      .input as unknown as CreateTargetInput;
    expect(input.targetConfiguration.mcp.lambda.lambdaArn).toBe(
      'arn:aws:lambda:us-east-1:123456789012:function:Fn',
    );
    expect(input.targetConfiguration.mcp.lambda.toolSchema.inlinePayload[0]).toEqual(tool);
    expect(input.credentialProviderConfigurations).toEqual([
      { credentialProviderType: 'GATEWAY_IAM_ROLE' },
    ]);
  });

  test('Lambda: updates integration record with gatewayTargetId on success', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'lam-2',
          integrationType: 'AWS_LAMBDA',
          config: {
            lambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:Fn',
            toolSchema: JSON.stringify({
              name: 't',
              description: 'd',
              inputSchema: { type: 'object', properties: {} },
            }),
            region: 'us-east-1',
          },
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-lam-2' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'lam-2',
        integrationType: 'AWS_LAMBDA',
        orgId: 'org-1',
      }),
    );

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues![':gatewayTargetId']).toBe('tgt-lam-2');
    expect(update.ExpressionAttributeValues![':status']).toBe('CONNECTED');
    expect(update.ExpressionAttributeValues![':targetStatus']).toBe('READY');
  });

  test('Smithy: builds payload with GATEWAY_IAM_ROLE + smithyModel.serviceType', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'sm-1',
          integrationType: 'AWS_SMITHY',
          config: { serviceType: 'dynamodb', region: 'us-east-1' },
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-sm-1' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'sm-1',
        integrationType: 'AWS_SMITHY',
        orgId: 'org-1',
      }),
    );

    const input = bedrockMock.commandCalls(CreateGatewayTargetCommand)[0].args[0]
      .input as unknown as CreateTargetInput;
    expect(input.targetConfiguration.mcp.smithyModel.serviceType).toBe('dynamodb');
    expect(input.credentialProviderConfigurations[0].credentialProviderType).toBe(
      'GATEWAY_IAM_ROLE',
    );
  });
});

// ===========================================================================
// 4. registerMcpServer — 2LO and 3LO paths
// ===========================================================================
describe('gateway-registration-handler — registerMcpServer (2LO and 3LO)', () => {
  test('2LO (CLIENT_CREDENTIALS): target created → status READY, integration updated', async () => {
    const oauthArn =
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:oauth2-credential-provider/integration-mcp-2lo-oauth';
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'mcp-2lo',
          integrationType: 'MCP_SERVER',
          config: { serverUrl: 'https://mcp.example.com' },
          secretArn: SECRET_ARN,
          credentialProviderArn: oauthArn,
          credentialProviderType: 'OAUTH2',
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({
        grantType: 'CLIENT_CREDENTIALS',
        scopes: ['read:tools'],
        clientId: 'cid',
        clientSecret: 'csec',
      }),
    });
    // 2LO returns no special status / no authorizationUrl.
    bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-mcp-2lo' });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'mcp-2lo',
        integrationType: 'MCP_SERVER',
        orgId: 'org-1',
        credentialProviderArn: oauthArn,
        credentialProviderType: 'OAUTH2',
      }),
    );

    const input = bedrockMock.commandCalls(CreateGatewayTargetCommand)[0].args[0]
      .input as unknown as CreateTargetInput;
    const oauthCp =
      input.credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider;
    expect(oauthCp.providerArn).toBe(oauthArn);
    expect(oauthCp.grantType).toBe('CLIENT_CREDENTIALS');
    expect(oauthCp.scopes).toEqual(['read:tools']);

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues![':gatewayTargetId']).toBe('tgt-mcp-2lo');
    expect(update.ExpressionAttributeValues![':status']).toBe('CONNECTED');
    expect(update.ExpressionAttributeValues![':targetStatus']).toBe('READY');
    expect(update.ExpressionAttributeValues![':authorizationUrl']).toBeUndefined();
  });

  test('3LO (AUTHORIZATION_CODE): CREATE_PENDING_AUTH → persists authorizationUrl + CONNECTING', async () => {
    const oauthArn =
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:oauth2-credential-provider/integration-mcp-3lo-oauth';
    const idpAuthUrl = 'https://idp.example.com/oauth/authorize?state=abc';
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'mcp-3lo',
          integrationType: 'MCP_SERVER',
          config: { serverUrl: 'https://mcp.example.com' },
          secretArn: SECRET_ARN,
          credentialProviderArn: oauthArn,
          credentialProviderType: 'OAUTH2',
        }),
      ],
    });
    ddbMock.on(UpdateCommand).resolves({});
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({
        grantType: 'AUTHORIZATION_CODE',
        scopes: ['read:tools'],
        clientId: 'cid',
        clientSecret: 'csec',
      }),
    });
    bedrockMock.on(CreateGatewayTargetCommand).resolves({
      targetId: 'tgt-mcp-3lo',
      status: 'CREATE_PENDING_AUTH',
      authorizationData: { oauth2: { authorizationUrl: idpAuthUrl } },
    });

    await handler(
      makeEvent('integration.connect.requested', {
        integrationId: 'mcp-3lo',
        integrationType: 'MCP_SERVER',
        orgId: 'org-1',
        credentialProviderArn: oauthArn,
        credentialProviderType: 'OAUTH2',
      }),
    );

    const input = bedrockMock.commandCalls(CreateGatewayTargetCommand)[0].args[0]
      .input as unknown as CreateTargetInput;
    expect(
      input.credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider
        .grantType,
    ).toBe('AUTHORIZATION_CODE');

    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues![':status']).toBe('CONNECTING');
    expect(update.ExpressionAttributeValues![':agentCoreRegistered']).toBe(false);
    expect(update.ExpressionAttributeValues![':gatewayTargetId']).toBe('tgt-mcp-3lo');
    expect(update.ExpressionAttributeValues![':targetStatus']).toBe('CREATE_PENDING_AUTH');
    expect(update.ExpressionAttributeValues![':authorizationUrl']).toBe(idpAuthUrl);
  });
});

// ===========================================================================
// 5. handleDisconnect — strict ordering safety
// ===========================================================================
describe('gateway-registration-handler — handleDisconnect ordering', () => {
  function setupOrderTracking() {
    const callOrder: string[] = [];
    bedrockMock.on(DeleteGatewayTargetCommand).callsFake(() => {
      callOrder.push('target');
      return {};
    });
    mockDeprovisionCredentialProvider.mockImplementation(async () => {
      callOrder.push('provider');
    });
    secretsMock.on(DeleteSecretCommand).callsFake(() => {
      callOrder.push('secret');
      return {};
    });
    ssmMock.on(DeleteParameterCommand).callsFake(() => {
      callOrder.push('ssm');
      return {};
    });
    ddbMock.on(DeleteCommand).callsFake(() => {
      callOrder.push('ddb');
      return {};
    });
    return callOrder;
  }

  test('happy path: target → provider → secret → SSM → DDB (relative order preserved)', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-del',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-del-1',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del',
        }),
      ],
    });
    const callOrder = setupOrderTracking();

    await handler(
      makeEvent('integration.disconnect.requested', {
        integrationId: 'conf-del',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        gatewayTargetId: 'tgt-del-1',
        credentialProviderArn: REAL_PROVIDER_ARN,
        credentialProviderType: 'API_KEY',
        secretArn: SECRET_ARN,
        ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del',
      }),
    );

    // All five steps fired.
    for (const step of ['target', 'provider', 'secret', 'ssm', 'ddb']) {
      expect(callOrder).toContain(step);
    }
    // Relative ordering target < provider < secret < ssm < ddb.
    expect(callOrder.indexOf('target')).toBeLessThan(callOrder.indexOf('provider'));
    expect(callOrder.indexOf('provider')).toBeLessThan(callOrder.indexOf('secret'));
    expect(callOrder.indexOf('secret')).toBeLessThan(callOrder.indexOf('ssm'));
    expect(callOrder.lastIndexOf('ssm')).toBeLessThan(callOrder.indexOf('ddb'));
  });

  test('target delete fails (non-RNF) → provider/secret/SSM/DDB NOT touched, error propagates', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-del-fail',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-fail',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-fail',
        }),
      ],
    });
    const callOrder = setupOrderTracking();
    // Override target to reject with a non-RNF error.
    const validationErr = new Error('Validation failed');
    validationErr.name = 'ValidationException';
    bedrockMock.on(DeleteGatewayTargetCommand).rejects(validationErr);

    await expect(
      handler(
        makeEvent('integration.disconnect.requested', {
          integrationId: 'conf-del-fail',
          integrationType: 'CONFLUENCE',
          orgId: 'org-1',
          gatewayTargetId: 'tgt-fail',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-fail',
        }),
      ),
    ).rejects.toThrow(/Validation failed/);

    // Subsequent steps must NOT have been attempted.
    expect(callOrder).not.toContain('provider');
    expect(callOrder).not.toContain('secret');
    expect(callOrder).not.toContain('ssm');
    expect(callOrder).not.toContain('ddb');
    expect(mockDeprovisionCredentialProvider).not.toHaveBeenCalled();
  });

  test('target RNF (ResourceNotFoundException) → silent success, continues to provider', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-del-rnf',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-rnf',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-rnf',
        }),
      ],
    });
    const callOrder = setupOrderTracking();
    const rnf = new Error('Target not found');
    rnf.name = 'ResourceNotFoundException';
    bedrockMock.on(DeleteGatewayTargetCommand).rejects(rnf);

    await handler(
      makeEvent('integration.disconnect.requested', {
        integrationId: 'conf-del-rnf',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        gatewayTargetId: 'tgt-rnf',
        credentialProviderArn: REAL_PROVIDER_ARN,
        credentialProviderType: 'API_KEY',
        secretArn: SECRET_ARN,
        ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-rnf',
      }),
    );

    // No 'target' entry (rejected before our fake's push), but provider+downstream fired.
    expect(callOrder).toContain('provider');
    expect(callOrder).toContain('secret');
    expect(callOrder).toContain('ddb');
    expect(mockDeprovisionCredentialProvider).toHaveBeenCalledTimes(1);
  });

  test('provider delete fails (non-RNF) → does NOT abort; secret/SSM/DDB still run; metric emitted', async () => {
    // Note: this codifies the ACTUAL handler behaviour. The block comment on
    // `handleDisconnect` reads:
    //   "If step 2 fails, the error is logged and a metric is emitted; ops
    //    can retry the delete by re-emitting the event."
    // i.e. provider failure is intentionally non-fatal so the user is not
    // left with a half-deleted record. Test reflects what the code does.
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-del-prov-fail',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-pfail',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-prov-fail',
        }),
      ],
    });
    const callOrder = setupOrderTracking();
    mockDeprovisionCredentialProvider.mockImplementation(async () => {
      // Note: we don't push 'provider' here because we want failure-path tracking.
      throw new Error('AgentCore Identity unavailable');
    });
    const logSpy = jest.spyOn(console, 'log');

    await handler(
      makeEvent('integration.disconnect.requested', {
        integrationId: 'conf-del-prov-fail',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        gatewayTargetId: 'tgt-pfail',
        credentialProviderArn: REAL_PROVIDER_ARN,
        credentialProviderType: 'API_KEY',
        secretArn: SECRET_ARN,
        ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-prov-fail',
      }),
    );

    // Target ran, provider rejected, but secret/SSM/DDB STILL ran.
    expect(callOrder).toContain('target');
    expect(callOrder).toContain('secret');
    expect(callOrder).toContain('ssm');
    expect(callOrder).toContain('ddb');

    // Metric emitted via console.log JSON line.
    const metricEmitted = logSpy.mock.calls.some((call) => {
      const arg = call[0];
      if (typeof arg !== 'string') return false;
      try {
        const parsed = JSON.parse(arg);
        return parsed.metric === 'integration.disconnect.provider_delete_failed';
      } catch {
        return false;
      }
    });
    expect(metricEmitted).toBe(true);
  });

  test('legacy integration (no credentialProviderArn) → skips provider step cleanly', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-del-legacy',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-legacy',
          credentialProviderArn: undefined, // legacy: pre-P2.A record
          credentialProviderType: undefined,
          secretArn: SECRET_ARN,
          ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-legacy',
        }),
      ],
    });
    const callOrder = setupOrderTracking();

    await handler(
      makeEvent('integration.disconnect.requested', {
        integrationId: 'conf-del-legacy',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        gatewayTargetId: 'tgt-legacy',
        secretArn: SECRET_ARN,
        ssmParameterPrefix: '/citadel/integrations/org-1/confluence-conf-del-legacy',
      }),
    );

    // Target ran, secret/SSM/DDB ran, but provider step was SKIPPED.
    expect(callOrder).toContain('target');
    expect(callOrder).toContain('secret');
    expect(callOrder).toContain('ddb');
    expect(callOrder).not.toContain('provider');
    expect(mockDeprovisionCredentialProvider).not.toHaveBeenCalled();
  });

  test('keepResources=true: only target deleted, provider/secret/SSM/DDB skipped', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        integrationItem({
          integrationId: 'conf-keep',
          integrationType: 'CONFLUENCE',
          gatewayTargetId: 'tgt-keep',
          credentialProviderArn: REAL_PROVIDER_ARN,
          credentialProviderType: 'API_KEY',
          secretArn: SECRET_ARN,
        }),
      ],
    });
    const callOrder = setupOrderTracking();

    await handler(
      makeEvent('integration.disconnect.requested', {
        integrationId: 'conf-keep',
        integrationType: 'CONFLUENCE',
        orgId: 'org-1',
        gatewayTargetId: 'tgt-keep',
        credentialProviderArn: REAL_PROVIDER_ARN,
        credentialProviderType: 'API_KEY',
        secretArn: SECRET_ARN,
        keepResources: true,
      }),
    );

    expect(callOrder).toContain('target');
    expect(callOrder).not.toContain('provider');
    expect(callOrder).not.toContain('secret');
    expect(callOrder).not.toContain('ssm');
    expect(callOrder).not.toContain('ddb');
    expect(mockDeprovisionCredentialProvider).not.toHaveBeenCalled();
  });
});
