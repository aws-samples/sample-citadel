/**
 * Acceptance test for invoke-side auth-secret resolution in the import-dispatch
 * path of agent-message-handler.
 *
 * When an imported agent's invocation block carries a secret-backed auth mode
 * (OAUTH2 | API_KEY | COGNITO) + secretRef, the handler resolves the secret via
 * the credential-manager-backed resolver (Secrets Manager GetSecretValue, run
 * under THIS handler Lambda's identity) and the adapter applies the request
 * Authorization header. The raw secret value is NEVER logged. SIGV4 / NONE
 * resolve no secret.
 *
 * Mirrors the mock scaffold of agent-message-handler-import-dispatch.test.ts
 * and additionally mocks @aws-sdk/client-secrets-manager (used by
 * credential-manager.getAgentInvocationSecret).
 */

// ── Idempotency: run the wrapped callback so the inner handler logic executes.
jest.mock('../../utils/idempotency', () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: jest.fn(async (_key: string, fn: () => Promise<void>) => {
      await fn();
      return { executed: true };
    }),
  })),
}));

// ── SSM (legacy getAgentConfig + credential-manager module-load client) ─────
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __cmd: 'GetParameter', input })),
  PutParameterCommand: jest.fn((input: unknown) => ({ __cmd: 'PutParameter', input })),
  DeleteParameterCommand: jest.fn((input: unknown) => ({ __cmd: 'DeleteParameter', input })),
}));

// ── DynamoDB doc client (storeAgentResponse) ────────────────────────────────
const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __cmd: 'Put', input })),
}));

// ── SigV4 + Sha256 + credentials (AppSync trigger) ──────────────────────────
const mockSign = jest.fn(async (req: unknown) => req);
jest.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: jest.fn(() => ({ sign: mockSign })),
}));
jest.mock('@aws-crypto/sha256-js', () => ({ Sha256: jest.fn() }));
jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: jest.fn(() => async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK' })),
}));

// ── AgentCore runtime (legacy invoke) ───────────────────────────────────────
const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  InvokeAgentRuntimeCommand: jest.fn((input: unknown) => ({ __cmd: 'InvokeAgentRuntime', input })),
}));

// ── Secrets Manager: the new invoke-side resolution (credential-manager) ────
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ __cmd: 'GetSecretValue', input })),
  CreateSecretCommand: jest.fn((input: unknown) => ({ __cmd: 'CreateSecret', input })),
  UpdateSecretCommand: jest.fn((input: unknown) => ({ __cmd: 'UpdateSecret', input })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ __cmd: 'DeleteSecret', input })),
}));

// ── RegistryService (invocation-block lookup) ───────────────────────────────
const mockGetResource = jest.fn();
jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    deserializeCustomMetadata: (json: string | null | undefined, defaults: unknown) => ({
      ...(defaults as Record<string, unknown>),
      ...(json ? JSON.parse(json) : {}),
    }),
  })),
}));

const SECRET_VALUE = 'tok-LIVE-handler-secret-never-logged';
const SECRET_REF =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:/citadel/agents/org-1/abc';

type Handler = typeof import('../agent-message-handler').handler;
let handler: Handler;
let resetCaches: () => void;

function makeEvent() {
  return {
    id: 'evt-1',
    detail: {
      projectId: 'proj-1',
      agentId: 'agent-1',
      message: 'hi agent',
      messageId: 'msg-1',
      userId: 'user-1',
      timestamp: '2026-06-28T00:00:00.000Z',
    },
  } as unknown as Parameters<Handler>[0];
}

function recordWithInvocation(invocation: Record<string, unknown>) {
  const meta: Record<string, unknown> = {
    manifest: {},
    categories: [],
    icon: '',
    state: 'active',
    invocation,
  };
  return {
    recordId: 'rec-1',
    name: 'agent-1',
    status: 'APPROVED',
    customDescriptorContent: JSON.stringify(meta),
  };
}

const mockFetch = () => (global as unknown as { fetch: jest.Mock }).fetch;

function getSecretValueCalls(): string[] {
  return mockSecretsSend.mock.calls
    .map((c) => c[0] as { input?: { SecretId?: string } })
    .filter((c) => typeof c.input?.SecretId === 'string')
    .map((c) => c.input!.SecretId as string);
}

beforeAll(() => {
  process.env.CONVERSATIONS_TABLE = 'conv-table';
  process.env.APPSYNC_ENDPOINT = 'https://example.appsync-api.us-east-1.amazonaws.com/graphql';
  process.env.IDEMPOTENCY_TABLE = 'idem-table';
  process.env.AWS_REGION = 'us-east-1';
  process.env.ENVIRONMENT = 'dev';
  const mod = require('../agent-message-handler');
  handler = mod.handler;
  resetCaches = mod._resetCaches;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.IMPORT_ENABLED = 'true';
  process.env.REGISTRY_ID = 'reg-1';
  resetCaches();

  // global fetch serves BOTH the HTTP adapter and the AppSync trigger.
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { publishConversationMessage: { id: 'x' } } }),
    text: async () => JSON.stringify({ output: 'http-out' }),
  }));

  mockDynamoSend.mockResolvedValue({});
  mockSecretsSend.mockResolvedValue({ SecretString: SECRET_VALUE });
});

describe('import-dispatch invoke-side auth-secret resolution', () => {
  it('resolves an OAUTH2 secretRef and sends Authorization: Bearer <value> to the imported HTTP endpoint', async () => {
    const target = 'https://imported.example.com/agent';
    mockGetResource.mockResolvedValue(
      recordWithInvocation({
        protocol: 'HTTP_ENDPOINT',
        target,
        auth: { mode: 'OAUTH2', secretRef: SECRET_REF },
        mode: 'sync',
      }),
    );

    await handler(makeEvent());

    // GetSecretValue called exactly once, with the record's secretRef, under
    // the handler Lambda's identity.
    expect(getSecretValueCalls()).toEqual([SECRET_REF]);

    // The imported-endpoint fetch carried the bearer header.
    const call = mockFetch().mock.calls.find((c: unknown[]) => c[0] === target);
    expect(call).toBeDefined();
    const headers = (call![1] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${SECRET_VALUE}`);

    // Imported path used — legacy AgentCore path not touched.
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    expect(mockSsmSend).not.toHaveBeenCalled();
    // Response still stored + published.
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it('NEVER logs the resolved secret value', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = 'https://imported.example.com/agent';
    mockGetResource.mockResolvedValue(
      recordWithInvocation({
        protocol: 'HTTP_ENDPOINT',
        target,
        auth: { mode: 'OAUTH2', secretRef: SECRET_REF },
        mode: 'sync',
      }),
    );

    await handler(makeEvent());

    const all = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .map((c) => JSON.stringify(c))
      .join('\n');
    expect(all).not.toContain(SECRET_VALUE);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SIGV4 imported endpoint resolves no secret (GetSecretValue not called)', async () => {
    const target = 'https://imported.example.com/agent';
    mockGetResource.mockResolvedValue(
      recordWithInvocation({
        protocol: 'HTTP_ENDPOINT',
        target,
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    await handler(makeEvent());

    expect(getSecretValueCalls()).toEqual([]);
  });
});
