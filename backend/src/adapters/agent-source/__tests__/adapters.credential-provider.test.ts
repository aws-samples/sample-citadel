/**
 * TDD (Phase 2, agent-import): the AWS-native adapters (AGENTCORE_RUNTIME /
 * LAMBDA_INVOKE / BEDROCK_AGENT) construct their protocol SDK client with an
 * injected cross-account `credentialProvider` when buildDefaultAgentSourceRegistry
 * is given one, and with the default credential chain (NO `credentials` key —
 * byte-identical to today's same-account behaviour) when it is omitted.
 *
 * The data-plane SDK client packages are mocked so we can assert the config the
 * adapter constructs its client with. bedrock-agent-runtime is virtual (not an
 * installed dependency — loaded lazily by the adapter).
 */
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from '../base';
import type { InvokeCredentials } from '../invoke-support';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── data-plane SDK clients (capture the constructed config) ─────────────────
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ __cmd: 'Invoke', input })),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  InvokeAgentRuntimeCommand: jest.fn((input: unknown) => ({ __cmd: 'InvokeAgentRuntime', input })),
}));

const mockBedrockRuntimeSend = jest.fn();
jest.mock(
  '@aws-sdk/client-bedrock-agent-runtime',
  () => ({
    BedrockAgentRuntimeClient: jest.fn(() => ({ send: mockBedrockRuntimeSend })),
    InvokeAgentCommand: jest.fn((input: unknown) => ({ __cmd: 'InvokeAgent', input })),
  }),
  { virtual: true },
);

import { buildDefaultAgentSourceRegistry } from '../registry-factory';

const ASSUMED: InvokeCredentials = {
  accessKeyId: 'ASIA-ASSUMED',
  secretAccessKey: 'assumed-secret-NEVER-LOG',
  sessionToken: 'assumed-token',
};

function descriptorFor(invocation: AgentInvocationBlock): AgentCapabilityDescriptor {
  return {
    name: 'agent-under-test',
    description: '',
    version: '1.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin: {
      substrate: invocation.protocol,
      discoveredAt: '2026-06-28T00:00:00.000Z',
      ownership: 'external',
    },
  };
}

const baseReq: InvokeRequest = { prompt: 'hi', sessionId: 's1', attributes: {} };

const lambdaCtor = (): jest.Mock =>
  jest.requireMock('@aws-sdk/client-lambda').LambdaClient as jest.Mock;
const agentCoreCtor = (): jest.Mock =>
  jest.requireMock('@aws-sdk/client-bedrock-agentcore').BedrockAgentCoreClient as jest.Mock;
const bedrockRuntimeCtor = (): jest.Mock =>
  jest.requireMock('@aws-sdk/client-bedrock-agent-runtime').BedrockAgentRuntimeClient as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockLambdaSend.mockResolvedValue({ Payload: enc(JSON.stringify({ output: 'lambda-out' })) });
  mockAgentCoreSend.mockResolvedValue({
    contentType: 'application/json',
    response: { transformToByteArray: async () => enc(JSON.stringify({ output: 'core-out' })) },
  });
  async function* completion(): AsyncGenerator<{ chunk: { bytes: Uint8Array } }> {
    yield { chunk: { bytes: enc('bedrock-out') } };
  }
  mockBedrockRuntimeSend.mockResolvedValue({ completion: completion() });
});

describe('LAMBDA_INVOKE credentialProvider injection (via factory)', () => {
  it('constructs LambdaClient WITH the injected credentials when a credentialProvider is set', async () => {
    const registry = buildDefaultAgentSourceRegistry({ credentialProvider: ASSUMED });
    await registry.resolve('LAMBDA_INVOKE').invoke(
      baseReq,
      descriptorFor({
        protocol: 'LAMBDA_INVOKE',
        target: 'arn:aws:lambda:us-east-1:999988887777:function:x',
        auth: { mode: 'NONE' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const cfg = lambdaCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.credentials).toEqual(ASSUMED);
    expect(cfg.region).toBe('us-east-1');
  });

  it('constructs LambdaClient with NO credentials key when no credentialProvider (back-compat)', async () => {
    const registry = buildDefaultAgentSourceRegistry();
    await registry.resolve('LAMBDA_INVOKE').invoke(
      baseReq,
      descriptorFor({
        protocol: 'LAMBDA_INVOKE',
        target: 'arn:aws:lambda:us-east-1:111122223333:function:x',
        auth: { mode: 'NONE' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    const cfg = lambdaCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg).toEqual({ region: 'us-east-1' });
    expect('credentials' in cfg).toBe(false);
  });
});

describe('AGENTCORE_RUNTIME credentialProvider injection (via factory)', () => {
  it('constructs BedrockAgentCoreClient WITH the injected credentials when set', async () => {
    const registry = buildDefaultAgentSourceRegistry({ credentialProvider: ASSUMED });
    await registry.resolve('AGENTCORE_RUNTIME').invoke(
      baseReq,
      descriptorFor({
        protocol: 'AGENTCORE_RUNTIME',
        target: 'arn:aws:bedrock-agentcore:us-east-1:999988887777:runtime/agent',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
    const cfg = agentCoreCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.credentials).toEqual(ASSUMED);
    expect(cfg.region).toBe('us-east-1');
  });

  it('constructs BedrockAgentCoreClient with NO credentials key when omitted (back-compat)', async () => {
    const registry = buildDefaultAgentSourceRegistry();
    await registry.resolve('AGENTCORE_RUNTIME').invoke(
      baseReq,
      descriptorFor({
        protocol: 'AGENTCORE_RUNTIME',
        target: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agent',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    const cfg = agentCoreCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg).toEqual({ region: 'us-east-1' });
    expect('credentials' in cfg).toBe(false);
  });
});

describe('BEDROCK_AGENT credentialProvider injection (via factory)', () => {
  it('constructs the lazily-loaded BedrockAgentRuntimeClient WITH the injected credentials when set', async () => {
    const registry = buildDefaultAgentSourceRegistry({ credentialProvider: ASSUMED });
    await registry.resolve('BEDROCK_AGENT').invoke(
      baseReq,
      descriptorFor({
        protocol: 'BEDROCK_AGENT',
        target: 'AGENT123/ALIAS1',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    expect(mockBedrockRuntimeSend).toHaveBeenCalledTimes(1);
    const cfg = bedrockRuntimeCtor().mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.credentials).toEqual(ASSUMED);
  });

  it('constructs the BedrockAgentRuntimeClient with NO credentials key when omitted (back-compat)', async () => {
    const registry = buildDefaultAgentSourceRegistry();
    await registry.resolve('BEDROCK_AGENT').invoke(
      baseReq,
      descriptorFor({
        protocol: 'BEDROCK_AGENT',
        target: 'AGENT123/ALIAS1',
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        region: 'us-east-1',
      }),
    );

    const cfg = bedrockRuntimeCtor().mock.calls[0][0] as Record<string, unknown>;
    expect('credentials' in cfg).toBe(false);
  });
});
