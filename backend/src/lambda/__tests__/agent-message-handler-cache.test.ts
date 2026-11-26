/**
 * Note on jest.mock hoisting:
 *
 * ``jest.mock(path, factory)`` is hoisted above all imports. The factory
 * runs at the FIRST IMPORT of the mocked module, which for SDK clients
 * happens when ``../agent-message-handler`` is imported at the top of
 * this file. That pulls ``utils/idempotency.ts``, which constructs a
 * DynamoDBClient at module scope and eagerly triggers the credential
 * chain — touching ``@aws-sdk/credential-provider-node`` before any
 * ``const ... = jest.fn()`` below this import has initialised.
 *
 * Fix: put ``jest.mock`` calls ABOVE the SUT import so they're
 * registered first, and make each factory self-contained so no outer
 * ``const`` is captured before initialisation. Access the resulting
 * mocks via ``jest.requireMock`` inside ``beforeEach``.
 */
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn((params: unknown) => params),
}));

jest.mock('@aws-sdk/credential-provider-node', () => {
  // Stable inner fn shared across every ``defaultProvider()`` call. The
  // SUT calls ``defaultProvider()`` once to get the resolver and then
  // calls that resolver per credential fetch; for caching tests we care
  // about the call count of the INNER fn, which must therefore be the
  // same object on every invocation.
  const stableInnerFn = jest.fn();
  const provider = jest.fn(() => stableInnerFn);
  // Attach the inner fn to the provider for easy retrieval in tests.
  (provider as jest.Mock & { __innerMock?: jest.Mock }).__innerMock = stableInnerFn;
  return { defaultProvider: provider };
});

import { getAgentConfig, getCredentials, _resetCaches } from '../agent-message-handler';

// See the ``jest.mock`` block at the top of this file for why mockSsmSend
// is now derived from the mocked SSMClient constructor rather than declared
// here as a separate const (that pattern TDZ-errored at the idempotency.ts
// import-time DynamoDBClient construction chain).
let mockSsmSend: jest.Mock;
// (Duplicate ``jest.mock('@aws-sdk/client-ssm', ...)`` was removed — the
// hoisted mock block at the top of this file is the single source of truth.)

// Derived from the mocked credential-provider module; reset in beforeEach.
let mockDefaultProvider: jest.Mock;
// (Duplicate ``jest.mock('@aws-sdk/credential-provider-node', ...)`` was
// removed — the hoisted mock block at the top of this file is the single
// source of truth.)

const ssmModule = jest.requireMock('@aws-sdk/client-ssm') as {
  SSMClient: jest.Mock;
};
const credentialModule = jest.requireMock('@aws-sdk/credential-provider-node') as {
  defaultProvider: jest.Mock;
};

beforeEach(() => {
  // Every SSMClient construction yields a fresh ``{send: jest.fn()}``.
  // The SUT constructs its singleton client at module load; we retrieve the
  // first instance here and use its ``send`` as the test-controlled mock.
  const firstSsmInstance = ssmModule.SSMClient.mock.results[0]?.value as
    | { send: jest.Mock }
    | undefined;
  if (firstSsmInstance) {
    mockSsmSend = firstSsmInstance.send;
    mockSsmSend.mockReset();
  } else {
    // Fallback: construct one here if the SUT has not yet (shouldn't happen
    // with current singleton pattern but defensive for refactors).
    const fresh = new ssmModule.SSMClient() as { send: jest.Mock };
    mockSsmSend = fresh.send;
  }

  // ``defaultProvider`` is itself a jest.fn that returns a jest.fn on each
  // call. Pull the first returned inner fn and reset it so test assertions
  // on call counts work per test.
  mockDefaultProvider = credentialModule.defaultProvider.mock.results[0]?.value as jest.Mock;
  // Stable-inner-fn path: the mocked defaultProvider exposes
    // ``__innerMock`` attached in the jest.mock factory above. This
    // overrides the mock.results[0] lookup because the first call may have
    // happened at import time before our reset logic ran.
    mockDefaultProvider = (
      credentialModule.defaultProvider as jest.Mock & { __innerMock: jest.Mock }
    ).__innerMock;
  mockDefaultProvider.mockReset();
  credentialModule.defaultProvider.mockClear();

  _resetCaches();
});

describe('SSM parameter caching', () => {
  const ssmResponse = {
    Parameter: { Value: JSON.stringify({ agentRuntimeArn: 'arn:aws:bedrock:us-west-2:123:agent/test' }) },
  };

  it('calls SSM on first invocation', async () => {
    mockSsmSend.mockResolvedValue(ssmResponse);
    const config = await getAgentConfig('test-agent');
    expect(config.agentRuntimeArn).toBe('arn:aws:bedrock:us-west-2:123:agent/test');
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('uses cache on second call within TTL', async () => {
    mockSsmSend.mockResolvedValue(ssmResponse);
    await getAgentConfig('test-agent');
    await getAgentConfig('test-agent');
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('refreshes cache after TTL expires', async () => {
    mockSsmSend.mockResolvedValue(ssmResponse);
    await getAgentConfig('test-agent');

    // Simulate TTL expiry by manipulating cache
    _resetCaches();

    await getAgentConfig('test-agent');
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
  });
});

describe('SigV4 credential caching', () => {
  it('resolves credentials once per invocation', async () => {
    const creds = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' };
    mockDefaultProvider.mockResolvedValue(creds);

    const c1 = await getCredentials();
    const c2 = await getCredentials();
    expect(c1).toBe(c2);
    expect(mockDefaultProvider).toHaveBeenCalledTimes(1);
  });
});
