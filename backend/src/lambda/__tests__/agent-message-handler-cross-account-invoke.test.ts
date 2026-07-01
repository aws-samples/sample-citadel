/**
 * Acceptance tests for CROSS-ACCOUNT invoke wiring in the agent-message-handler
 * import-dispatch path (Phase 2, agent-import).
 *
 * When an imported agent's invocation is cross-account (invocation.roleArn's
 * account != ACCOUNT_ID), the handler assumes the invoke role via
 * vendImportCredentials, builds the adapter registry with those assumed
 * credentials, and the AWS-native protocol invoke uses them. A failed assume
 * FAILS the invoke (no silent fall back to the handler identity). Same-account
 * (or no roleArn) is byte-identical to today (no vend, handler identity). The
 * legacy AgentCore path (no invocation block) is unchanged.
 *
 * vendImportCredentials is stubbed via a PARTIAL mock of invoke-support so the
 * real adapters (and the real toInvokeCredentials mapper) keep working; the SDK
 * clients + RegistryService are mocked. Mirrors the import-dispatch scaffold.
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

// ── SSM (legacy getAgentConfig) ─────────────────────────────────────────────
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __cmd: 'GetParameter', input })),
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

// ── Lambda (LAMBDA_INVOKE adapter) — capture the constructed client config ──
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ __cmd: 'Invoke', input })),
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

// ── invoke-support: stub ONLY vendImportCredentials (keep real helpers) ─────
const mockVend = jest.fn();
jest.mock('../../adapters/agent-source/invoke-support', () => {
  const actual = jest.requireActual('../../adapters/agent-source/invoke-support');
  return { ...actual, vendImportCredentials: mockVend };
});

const DEPLOY_ACCOUNT = '111122223333';
const FOREIGN_ACCOUNT = '999988887777';
const CROSS_ROLE = `arn:aws:iam::${FOREIGN_ACCOUNT}:role/CitadelInvoke`;
const ASSUMED_SECRET = 'assumed-secret-NEVER-LOG';

type Handler = typeof import('../agent-message-handler').handler;
let handler: Handler;
let resetCaches: () => void;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const lambdaCtor = (): jest.Mock =>
  jest.requireMock('@aws-sdk/client-lambda').LambdaClient as jest.Mock;

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

function recordWithInvocation(invocation: Record<string, unknown> | undefined) {
  const meta: Record<string, unknown> = { manifest: {}, categories: [], icon: '', state: 'active' };
  if (invocation) meta.invocation = invocation;
  return { recordId: 'rec-1', name: 'agent-1', status: 'APPROVED', customDescriptorContent: JSON.stringify(meta) };
}

const storedAgentResponse = (): string | undefined => {
  const puts = mockDynamoSend.mock.calls
    .map((c) => c[0] as { input?: { Item?: { message?: string; messageType?: string } } })
    .filter((c) => c.input?.Item?.messageType === 'AGENT_RESPONSE');
  return puts.length ? puts[puts.length - 1].input?.Item?.message : undefined;
};

beforeAll(() => {
  process.env.CONVERSATIONS_TABLE = 'conv-table';
  process.env.APPSYNC_ENDPOINT = 'https://example.appsync-api.us-east-1.amazonaws.com/graphql';
  process.env.IDEMPOTENCY_TABLE = 'idem-table';
  process.env.AWS_REGION = 'us-east-1';
  process.env.ENVIRONMENT = 'dev';
  process.env.ACCOUNT_ID = DEPLOY_ACCOUNT;
  const mod = require('../agent-message-handler');
  handler = mod.handler;
  resetCaches = mod._resetCaches;
});

afterAll(() => {
  delete process.env.ACCOUNT_ID;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.IMPORT_ENABLED = 'true';
  process.env.REGISTRY_ID = 'reg-1';
  process.env.ACCOUNT_ID = DEPLOY_ACCOUNT;
  resetCaches();

  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { publishConversationMessage: { id: 'x' } } }),
    text: async () => JSON.stringify({ output: 'http-out' }),
  }));

  mockSsmSend.mockResolvedValue({
    Parameter: { Value: JSON.stringify({ agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/legacy', region: 'us-east-1' }) },
  });
  mockAgentCoreSend.mockResolvedValue({
    contentType: 'application/json',
    response: { transformToByteArray: async () => enc(JSON.stringify({ response: 'legacy-out' })) },
  });
  mockLambdaSend.mockResolvedValue({ StatusCode: 200, Payload: enc(JSON.stringify({ output: 'lambda-out' })) });
  mockDynamoSend.mockResolvedValue({});
  mockGetResource.mockResolvedValue(null);
  mockVend.mockReset();
});

describe('cross-account imported invoke', () => {
  const crossInvocation = {
    protocol: 'LAMBDA_INVOKE',
    target: `arn:aws:lambda:us-east-1:${FOREIGN_ACCOUNT}:function:imported`,
    auth: { mode: 'NONE' },
    mode: 'sync',
    region: 'us-east-1',
    roleArn: CROSS_ROLE,
    externalId: 'ext-1',
    account: FOREIGN_ACCOUNT,
  };

  it('assumes the invoke role and the protocol invoke uses the assumed credentials', async () => {
    mockVend.mockResolvedValue({
      roleArn: CROSS_ROLE,
      accessKeyId: 'ASIA-ASSUMED',
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: 'assumed-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    mockGetResource.mockResolvedValue(recordWithInvocation(crossInvocation));

    await handler(makeEvent());

    // vendImportCredentials called once, for the cross-account invoke role.
    expect(mockVend).toHaveBeenCalledTimes(1);
    expect(mockVend.mock.calls[0][0]).toMatchObject({ roleArn: CROSS_ROLE, externalId: 'ext-1', account: FOREIGN_ACCOUNT });

    // The data-plane LambdaClient was built with the ASSUMED credentials.
    const cfg = lambdaCtor().mock.calls[0][0] as { credentials?: Record<string, unknown> };
    expect(cfg.credentials).toMatchObject({
      accessKeyId: 'ASIA-ASSUMED',
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: 'assumed-token',
    });
    // The protocol invoke happened and the legacy path did NOT run.
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();
    // Response stored + published exactly as today.
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it('NEVER logs the assumed secret', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVend.mockResolvedValue({
      roleArn: CROSS_ROLE,
      accessKeyId: 'ASIA-ASSUMED',
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: 'assumed-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    mockGetResource.mockResolvedValue(recordWithInvocation(crossInvocation));

    await handler(makeEvent());

    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => JSON.stringify(c))
      .join('\n');
    expect(all).not.toContain(ASSUMED_SECRET);
    expect(all).not.toContain('assumed-token');

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('FAILS the invoke when the assume fails — no fall back to handler identity', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVend.mockRejectedValue(new Error('AccessDenied: not authorized to perform sts:AssumeRole'));
    mockGetResource.mockResolvedValue(recordWithInvocation(crossInvocation));

    await handler(makeEvent());

    // The assume was attempted...
    expect(mockVend).toHaveBeenCalledTimes(1);
    // ...but the protocol invoke NEVER happened (no LambdaClient built/sent),
    // and we did NOT fall back to the legacy handler-identity path.
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(lambdaCtor()).not.toHaveBeenCalled();
    expect(mockSsmSend).not.toHaveBeenCalled();
    expect(mockAgentCoreSend).not.toHaveBeenCalled();

    // A clear, structured error was logged and surfaced to the frontend.
    const logged = errorSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(logged.toLowerCase()).toContain('assume');
    const stored = storedAgentResponse();
    expect(stored).toBeDefined();
    expect(stored).toContain('error');
    errorSpy.mockRestore();
  });
});

describe('same-account imported invoke (unchanged)', () => {
  it('does NOT vend and uses the handler identity (no credentials) when there is no roleArn', async () => {
    mockVend.mockResolvedValue({});
    mockGetResource.mockResolvedValue(
      recordWithInvocation({
        protocol: 'LAMBDA_INVOKE',
        target: `arn:aws:lambda:us-east-1:${DEPLOY_ACCOUNT}:function:imported`,
        auth: { mode: 'NONE' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    await handler(makeEvent());

    expect(mockVend).not.toHaveBeenCalled();
    const cfg = lambdaCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.credentials).toBeUndefined();
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT vend when a roleArn is in the SAME account as ACCOUNT_ID', async () => {
    mockVend.mockResolvedValue({});
    mockGetResource.mockResolvedValue(
      recordWithInvocation({
        protocol: 'LAMBDA_INVOKE',
        target: `arn:aws:lambda:us-east-1:${DEPLOY_ACCOUNT}:function:imported`,
        auth: { mode: 'NONE' },
        mode: 'sync',
        region: 'us-east-1',
        roleArn: `arn:aws:iam::${DEPLOY_ACCOUNT}:role/SameAccount`,
        externalId: 'ext-1',
        account: DEPLOY_ACCOUNT,
      }),
    );

    await handler(makeEvent());

    expect(mockVend).not.toHaveBeenCalled();
    const cfg = lambdaCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.credentials).toBeUndefined();
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });
});

describe('legacy AgentCore path (regression guard intact)', () => {
  it('takes the unchanged legacy path and does NOT vend when the agent has no invocation block', async () => {
    mockVend.mockResolvedValue({});
    mockGetResource.mockResolvedValue(recordWithInvocation(undefined));

    await handler(makeEvent());

    expect(mockVend).not.toHaveBeenCalled();
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });
});
