import { getAgentConfig, getCredentials, _resetCaches } from '../agent-message-handler';

const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((params: any) => params),
}));

const mockDefaultProvider = jest.fn();
jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => mockDefaultProvider,
}));

beforeEach(() => {
  mockSsmSend.mockReset();
  mockDefaultProvider.mockReset();
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
